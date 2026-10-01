import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getKnownData, getKnownWords, setKnownWords } from '@/core/known/store';
import { getSettings, patchSettings, saveSettings } from '@/core/settings/store';
import { decodeSyncValue, encodeSyncValue, shortHash } from '@/core/sync/codec';
import { SyncConflictError } from '@/core/sync/backend';
import { StorageSyncBackend } from '@/core/sync/backends/storage-sync';
import { WebDavBackend, type WebDavSnapshotFile } from '@/core/sync/backends/webdav';
import { exportBackup, importBackup, previewBackupImport } from '@/core/sync/backup';
import { listSyncCredentials, stampChangedCredentials } from '@/core/sync/credentials';
import { decodeKnownSegment, encodeKnownSegment } from '@/core/sync/known-codec';
import { StorageSyncService } from '@/core/sync/service';
import { SnapshotBuilder, runSyncCycle } from '@/core/sync/snapshot';
import { DEFAULT_SYNC_QUOTA, type BackendSyncStatus } from '@/core/sync/types';
import { WebDavSyncService, webdavScope } from '@/core/sync/webdav-service';
import { STORAGE_KEYS } from '@/core/storage/keys';
import { deleteLocalBook, getLocalBook, getLocalIndex, getSourceBook, patchSourceBookState, saveLocalBook, saveSourceBook } from '@/core/wordbook/user-store';
import { speak } from '@/background/tts';
import { sendToBackground } from '@/core/messaging';

/**
 * 第 3 轮评审最大差距 G1：追加需求 v4（SyncBackend 抽象、WebDAV、手动备份、凭据随同步上传开关）的 fake-browser 验收。
 * WebDAV 用内存假服务器（PROPFIND / MKCOL / GET / PUT / DELETE，ETag + If-Match / If-None-Match 语义与 Apache mod_dav 一致），
 * 真实服务器冒烟见 /tmp/gauntlet/bg3（docker 起的 Apache WebDAV）。
 */

const DAV = 'https://dav.example.com/dav/';
const PASSWORD = 'app-pass-123';

/** 内存 WebDAV 服务器 */
class FakeDav {
  files = new Map<string, { body: string; etag: string }>();
  dirs = new Set<string>(['/dav/']);
  log: { method: string; path: string; status: number; headers: Record<string, string> }[] = [];
  etagSeq = 0;
  /** 设为 false 模拟不返回 ETag 的服务器 */
  etags = true;
  /** 只返回弱 ETag（Apache 对 1 秒内修改过的文件），弱 ETag 用于 If-Match 必然 412 */
  weak = false;
  /** 是否支持 WebDAV class 2 锁（LOCK/UNLOCK），false 时 LOCK 返回 405 */
  lockSupport = true;
  /** 当前锁：path -> token（与 Apache 一致：锁定不存在的文件不创建内容，GET 仍 404） */
  locks = new Map<string, string>();
  lockSeq = 0;
  /** 覆盖 MKCOL 返回码（模拟 Apache 并发建目录时对较晚请求返回 403） */
  mkcolStatus?: number;
  /** 父目录不存在时 PUT 的状态码：Apache mod_dav（bytemark/webdav 实测）返回 403，Nextcloud/sabre 等按 RFC 返回 409 */
  putNoParentStatus = 403;
  /** 强制 PUT 返回的状态码（模拟真正无写权限） */
  forcePutStatus?: number;
  /** LOCK 依次返回的故障状态码（如 [500] 模拟偶发 500），用完后恢复正常 */
  lockFailures: number[] = [];
  /** 在处理请求前调用（模拟另一台设备在两步之间写入） */
  beforeRequest?: (method: string, path: string) => void | Promise<void>;
  /** 强制返回的状态码（认证失败、限流等） */
  forceStatus?: number;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const path = decodeURIComponent(url.pathname);
    await this.beforeRequest?.(method, path);
    const res = this.handle(method, path, headers, init?.body as string | undefined);
    this.log.push({ method, path, status: res.status, headers });
    return res;
  };

  private handle(method: string, path: string, headers: Record<string, string>, body?: string): Response {
    if (this.forceStatus) return new Response('', { status: this.forceStatus });
    if (headers.authorization !== 'Basic ' + btoa(`me@example.com:${PASSWORD}`)) return new Response('', { status: 401 });
    const parent = path.replace(/[^/]+\/?$/, '');
    const file = this.files.get(path);
    const etagHeader = (e: string): Record<string, string> => (this.etags ? { ETag: this.weak ? `W/${e}` : e } : {});
    // 被锁定的资源：写操作必须在 If 头里带上锁令牌，否则 423
    const lockToken = this.locks.get(path);
    const holdsLock = !!lockToken && (headers.if ?? '').includes(lockToken);
    switch (method) {
      case 'PROPFIND':
        return new Response('', { status: this.dirs.has(path) || file ? 207 : 404 });
      case 'MKCOL':
        if (this.mkcolStatus) return new Response('', { status: this.mkcolStatus });
        if (this.dirs.has(path)) return new Response('', { status: 405 });
        if (!this.dirs.has(parent)) return new Response('', { status: 409 });
        this.dirs.add(path);
        return new Response('', { status: 201 });
      case 'GET':
        return file ? new Response(file.body, { status: 200, headers: etagHeader(file.etag) }) : new Response('', { status: 404 });
      case 'PUT': {
        if (this.forcePutStatus) return new Response('', { status: this.forcePutStatus });
        if (!this.dirs.has(parent)) return new Response('', { status: this.putNoParentStatus });
        if (lockToken && !holdsLock) return new Response('', { status: 423 });
        if (headers['if-match'] && (!file || headers['if-match'].startsWith('W/') || file.etag !== headers['if-match'])) return new Response('', { status: 412 });
        if (headers['if-none-match'] === '*' && file) return new Response('', { status: 412 });
        const etag = `"e${++this.etagSeq}"`;
        this.files.set(path, { body: body ?? '', etag });
        return new Response(file ? null : '', { status: file ? 204 : 201, headers: etagHeader(etag) });
      }
      case 'DELETE':
        if (lockToken && !holdsLock) return new Response('', { status: 423 });
        return this.files.delete(path) ? new Response(null, { status: 204 }) : new Response('', { status: 404 });
      case 'LOCK': {
        if (!this.lockSupport) return new Response('', { status: 405 });
        if (this.lockFailures.length) return new Response('', { status: this.lockFailures.shift()! });
        // 与 Apache 一致：父目录不存在时锁定不存在的资源返回 409
        if (!this.dirs.has(parent)) return new Response('', { status: 409 });
        if (lockToken) return new Response('', { status: 423 });
        const token = `<opaquelocktoken:t${++this.lockSeq}>`;
        this.locks.set(path, token);
        return new Response('<?xml version="1.0"?><D:prop xmlns:D="DAV:"/>', { status: file ? 200 : 201, headers: { 'Lock-Token': token } });
      }
      case 'UNLOCK':
        if (!lockToken || headers['lock-token'] !== lockToken) return new Response('', { status: 400 });
        this.locks.delete(path);
        return new Response(null, { status: 204 });
      default:
        return new Response('', { status: 405 });
    }
  }

  get snapshot(): WebDavSnapshotFile {
    return JSON.parse(this.files.get('/dav/hnw/sub/hnw-sync.json')!.body) as WebDavSnapshotFile;
  }
  /** 模拟用户在网盘端删除整个同步目录（hnw/ 及其下所有内容） */
  deleteSyncDir(): void {
    for (const d of [...this.dirs]) if (d.startsWith('/dav/hnw/')) this.dirs.delete(d);
    for (const k of [...this.files.keys()]) if (k.startsWith('/dav/hnw/')) this.files.delete(k);
  }
  /** 从某条日志起的请求序列（方法 + 状态码） */
  seqFrom(n: number): string[] {
    return this.log.slice(n).map((l) => `${l.method}${l.status}`);
  }
  get rawText(): string {
    return this.files.get('/dav/hnw/sub/hnw-sync.json')?.body ?? '';
  }
}

let dav: FakeDav;
/** 测试中退避/回读等待不真实等待（可替换为受控的 Promise，用于编排两台设备的交错） */
let sleepImpl: (ms: number) => Promise<void> = async () => {};
const davService = (opts: { hasAccess?: (u: string) => Promise<boolean> } = {}) =>
  new WebDavSyncService({ fetchImpl: dav.fetch, debounceMs: 0, maxWaitMs: 0, hasAccess: opts.hasAccess ?? (async () => true), sleep: (ms) => sleepImpl(ms) });

async function enableWebDav(extra: Record<string, unknown> = {}) {
  await patchSettings({ sync: { webdav: { enabled: true, url: DAV, username: 'me@example.com', password: PASSWORD, dir: 'hnw/sub', ...extra } } });
}

/** 换一台设备：清空本机 storage.local（设置、熟词、设备 id），远端（WebDAV 假服务器 / storage.sync）保留 */
async function switchDevice() {
  await fakeBrowser.storage.local.clear();
}

/** 解码 WebDAV 文件中的熟词段 */
async function remoteKnown(file: WebDavSnapshotFile) {
  return decodeKnownSegment(await decodeSyncValue(file.segs.known!.d));
}

beforeEach(() => {
  fakeBrowser.reset();
  dav = new FakeDav();
  sleepImpl = async () => {};
});
afterEach(() => vi.restoreAllMocks());

describe('SyncBackend 抽象：storage.sync 实现', () => {
  it('写前检测到其他设备刚写过（manifest 版本变化）：抛冲突，runSyncCycle 重新拉取合并后重试，两边的熟词都保留', async () => {
    const area = fakeBrowser.storage.sync;
    await setKnownWords(['alpha'], true);
    const backend = new StorageSyncBackend(area, DEFAULT_SYNC_QUOTA);
    // 设备 B 先写一份含 beta 的快照
    const builder = new SnapshotBuilder();
    const scope = (s: Awaited<ReturnType<typeof getSettings>>) => ({ backend: 'storage-sync' as const, include: { ...s.sync.include } });
    await runSyncCycle(backend, builder, { deviceId: 'B', scopeOf: scope });
    // 本机（设备 A）读远端后、写之前，B 又写了一次（加入 gamma）
    const base = await backend.read();
    await setKnownWords(['delta'], true);
    const b2 = new StorageSyncBackend(area, DEFAULT_SYNC_QUOTA);
    const remoteB = await b2.read();
    const knownB = { words: { alpha: 1, beta: 2, gamma: 3 }, removed: {} };
    const segEnc = await encodeSyncValue(encodeKnownSegment(knownB, 'full'));
    const plan = b2.plan([{ id: 'known', kind: 'knownWords', priority: 1, at: 0, label: '', variants: [{ level: 'full', encoded: segEnc }] }], remoteB, {});
    await b2.write(plan, remoteB, 'B');
    // 直接用旧的 base 写：冲突
    const planA = backend.plan(await builder.build(await getSettings(), scope(await getSettings())), base, {});
    await expect(backend.write(planA, base, 'A')).rejects.toBeInstanceOf(SyncConflictError);
    // runSyncCycle：冲突后重新拉取合并（并集）再写
    const res = await runSyncCycle(backend, builder, { deviceId: 'A', scopeOf: scope, firstRemote: base });
    expect(res.conflictRetries).toBe(1);
    const words = Object.keys((await getKnownData()).words).sort();
    expect(words).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    const final = await backend.read();
    expect(Object.keys(decodeKnownSegment(await decodeSyncValue((await final.readSegment('known'))!)).words).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('StorageSyncService 仍是 storage.sync 后端的调度器：getUsage 与规划用量一致', async () => {
    await setKnownWords(['run', 'apple'], true);
    const svc = new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 });
    const st = await svc.syncNow();
    expect(st.phase).toBe('idle');
    const usage = await svc.backend.getUsage();
    expect(usage.quotaBytes).toBe(102400);
    expect(usage.bytes).toBeGreaterThan(0);
  });
});

describe('WebDAV 后端', () => {
  it('首次同步：逐级 MKCOL 建目录、If-None-Match:* 创建文件；另一台设备拉取还原设置/熟词/本地词书', async () => {
    await enableWebDav();
    await setKnownWords(['run', 'apple'], true);
    await saveLocalBook({ name: '我的词表', format: 'txt', words: [{ word: 'zebra', trans: '斑马' }] });
    await patchSettings({ inlineTranslation: { mode: 'ruby' } });
    const st = await davService().syncNow();
    expect(st.phase).toBe('idle');
    expect(dav.log.filter((l) => l.method === 'MKCOL').map((l) => l.path)).toEqual(['/dav/hnw/', '/dav/hnw/sub/']);
    const put = dav.log.find((l) => l.method === 'PUT')!;
    expect(put.headers['if-none-match']).toBe('*');
    expect(Object.keys(dav.snapshot.segs).sort()).toEqual(expect.arrayContaining(['known', 'lbr', 'settings']));
    // WebDAV 自身的密码不会写进它要同步的文件
    expect(dav.rawText).not.toContain(PASSWORD);

    await switchDevice();
    await enableWebDav();
    const st2 = await davService().syncNow();
    expect(st2.phase).toBe('idle');
    expect([...(await getKnownWords())].sort()).toEqual(['apple', 'run']);
    expect((await getSettings()).inlineTranslation.mode).toBe('ruby');
    const books = Object.values((await getLocalIndex()).books);
    expect(books.map((b) => b.name)).toEqual(['我的词表']);
    expect((await getLocalBook(books[0]!.id))!.words.zebra!.trans).toBe('斑马');
    // 本机 WebDAV 配置（本机字段）不被远端设置覆盖
    expect((await getSettings()).sync.webdav.enabled).toBe(true);
  });

  it('无变化时不 PUT；本机有改动时带 If-Match 写入', async () => {
    await enableWebDav();
    await setKnownWords(['run'], true);
    const svc = davService();
    await svc.syncNow();
    const puts = () => dav.log.filter((l) => l.method === 'PUT' && l.path.endsWith('hnw-sync.json'));
    expect(puts()).toHaveLength(1);
    await svc.syncNow();
    expect(puts()).toHaveLength(1);
    await setKnownWords(['walk'], true);
    await svc.syncNow();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.headers['if-match']).toBe('"e1"');
  });

  it('412 冲突：PUT 前另一台设备写入 -> 重新 GET、合并后用新 ETag 重试，双方修改都保留', async () => {
    await enableWebDav();
    await setKnownWords(['alpha'], true);
    const svc = davService();
    await svc.syncNow();
    await setKnownWords(['mine'], true);
    // 在本机下一次 PUT 之前，模拟设备 B 把 theirs 写进远端文件
    let injected = false;
    dav.beforeRequest = async (method, path) => {
      if (method !== 'PUT' || injected || !path.endsWith('hnw-sync.json')) return;
      injected = true;
      const f = dav.snapshot;
      const known = await remoteKnown(f);
      known.words.theirs = Date.now();
      const d = await encodeSyncValue(encodeKnownSegment(known, 'full'));
      f.segs.known = { ...f.segs.known!, d, h: await shortHash(d) };
      f.device = 'B';
      dav.files.set('/dav/hnw/sub/hnw-sync.json', { body: JSON.stringify(f), etag: `"b${++dav.etagSeq}"` });
    };
    const st = await svc.syncNow();
    expect(st.phase).toBe('idle');
    expect(st.conflictRetries).toBe(1);
    expect(dav.log.filter((l) => l.status === 412)).toHaveLength(1);
    expect(Object.keys((await remoteKnown(dav.snapshot)).words).sort()).toEqual(['alpha', 'mine', 'theirs']);
    expect([...(await getKnownWords())].sort()).toEqual(['alpha', 'mine', 'theirs']);
  });

  it('持续冲突超过 5 次：不覆盖远端、不报成功，状态 pending 并安排自动重试', async () => {
    await enableWebDav();
    await setKnownWords(['alpha'], true);
    const svc = davService();
    await svc.syncNow();
    await setKnownWords(['mine'], true);
    dav.beforeRequest = (method, path) => {
      if (method === 'PUT' && path.endsWith('hnw-sync.json')) {
        const f = dav.files.get(path)!;
        dav.files.set(path, { ...f, etag: `"x${++dav.etagSeq}"` });
      }
    };
    const st = await svc.syncNow();
    expect(st.phase).toBe('pending');
    expect(st.error).toBeUndefined();
    expect(st.notice).toMatch(/冲突.*秒后自动再试/);
    expect(dav.log.filter((l) => l.status === 412)).toHaveLength(5);
    // 每次尝试都释放了锁
    expect(dav.locks.size).toBe(0);
  });

  it('服务器不返回 ETag：写前重新 GET 比较内容哈希，仍能检测到并发修改', async () => {
    dav.etags = false;
    await enableWebDav();
    await setKnownWords(['alpha'], true);
    const svc = davService();
    expect((await svc.syncNow()).phase).toBe('idle');
    await setKnownWords(['beta'], true);
    let n = 0;
    dav.beforeRequest = (method, path) => {
      // 第二次 GET（写前检查）之前改动远端
      if (method === 'GET' && path.endsWith('hnw-sync.json') && ++n === 2) {
        const f = dav.files.get(path)!;
        dav.files.set(path, { ...f, body: f.body.replace('"device":"', '"device":"B-') });
      }
    };
    const st = await svc.syncNow();
    expect(st.phase).toBe('idle');
    expect(st.conflictRetries).toBe(1);
    expect(Object.keys((await remoteKnown(dav.snapshot)).words).sort()).toEqual(['alpha', 'beta']);
  });

  it('弱 ETag（Apache 同一秒内修改返回 W/"…"）：不用于 If-Match（否则必然 412），改为写前比较内容哈希', async () => {
    await enableWebDav();
    await setKnownWords(['alpha'], true);
    const svc = davService();
    await svc.syncNow();
    const f = dav.files.get('/dav/hnw/sub/hnw-sync.json')!;
    dav.files.set('/dav/hnw/sub/hnw-sync.json', { ...f, etag: `W/${f.etag}` });
    await setKnownWords(['beta'], true);
    const st = await svc.syncNow();
    expect(st.phase).toBe('idle');
    const lastPut = dav.log.filter((l) => l.method === 'PUT' && l.path.endsWith('hnw-sync.json')).pop()!;
    expect(lastPut.headers['if-match']).toBeUndefined();
    // 弱 ETag 时靠写锁保证“比较 → 写入”原子：PUT 带锁令牌
    expect(lastPut.headers.if).toMatch(/^\(<opaquelocktoken:/);
    expect(lastPut.status).toBe(204);
  });

  it('错误：401 提示应用密码；未授权主机权限不发请求；503 限流进入 pending 并记录 retryAt', async () => {
    await enableWebDav({ password: 'wrong' });
    expect((await davService().syncNow()).error).toMatch(/用户名或密码错误/);

    await enableWebDav();
    const before = dav.log.length;
    const denied = await davService({ hasAccess: async () => false }).syncNow();
    expect(denied.phase).toBe('error');
    expect(denied.error).toMatch(/未授权访问 dav\.example\.com/);
    expect(dav.log.length).toBe(before);

    dav.forceStatus = 503;
    const limited = await davService().syncNow();
    expect(limited.phase).toBe('pending');
    expect(limited.retryAt).toBeGreaterThan(Date.now());
    // 退避期内不再请求
    const n = dav.log.length;
    expect((await davService().syncNow()).phase).toBe('pending');
    expect(dav.log.length).toBe(n);
  });

  it('可选同步来源词书缓存（storage.sync 不同步）：新设备不用重新登录拉取即可高亮', async () => {
    await enableWebDav({ include: { settings: true, knownWords: true, localBooks: true, sourceBooks: true } });
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'ok', lastSyncAt: 5, wordCount: 2 });
    await saveSourceBook({ id: 'src:youdao:0', words: { run: { word: 'run', ref: 'i1' }, walk: { word: 'walk', ref: 'i2' } }, updatedAt: 5 });
    await davService().syncNow();
    expect(Object.keys(dav.snapshot.segs)).toContain('sb:src:youdao:0');
    await switchDevice();
    await enableWebDav({ include: { settings: true, knownWords: true, localBooks: true, sourceBooks: true } });
    await davService().syncNow();
    expect(Object.keys((await getSourceBook('src:youdao:0'))!.words).sort()).toEqual(['run', 'walk']);
  });

  it('关闭某类别时保留远端已有的段（其他设备的数据），不删除', async () => {
    await enableWebDav();
    await saveLocalBook({ name: 'A', format: 'txt', words: [{ word: 'x' }] });
    await davService().syncNow();
    const lb = Object.keys(dav.snapshot.segs).filter((k) => k.startsWith('lb:'));
    expect(lb).toHaveLength(1);
    await enableWebDav({ include: { settings: true, knownWords: true, localBooks: false, sourceBooks: false } });
    await setKnownWords(['y'], true);
    await davService().syncNow();
    expect(Object.keys(dav.snapshot.segs)).toEqual(expect.arrayContaining(lb));
  });

  it('测试连接：逐步报告并创建目录、确认可写（PUT/DELETE 探测文件）', async () => {
    await enableWebDav();
    const res = await davService().test();
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => s.step)).toEqual(['连接服务器', '同步目录', '写入权限', '同步文件']);
    expect(dav.files.has('/dav/hnw/sub/.hnw-probe')).toBe(false);
    const bad = await davService().test({ url: 'ftp://x' });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/http/);
  });

  it('数据变化防抖自动同步（autoSync.onChange）', async () => {
    vi.useFakeTimers();
    try {
      await enableWebDav();
      const svc = new WebDavSyncService({ fetchImpl: dav.fetch, debounceMs: 1000, maxWaitMs: 5000, hasAccess: async () => true });
      svc.listen();
      await setKnownWords(['run'], true);
      await vi.advanceTimersByTimeAsync(50);
      expect(dav.log.filter((l) => l.method === 'PUT')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(dav.log.some((l) => l.method === 'PUT' && l.path.endsWith('hnw-sync.json'))).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('凭据随同步上传开关', () => {
  it('默认不上传：欧路 token、WebDAV 密码都不出现在 storage.sync、WebDAV 文件与备份中', async () => {
    await patchSettings({ sources: { eudic: { apiToken: 'NIS secret-token' } } });
    await enableWebDav();
    await new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 }).syncNow();
    await davService().syncNow();
    const syncRaw = JSON.stringify(await fakeBrowser.storage.sync.get(null));
    const all = await Promise.all(Object.values(await fakeBrowser.storage.sync.get(null)).filter((v) => typeof v === 'string').map(String));
    expect(syncRaw).not.toContain('secret-token');
    expect(all.join('')).not.toContain('secret');
    expect(dav.snapshot.segs.cred).toBeUndefined();
    const backup = await exportBackup({ includeCredentials: true });
    expect(backup.content).not.toContain('secret-token');
    expect(backup.content).not.toContain(PASSWORD);
    const infos = listSyncCredentials(await getSettings());
    expect(infos.map((i) => [i.id, i.upload, i.present])).toEqual([
      ['token:eudic', false, true],
      ['webdav', false, true],
    ]);
  });

  it('勾选上传：token 经 storage.sync 到达另一台设备；WebDAV 连接信息只随 storage.sync，不写进 WebDAV 文件', async () => {
    await patchSettings({ sources: { eudic: { apiToken: 'NIS secret-token' } }, credentialSync: { 'token:eudic': true, webdav: true } });
    await enableWebDav();
    // background 的 watchCredentialChanges 在设置变化时记修改时间（这里直接调用）
    await stampChangedCredentials(undefined, await getSettings());
    await new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 }).syncNow();
    await davService().syncNow();
    const davCred = await decodeSyncValue<Record<string, unknown>>(dav.snapshot.segs.cred!.d);
    expect(Object.keys(davCred)).toEqual(['token:eudic']);
    expect(dav.rawText).not.toContain(PASSWORD);

    await switchDevice();
    const st = await new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 }).syncNow();
    expect(st.phase).toBe('idle');
    const s = await getSettings();
    expect(s.credentialSync).toEqual({ 'token:eudic': true, webdav: true });
    expect(s.sources.eudic!.apiToken).toBe('NIS secret-token');
    expect(s.sync.webdav).toMatchObject({ url: DAV, username: 'me@example.com', password: PASSWORD, dir: 'hnw/sub', enabled: false });
  });

  it('本机较新的修改不被远端旧值覆盖；取消勾选后远端凭据段被移除', async () => {
    await patchSettings({ sources: { eudic: { apiToken: 'old' } }, credentialSync: { 'token:eudic': true } });
    await stampChangedCredentials(undefined, await getSettings());
    const svc = new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 });
    await svc.syncNow();
    const prev = await getSettings();
    await patchSettings({ sources: { eudic: { apiToken: 'new' } } });
    await stampChangedCredentials(prev, await getSettings());
    await svc.syncNow();
    expect((await getSettings()).sources.eudic!.apiToken).toBe('new');
    await patchSettings({ credentialSync: { 'token:eudic': false } });
    await svc.syncNow();
    const keys = Object.keys(await fakeBrowser.storage.sync.get(null));
    expect(keys.some((k) => k.startsWith('hnw:cred:'))).toBe(false);
  });
});

describe('手动备份导入导出', () => {
  async function seed() {
    await setKnownWords(['run', 'apple', 'pear'], true);
    await setKnownWords(['pear'], false);
    await saveLocalBook({ name: '书A', format: 'txt', words: [{ word: 'zebra', trans: '斑马' }] });
    await patchSettings({ inlineTranslation: { mode: 'after' } });
  }

  it('导出 JSON 含设置、熟词（含墓碑）、本地词书；覆盖导入到空设备完整还原', async () => {
    await seed();
    const out = await exportBackup();
    expect(out.encoding).toBe('json');
    expect(out.fileName).toMatch(/^hnw-backup-\d{8}-\d{4}\.json$/);
    const file = JSON.parse(out.content);
    expect(file.knownWords.removed.pear).toBeGreaterThan(0);
    expect(out.counts).toMatchObject({ knownWords: 2, localBooks: 1 });

    await switchDevice();
    const preview = await previewBackupImport(out.content, 'overwrite');
    expect(preview.knownWords.added).toBe(2);
    expect(preview.localBooks.added).toBe(1);
    expect(preview.settings.willApply).toBe(true);
    const res = await importBackup(out.content, 'overwrite');
    expect(res.ok).toBe(true);
    expect([...(await getKnownWords())].sort()).toEqual(['apple', 'run']);
    expect((await getSettings()).inlineTranslation.mode).toBe('after');
    const book = Object.values((await getLocalIndex()).books)[0]!;
    expect((await getLocalBook(book.id))!.words.zebra!.trans).toBe('斑马');
  });

  it('gzip 压缩导出可导入', async () => {
    await seed();
    const out = await exportBackup({ compress: true });
    expect(out.encoding).toBe('gzip-base64');
    expect(out.fileName.endsWith('.json.gz')).toBe(true);
    expect(out.content.length).toBeLessThan(out.bytes);
    await switchDevice();
    await importBackup(out.content, 'merge');
    expect([...(await getKnownWords())].sort()).toEqual(['apple', 'run']);
  });

  it('合并预览：新增 / 删除（备份中较新的删除记录）/ 冲突计数，且预览不写本机', async () => {
    await seed();
    const out = await exportBackup();
    // 本机在导出后：新增 walk；把 apple 删除（较新的墓碑）；pear 重新加入（与备份中的 pear 墓碑冲突）
    // 等几毫秒：同一毫秒内的加入与删除按“删除优先”处理，会让计数随机
    await new Promise((r) => setTimeout(r, 5));
    await setKnownWords(['walk', 'pear'], true);
    await setKnownWords(['apple'], false);
    // 备份里再塞一个本机没有的词、一个对 walk 的较新删除记录
    const file = JSON.parse(out.content);
    file.knownWords.words.extra = Date.now();
    file.knownWords.removed.walk = Date.now() + 1000;
    const content = JSON.stringify(file);
    const before = JSON.stringify(await getKnownData());
    const p = await previewBackupImport(content, 'merge');
    expect(JSON.stringify(await getKnownData())).toBe(before);
    expect(p.knownWords.added).toBe(1); // extra（apple 在本机的墓碑更新，不复活）
    expect(p.knownWords.removed).toBe(1); // walk
    expect(p.knownWords.conflicts).toBe(3); // walk(本机熟词 vs 备份墓碑)、pear(本机熟词 vs 备份墓碑)、apple(备份熟词 vs 本机墓碑)
    expect(p.summary).toMatch(/冲突/);
    await importBackup(content, 'merge');
    expect([...(await getKnownWords())].sort()).toEqual(['extra', 'pear', 'run']);
  });

  it('覆盖导入：本机多出的熟词与本地词书记删除墓碑（同步到其他设备也会删除）', async () => {
    await seed();
    const out = await exportBackup();
    await setKnownWords(['local-only'], true);
    const extra = await saveLocalBook({ name: '本机多出的书', format: 'txt', words: [{ word: 'q' }] });
    const p = await previewBackupImport(out.content, 'overwrite');
    expect(p.knownWords.removed).toBe(1);
    expect(p.localBooks.removed).toBe(1);
    await importBackup(out.content, 'overwrite');
    const known = await getKnownData();
    expect(known.words['local-only']).toBeUndefined();
    expect(known.removed['local-only']).toBeGreaterThan(0);
    const idx = await getLocalIndex();
    expect(idx.books[extra.id]).toBeUndefined();
    expect(idx.removed[extra.id]).toBeGreaterThan(0);
  });

  it('合并时本机已删除的词书不被旧备份复活（墓碑较新）', async () => {
    await seed();
    const out = await exportBackup();
    const id = Object.keys((await getLocalIndex()).books)[0]!;
    await deleteLocalBook(id);
    await importBackup(out.content, 'merge');
    expect((await getLocalIndex()).books[id]).toBeUndefined();
  });

  it('不是本扩展的文件：中文错误', async () => {
    await expect(previewBackupImport('{"a":1}', 'merge')).rejects.toThrow(/不是本扩展导出的备份文件/);
    await expect(previewBackupImport('@@@', 'merge')).rejects.toThrow(/无法识别/);
  });

  it('备份中勾选上传的凭据：合并导入时写入本机（本机为空）', async () => {
    await patchSettings({ sources: { eudic: { apiToken: 'NIS t1' } }, credentialSync: { 'token:eudic': true } });
    // 备份中的凭据是明文：默认不含，导出时确认 includeCredentials 才写入
    const plain = await exportBackup();
    expect(JSON.parse(plain.content).credentials).toBeUndefined();
    expect(plain.content).not.toContain('NIS t1');
    expect(plain.counts.skippedCredentials).toBe(1);
    const out = await exportBackup({ includeCredentials: true });
    expect(out.counts.skippedCredentials).toBe(0);
    expect(JSON.parse(out.content).credentials['token:eudic'].v).toBe('NIS t1');
    await switchDevice();
    const p = await previewBackupImport(out.content, 'merge');
    // 设置先合并（credentialSync 勾选随设置一起导入）；预览按本机当前勾选计算，所以此时为空
    expect(p.credentials).toEqual([]);
    await importBackup(out.content, 'merge');
    expect((await getSettings()).sources.eudic!.apiToken).toBe('NIS t1');
  });
});

describe('TTS 平台垫片', () => {
  it('无 chrome.tts 且无 speechSynthesis：后台返回 fallback，sendToBackground 在调用方上下文用 Web Speech 朗读', async () => {
    const tts = fakeBrowser.tts;
    // @ts-expect-error 模拟没有 tts API 的浏览器
    fakeBrowser.tts = undefined;
    try {
      await saveSettings({ ...(await getSettings()), tts: { enabled: true, voice: { lang: 'en-GB' }, rate: 0.9 } });
      const res = await speak('hello', true);
      expect(res).toEqual({ spoken: false, reason: 'unavailable', fallback: { text: 'hello', lang: 'en-GB', voiceName: undefined, rate: 0.9 } });

      // 调用方上下文有 speechSynthesis：messaging 层自动兜底
      const spoken: string[] = [];
      class Utter {
        lang = '';
        rate = 1;
        voice?: unknown;
        onstart?: () => void;
        constructor(readonly text: string) {}
      }
      vi.stubGlobal('SpeechSynthesisUtterance', Utter);
      vi.stubGlobal('speechSynthesis', {
        getVoices: () => [{ name: 'Daniel', lang: 'en-GB', default: true }],
        addEventListener: () => {},
        removeEventListener: () => {},
        cancel: () => {},
        speak: (u: Utter) => {
          spoken.push(`${u.text}|${u.lang}|${u.rate}`);
          u.onstart?.();
        },
      });
      vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true, result: res } as never);
      expect(await sendToBackground('tts', { text: 'hello', force: true })).toEqual({ spoken: true });
      expect(spoken).toEqual(['hello|en-GB|0.9']);
    } finally {
      fakeBrowser.tts = tts;
      vi.unstubAllGlobals();
    }
  });
});

describe('状态存储', () => {
  it('WebDAV 状态单独存在 webdavSyncState，带设备 id', async () => {
    await enableWebDav();
    await davService().syncNow();
    const st = (await fakeBrowser.storage.local.get(STORAGE_KEYS.webdavSyncState))[STORAGE_KEYS.webdavSyncState] as BackendSyncStatus;
    expect(st.backend).toBe('webdav');
    expect(st.deviceId).toBeTruthy();
    expect(st.lastSyncAt).toBeGreaterThan(0);
    expect(dav.snapshot.device).toBe(st.deviceId);
    expect(webdavScope(await getSettings()).include.sourceBooks).toBe(false);
  });
});

describe('WebDavBackend 直接使用', () => {
  it('远端文件损坏（非本扩展格式）：按空远端处理并用 If-Match 覆盖', async () => {
    await enableWebDav();
    dav.dirs.add('/dav/hnw/');
    dav.dirs.add('/dav/hnw/sub/');
    dav.files.set('/dav/hnw/sub/hnw-sync.json', { body: 'garbage', etag: '"g1"' });
    const backend = new WebDavBackend({ url: DAV, username: 'me@example.com', password: PASSWORD, dir: 'hnw/sub' }, dav.fetch);
    const remote = await backend.read();
    expect(remote.segs).toEqual({});
    await setKnownWords(['run'], true);
    const res = await runSyncCycle(backend, new SnapshotBuilder(), { deviceId: 'A', scopeOf: webdavScope, firstRemote: remote });
    expect(res.wrote).toBe(true);
    expect(dav.log.find((l) => l.method === 'PUT' && l.path.endsWith('hnw-sync.json'))!.headers['if-match']).toBe('"g1"');
  });
});

/** 一台设备的本机存储（fakeBrowser 只有一份 storage.local，切换设备时整体换入换出） */
class Device {
  local: Record<string, unknown> = {};
  constructor(readonly name: string) {}
  async enter(): Promise<void> {
    await fakeBrowser.storage.local.clear();
    if (Object.keys(this.local).length) await fakeBrowser.storage.local.set(structuredClone(this.local));
  }
  async leave(): Promise<void> {
    this.local = structuredClone(await fakeBrowser.storage.local.get(null));
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.enter();
    try {
      return await fn();
    } finally {
      await this.leave();
    }
  }
}

/** 远端熟词段：词与墓碑 */
async function remoteKnownAll() {
  const k = await remoteKnown(dav.snapshot);
  return { words: Object.keys(k.words).sort(), removed: Object.keys(k.removed ?? {}).sort() };
}

describe('WebDAV 多设备并发写入（第 4 轮 H1：弱 ETag / 无 ETag 不丢写入）', () => {
  /** A、B 都同步过一次 base（含 gone-a、gone-b），然后 A 加 alpha 删 gone-a，B 加 bravo 删 gone-b */
  async function prepareTwoDevices(): Promise<{ A: Device; B: Device }> {
    const A = new Device('A');
    const B = new Device('B');
    await A.run(async () => {
      await enableWebDav();
      await setKnownWords(['base', 'gone-a', 'gone-b'], true);
      expect((await davService().syncNow()).phase).toBe('idle');
    });
    await B.run(async () => {
      await enableWebDav();
      expect((await davService().syncNow()).phase).toBe('idle');
      await setKnownWords(['bravo'], true);
      await setKnownWords(['gone-b'], false);
    });
    await A.run(async () => {
      await setKnownWords(['alpha'], true);
      await setKnownWords(['gone-a'], false);
    });
    return { A, B };
  }
  const expectUnion = async () => {
    const r = await remoteKnownAll();
    expect(r.words).toEqual(['alpha', 'base', 'bravo']);
    expect(r.removed).toEqual(['gone-a', 'gone-b']);
  };

  it.each(['weak', 'none'] as const)(
    '支持 LOCK、ETag=%s：B 的完整同步插在 A 的“锁内比较 GET”与 PUT 之间 -> B 被 423 挡住且不报成功，随后补推，远端词与墓碑都在',
    async (mode) => {
      if (mode === 'weak') dav.weak = true;
      else dav.etags = false;
      const { A, B } = await prepareTwoDevices();
      let bStatus: BackendSyncStatus | undefined;
      let injected = false;
      const result = await A.run(async () => {
        dav.beforeRequest = async (method, path) => {
          // A 已持锁并完成比较 GET，正要 PUT：此时插入 B 的完整同步
          if (injected || method !== 'PUT' || !path.endsWith('hnw-sync.json')) return;
          injected = true;
          await A.leave();
          bStatus = await B.run(() => davService().syncNow());
          await A.enter();
        };
        return davService().syncNow();
      });
      dav.beforeRequest = undefined;
      expect(injected).toBe(true);
      expect(result.phase, result.error).toBe('idle');
      // B 每次加锁都是 423：不写远端、不报 idle，状态 pending 等待自动重试
      expect(bStatus!.phase).toBe('pending');
      expect(dav.log.filter((l) => l.method === 'LOCK' && l.status === 423)).toHaveLength(5);
      expect(dav.log.filter((l) => l.method === 'PUT' && l.status === 423)).toHaveLength(0);
      expect(dav.locks.size).toBe(0);
      // B 之后的重试：拉取 A 的写入并合并后推送
      const bAfter = await B.run(() => davService().syncNow());
      expect(bAfter.phase, bAfter.error).toBe('idle');
      await expectUnion();
      // A 再同步拿到 B 的改动（墓碑生效：gone-b 在 A 上也被删除）
      await A.run(async () => {
        await davService().syncNow();
        expect([...(await getKnownWords())].sort()).toEqual(['alpha', 'base', 'bravo']);
      });
    },
  );

  it.each(['weak', 'none'] as const)(
    '不支持 LOCK、ETag=%s：B 的 PUT 落在 A 的“比较 GET”与 PUT 之间被 A 覆盖 -> B 写后回读校验发现被覆盖，重新合并写入',
    async (mode) => {
      dav.lockSupport = false;
      if (mode === 'weak') dav.weak = true;
      else dav.etags = false;
      const { A, B } = await prepareTwoDevices();
      // 编排（真实时序）：A 比较 GET 通过 -> B 完成比较 GET 与 PUT，进入回读前的随机等待 -> A 的 PUT 覆盖 B -> A 回读校验通过
      // -> B 等待结束回读，发现内容不是自己写的 -> 冲突，重新拉取（含 A 的数据）合并后再写
      let releaseB!: () => void;
      let bWaiting!: () => void;
      const bReachedVerify = new Promise<void>((r) => (bWaiting = r));
      let bPromise: Promise<BackendSyncStatus> | undefined;
      let aPutSeen = false;
      const aStatus = await A.run(async () => {
        dav.beforeRequest = async (method, path) => {
          if (aPutSeen || bPromise || method !== 'PUT' || !path.endsWith('hnw-sync.json')) return;
          aPutSeen = true;
          await A.leave();
          await B.enter();
          // B 的第一次回读等待挂起，直到 A 写完
          let first = true;
          sleepImpl = (ms) => {
            if (!first || ms < 300) return Promise.resolve();
            first = false;
            bWaiting();
            return new Promise<void>((r) => (releaseB = r));
          };
          bPromise = davService().syncNow();
          await bReachedVerify;
          await B.leave();
          sleepImpl = async () => {};
          await A.enter();
        };
        return davService().syncNow();
      });
      dav.beforeRequest = undefined;
      expect(aStatus.phase, aStatus.error).toBe('idle');
      // 此刻远端只有 A 的写入（B 被覆盖）
      expect((await remoteKnownAll()).words).toEqual(['alpha', 'base', 'gone-b']);
      await B.enter();
      releaseB();
      const bStatus = await bPromise!;
      await B.leave();
      expect(bStatus.phase, bStatus.error).toBe('idle');
      expect(bStatus.conflictRetries).toBe(1);
      await expectUnion();
    },
  );

  it('不支持 LOCK 时只探测一次，之后直接走写后回读校验；校验 GET 在 PUT 之后', async () => {
    dav.lockSupport = false;
    dav.weak = true;
    await enableWebDav();
    const svc = davService();
    await setKnownWords(['a1'], true);
    await svc.syncNow();
    await setKnownWords(['a2'], true);
    await svc.syncNow();
    expect(dav.log.filter((l) => l.method === 'LOCK')).toHaveLength(1);
    const seq = dav.log.filter((l) => l.path.endsWith('hnw-sync.json')).map((l) => l.method);
    expect(seq.slice(-4)).toEqual(['GET', 'GET', 'PUT', 'GET']);
  });

  it('不支持 LOCK：其他设备较慢的 PUT 在本机回读校验之后才落地 -> 5–15 秒后的复查同步发现并补推', async () => {
    vi.useFakeTimers();
    try {
      dav.lockSupport = false;
      dav.weak = true;
      await enableWebDav();
      await setKnownWords(['base'], true);
      const svc = davService();
      await svc.syncNow();
      const stale = dav.files.get('/dav/hnw/sub/hnw-sync.json')!;
      await setKnownWords(['mine'], true);
      expect((await svc.syncNow()).phase).toBe('idle');
      // 本机回读校验通过之后，另一台设备基于旧版本的慢 PUT 才落地（内容不含 mine）
      dav.files.set('/dav/hnw/sub/hnw-sync.json', { ...stale, etag: `"late${++dav.etagSeq}"` });
      expect((await remoteKnownAll()).words).toEqual(['base']);
      await vi.advanceTimersByTimeAsync(16_000);
      await vi.waitFor(async () => expect((await remoteKnownAll()).words).toEqual(['base', 'mine']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('强 ETag + 支持 LOCK：持锁 PUT 同时带 If-Match 与锁令牌，写完 UNLOCK', async () => {
    await enableWebDav();
    const svc = davService();
    await setKnownWords(['a1'], true);
    await svc.syncNow();
    await setKnownWords(['a2'], true);
    await svc.syncNow();
    const seq = dav.log.filter((l) => l.path.endsWith('hnw-sync.json')).map((l) => `${l.method}${l.status}`);
    expect(seq.slice(-4)).toEqual(['GET200', 'LOCK200', 'PUT204', 'UNLOCK204']);
    const put = dav.log.filter((l) => l.method === 'PUT').pop()!;
    expect(put.headers['if-match']).toBe('"e1"');
    expect(put.headers.if).toMatch(/opaquelocktoken/);
  });

  it('其他客户端持有锁（未带令牌的 PUT 得到 423）：按冲突处理，不报错', async () => {
    await enableWebDav();
    await setKnownWords(['a1'], true);
    await davService().syncNow();
    dav.locks.set('/dav/hnw/sub/hnw-sync.json', '<opaquelocktoken:other>');
    await setKnownWords(['a2'], true);
    const st = await davService().syncNow();
    expect(st.phase).toBe('pending');
    expect(st.error).toBeUndefined();
    dav.locks.clear();
    expect((await davService().syncNow()).phase).toBe('idle');
    expect((await remoteKnownAll()).words).toEqual(['a1', 'a2']);
  });
});

describe('WebDAV 健壮性（第 4 轮 H2 / H3 / P2）', () => {
  it('H2：SW 在同步中被回收，重启后（未开启启动同步、距上次同步不足 60 秒）不再停在 syncing，并补一次同步', async () => {
    await enableWebDav({ autoSync: { onChange: true, onStartup: false, intervalMinutes: 0 } });
    await setKnownWords(['half'], true);
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.webdavSyncState]: { backend: 'webdav', enabled: true, phase: 'syncing', error: '上次错误', lastSyncAt: Date.now() - 1000, lastPullAt: 0, lastPushAt: 0, deviceId: 'dev-x' },
    });
    const svc = davService();
    await svc.onStartup();
    const st = await svc.getStatus();
    expect(st.phase).toBe('pending');
    expect(st.error).toBe('上次错误');
    await vi.waitFor(async () => expect((await svc.getStatus()).phase).toBe('idle'));
    expect((await remoteKnownAll()).words).toEqual(['half']);
  });

  it('H2：WebDAV 已关闭时残留的 syncing 复位为 disabled', async () => {
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.webdavSyncState]: { backend: 'webdav', enabled: true, phase: 'syncing', lastSyncAt: 0, lastPullAt: 0, lastPushAt: 0, deviceId: 'dev-x' },
    });
    const svc = davService();
    await svc.onStartup();
    expect((await svc.getStatus()).phase).toBe('disabled');
    expect(dav.log).toHaveLength(0);
  });

  it('H3：并发建目录时 MKCOL 返回 403 但目录已被另一台设备建好 -> 视为成功；目录确实不存在才报权限错误', async () => {
    await enableWebDav();
    // 另一台设备抢先建好目录：本机 PROPFIND 时还不存在，MKCOL 时已存在（Apache 对较晚的并发 MKCOL 返回 403）
    dav.mkcolStatus = 403;
    dav.beforeRequest = (method, path) => {
      if (method === 'MKCOL') dav.dirs.add(path);
    };
    await setKnownWords(['x'], true);
    const st = await davService().syncNow();
    expect(st.phase, st.error).toBe('idle');
    expect(dav.snapshot.segs.known).toBeDefined();

    dav.beforeRequest = undefined;
    dav.dirs = new Set(['/dav/']);
    const res = await davService().test({ dir: 'other' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/拒绝访问/);
  });

  it('P2：未勾选同步来源词书时，来源缓存变化不触发 WebDAV 请求；勾选后触发', async () => {
    vi.useFakeTimers();
    try {
      await enableWebDav({ include: { settings: true, knownWords: true, localBooks: true, sourceBooks: false } });
      const svc = new WebDavSyncService({ fetchImpl: dav.fetch, debounceMs: 100, maxWaitMs: 500, hasAccess: async () => true });
      svc.listen();
      await vi.advanceTimersByTimeAsync(1000);
      const n = dav.log.length;
      await saveSourceBook({ id: 'src:youdao:0', words: { run: { word: 'run', ref: 'i1' } }, updatedAt: 5 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(dav.log.length).toBe(n);
      await enableWebDav({ include: { settings: true, knownWords: true, localBooks: true, sourceBooks: true } });
      await vi.advanceTimersByTimeAsync(1000);
      const m = dav.log.length;
      expect(m).toBeGreaterThan(n);
      await saveSourceBook({ id: 'src:youdao:0', words: { walk: { word: 'walk', ref: 'i2' } }, updatedAt: 6 });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(dav.log.length).toBeGreaterThan(m));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WebDAV 目录被删除 / 锁异常恢复（第 4 轮 J1 / Q1 / Q2 / Q3）', () => {
  it('J1 支持 LOCK：同一服务实例内同步目录被删除 -> 第 1 次同步就重建目录（LOCK409 → MKCOL → LOCK → PUT → UNLOCK）并恢复 idle', async () => {
    await enableWebDav();
    await setKnownWords(['root'], true);
    const svc = davService();
    expect((await svc.syncNow()).phase).toBe('idle');
    dav.deleteSyncDir();
    await setKnownWords(['after'], true);
    const n = dav.log.length;
    const st = await svc.syncNow();
    expect(st.phase, st.error).toBe('idle');
    expect(dav.seqFrom(n)).toEqual(['GET404', 'LOCK409', 'MKCOL201', 'MKCOL201', 'LOCK201', 'GET404', 'PUT201', 'UNLOCK204']);
    expect((await remoteKnownAll()).words).toEqual(['after', 'root']);
    expect(dav.locks.size).toBe(0);
  });

  it.each([403, 409])('J1 不支持 LOCK（405）：目录被删除 -> PUT%i 后确认目录不存在、重建目录重试，回读校验通过', async (putStatus) => {
    dav.lockSupport = false;
    dav.putNoParentStatus = putStatus;
    await enableWebDav();
    await setKnownWords(['root'], true);
    const svc = davService();
    expect((await svc.syncNow()).phase).toBe('idle');
    dav.deleteSyncDir();
    await setKnownWords(['after'], true);
    const n = dav.log.length;
    const st = await svc.syncNow();
    expect(st.phase, st.error).toBe('idle');
    const putFail = putStatus === 403 ? [`PUT403`, 'PROPFIND404'] : ['PUT409'];
    expect(dav.seqFrom(n)).toEqual(['GET404', 'GET404', ...putFail, 'MKCOL201', 'MKCOL201', 'GET404', 'PUT201', 'GET200']);
    expect((await remoteKnownAll()).words).toEqual(['after', 'root']);
  });

  it('J1 不支持 LOCK：写后回读 GET 404（刚写完目录就被删）-> 按冲突重试并重建目录，最终 idle', async () => {
    dav.lockSupport = false;
    await enableWebDav();
    await setKnownWords(['root'], true);
    const svc = davService();
    expect((await svc.syncNow()).phase).toBe('idle');
    await setKnownWords(['after'], true);
    let deleted = false;
    dav.beforeRequest = (method) => {
      // 本机 PUT 成功后、回读之前，用户在网盘端删除了目录
      if (!deleted && method === 'GET' && dav.log.at(-1)?.method === 'PUT') {
        deleted = true;
        dav.deleteSyncDir();
      }
    };
    const st = await svc.syncNow();
    dav.beforeRequest = undefined;
    expect(deleted).toBe(true);
    expect(st.phase, st.error).toBe('idle');
    expect(st.conflictRetries).toBe(1);
    expect((await remoteKnownAll()).words).toEqual(['after', 'root']);
  });

  it('PUT 403 但目录存在（真正无写权限）：仍报拒绝访问，不建目录', async () => {
    dav.lockSupport = false;
    await enableWebDav();
    await setKnownWords(['root'], true);
    const svc = davService();
    await svc.syncNow();
    dav.forcePutStatus = 403;
    await setKnownWords(['x'], true);
    const n = dav.log.length;
    const st = await svc.syncNow();
    expect(st.phase).toBe('error');
    expect(st.error).toMatch(/拒绝访问/);
    expect(dav.seqFrom(n)).toEqual(['GET200', 'PUT403', 'PROPFIND207']);
  });

  it('J1 同步文件被单独删除、目录还在：If-None-Match:* 重新创建，不建目录', async () => {
    await enableWebDav();
    await setKnownWords(['root'], true);
    const svc = davService();
    await svc.syncNow();
    dav.files.delete('/dav/hnw/sub/hnw-sync.json');
    const n = dav.log.length;
    const st = await svc.syncNow();
    expect(st.phase, st.error).toBe('idle');
    expect(dav.seqFrom(n)).toEqual(['GET404', 'LOCK201', 'GET404', 'PUT201', 'UNLOCK204']);
    expect(dav.log.at(-2)!.headers['if-none-match']).toBe('*');
    expect((await remoteKnownAll()).words).toEqual(['root']);
  });

  it('目录确认不重复：远端文件已存在时（含 SW 重启后的新实例）同步不发 PROPFIND；首次同步只 PROPFIND 最深一级', async () => {
    await enableWebDav();
    await setKnownWords(['a1'], true);
    await davService().syncNow();
    expect(dav.log.filter((l) => l.method === 'PROPFIND').map((l) => l.path)).toEqual(['/dav/hnw/sub/']);
    await setKnownWords(['a2'], true);
    const n = dav.log.length;
    expect((await davService().syncNow()).phase).toBe('idle');
    expect(dav.seqFrom(n)).toEqual(['GET200', 'LOCK200', 'PUT204', 'UNLOCK204']);
  });

  it('Q2 LOCK 偶发 500：本次写入内退避重试 LOCK 成功，不降级为无锁；下一次同步仍加锁', async () => {
    await enableWebDav();
    await setKnownWords(['x1'], true);
    const svc = davService();
    dav.lockFailures = [500];
    const st = await svc.syncNow();
    expect(st.phase, st.error).toBe('idle');
    expect(st.recheckAt).toBeUndefined();
    await setKnownWords(['x2'], true);
    const n = dav.log.length;
    await svc.syncNow();
    expect(dav.seqFrom(n)).toContain('LOCK200');
  });

  it('Q2 LOCK 持续 502：不当作不支持锁、不做无锁写入；状态 pending 自动重试，恢复后加锁写入', async () => {
    await enableWebDav();
    await setKnownWords(['x1'], true);
    const svc = davService();
    dav.lockFailures = [502, 502, 502];
    const st = await svc.syncNow();
    expect(st.phase).toBe('pending');
    expect(st.error).toBeUndefined();
    expect(st.notice).toMatch(/HTTP 502.*秒后自动重试/);
    expect(dav.log.filter((l) => l.method === 'PUT')).toHaveLength(0);
    const n = dav.log.length;
    expect((await svc.syncNow()).phase).toBe('idle');
    expect(dav.seqFrom(n)).toContain('LOCK201');
  });

  it('Q1 无锁写入的复查时间持久化：SW 在复查前被回收，重启后（启动同步关闭）立即补做复查并补推', async () => {
    dav.lockSupport = false;
    dav.weak = true;
    await enableWebDav({ autoSync: { onChange: true, onStartup: false, intervalMinutes: 0 } });
    await setKnownWords(['base'], true);
    await davService().syncNow();
    const stale = dav.files.get('/dav/hnw/sub/hnw-sync.json')!;
    await setKnownWords(['mine'], true);
    const st = await davService().syncNow();
    expect(st.phase).toBe('idle');
    expect(st.recheckAt).toBeGreaterThan(Date.now());
    // 另一台设备的慢 PUT 在本机回读之后落地；随后 SW 被回收（内存中的复查定时器丢失）
    dav.files.set('/dav/hnw/sub/hnw-sync.json', { ...stale, etag: `"late${++dav.etagSeq}"` });
    const saved = (await fakeBrowser.storage.local.get(STORAGE_KEYS.webdavSyncState))[STORAGE_KEYS.webdavSyncState] as BackendSyncStatus;
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.webdavSyncState]: { ...saved, recheckAt: Date.now() - 1, lastSyncAt: Date.now() - 2000 } });
    const svc = davService();
    await svc.onStartup();
    expect((await remoteKnownAll()).words).toEqual(['base', 'mine']);
    // 补推本身又是无锁写入：重新安排了复查；再次复查无变化后清除
    expect((await svc.getStatus()).recheckAt).toBeGreaterThan(Date.now());
    await svc.syncNow();
    expect((await svc.getStatus()).recheckAt).toBeUndefined();
  });

  it('Q3 本机 SW 持锁时被回收：重启后先用持久化的令牌 UNLOCK 自己的残留锁，不被自己挡住', async () => {
    await enableWebDav();
    await setKnownWords(['a1'], true);
    await davService().syncNow();
    expect((await fakeBrowser.storage.local.get(STORAGE_KEYS.webdavLock))[STORAGE_KEYS.webdavLock]).toBeUndefined();
    // 模拟：LOCK 成功、令牌已持久化，PUT 前 SW 被回收（UNLOCK 没发出去）
    const url = DAV + 'hnw/sub/hnw-sync.json';
    dav.locks.set('/dav/hnw/sub/hnw-sync.json', '<opaquelocktoken:mine-dead>');
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.webdavLock]: { url, token: '<opaquelocktoken:mine-dead>', at: Date.now() - 5000 } });
    await setKnownWords(['a2'], true);
    const n = dav.log.length;
    const st = await davService().syncNow();
    expect(st.phase, st.notice).toBe('idle');
    expect(dav.seqFrom(n)).toEqual(['GET200', 'UNLOCK204', 'LOCK200', 'PUT204', 'UNLOCK204']);
    expect((await fakeBrowser.storage.local.get(STORAGE_KEYS.webdavLock))[STORAGE_KEYS.webdavLock]).toBeUndefined();
    expect((await remoteKnownAll()).words).toEqual(['a1', 'a2']);
  });

  it('Q3 其他设备的残留锁：提示“被另一设备锁定”而不是“多台设备同时写入”', async () => {
    await enableWebDav();
    await setKnownWords(['a1'], true);
    await davService().syncNow();
    dav.locks.set('/dav/hnw/sub/hnw-sync.json', '<opaquelocktoken:other-dead>');
    await setKnownWords(['a2'], true);
    const st = await davService().syncNow();
    expect(st.phase).toBe('pending');
    expect(st.notice).toMatch(/被另一设备锁定.*60 秒.*秒后自动重试/);
  });
});

describe('B4：WebDAV 定时同步链', () => {
  it('syncNow 第一次 reject 后定时同步不中断，第二个周期仍会执行', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const svc = davService();
      const syncNow = vi
        .spyOn(svc, 'syncNow')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ backend: 'webdav', enabled: true, phase: 'idle', lastSyncAt: 1, lastPullAt: 1, lastPushAt: 1 });
      // armInterval 为私有方法：直接调用以只验证续排逻辑（onStartup 末尾同样调用它）
      (svc as unknown as { armInterval(ms: number): void }).armInterval(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncNow).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[hnw] WebDAV 定时同步失败', expect.any(Error));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncNow).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncNow).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
