import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataLemmatizer, type LemmaDataFile } from '@/core/lemma/data-lemmatizer';
import { getKnownWords } from '@/core/known/store';
import { createDefaultSettings } from '@/core/settings/defaults';
import { MY_WORDS_BOOK_ID } from '@/core/settings/schema';
import { getSettings, patchSettings } from '@/core/settings/store';
import { STORAGE_KEYS } from '@/core/storage/keys';
import type { BackendSyncStatus, SyncStatus } from '@/core/sync/types';
import type { StatusItem } from '@/core/messaging/protocol';
import type { SourceBookIndex } from '@/core/wordbook/types';
import { getLocalBook, patchSourceBookState } from '@/core/wordbook/user-store';
import { lemmaOf, runMenuAction, selectionToWord } from '@/background/context-menu';
import {
  dismissUpdateNotice,
  getStatusSummary,
  recordUpdate,
  resetSyncAllState,
  sourceItem,
  storageSyncItem,
  summarizeSyncAll,
  summaryText,
  syncAll,
  webdavItem,
  worstLevel,
} from '@/background/status';

/**
 * 第二阶段 background：总状态（getStatusSummary / syncAll）、升级提示、选中文本右键菜单。
 */

vi.mock('@/core/lemma', () => ({
  createLemmatizer: () => {
    const l = new DataLemmatizer();
    l.setData(JSON.parse(readFileSync(resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile);
    return l;
  },
}));

const storageSync = (p: Partial<SyncStatus> = {}): SyncStatus => ({ enabled: true, phase: 'idle', deviceId: 'd1', lastPushAt: 0, lastPullAt: 0, ...p });
const webdav = (p: Partial<BackendSyncStatus> = {}): BackendSyncStatus => ({ backend: 'webdav', enabled: false, phase: 'disabled', lastSyncAt: 0, lastPullAt: 0, lastPushAt: 0, ...p });

beforeEach(() => {
  fakeBrowser.reset();
  resetSyncAllState();
});
afterEach(() => vi.unstubAllGlobals());

describe('状态项（纯函数）', () => {
  it('storage.sync：关闭/错误/退避/从未/已同步含超配额说明', () => {
    expect(storageSyncItem(storageSync({ enabled: false, phase: 'disabled' })).level).toBe('off');
    expect(storageSyncItem(storageSync({ phase: 'error', error: '配额不足' }))).toMatchObject({ level: 'error', text: '配额不足' });
    expect(storageSyncItem(storageSync({ phase: 'pending', notice: '写入过于频繁，将于 10:32 自动重试', retryAt: 5 }))).toMatchObject({ level: 'pending', retryAt: 5 });
    expect(storageSyncItem(storageSync()).level).toBe('never');
    const it = storageSyncItem(
      storageSync({
        lastPushAt: 10,
        usage: {
          bytes: 50_000,
          quotaBytes: 102_400,
          items: 20,
          maxItems: 512,
          segments: [
            { id: 'settings', kind: 'settings', label: '设置', bytes: 1, items: 1, state: 'synced' },
            { id: 'lb:x', kind: 'localBooks', label: 'x', bytes: 1, items: 1, state: 'skipped' },
          ],
        },
      }),
    );
    expect(it.level).toBe('ok');
    expect(it.text).toBe('已同步 · 已用 49 KB / 100 KB，1 本本地词书超出配额未同步');
    expect(it.lastSyncAt).toBe(10);
    expect(it.href).toBe('#sync/sync');
  });

  it('WebDAV：未开启 / 未填写 / 未授权 / 已同步', () => {
    const s = createDefaultSettings();
    expect(webdavItem(webdav(), s).level).toBe('off');
    s.sync.webdav.enabled = true;
    expect(webdavItem(webdav(), s)).toMatchObject({ level: 'error', text: '请先填写服务器地址、用户名和密码' });
    Object.assign(s.sync.webdav, { url: 'https://dav.example.com/dav', username: 'u', password: 'p' });
    expect(webdavItem(webdav({ enabled: true, phase: 'idle', lastSyncAt: 3 }), s, false).text).toContain('未授权');
    expect(webdavItem(webdav({ enabled: true, phase: 'idle', lastSyncAt: 3, remoteBytes: 2048 }), s, true)).toMatchObject({ level: 'ok', text: '已同步 · 远端文件 2.0 KB' });
  });

  it('来源：列表失败优先展示来源级原因；部分书失败；生词本与熟词本分开计数；孤儿书不计', () => {
    const idx: SourceBookIndex = {
      books: {
        'src:eudic:1': { id: 'src:eudic:1', providerId: 'eudic', remoteId: '1', name: '测试', status: 'ok', lastSyncAt: 5, lastAttemptAt: 5, wordCount: 3 },
        'src:eudic:mastered': { id: 'src:eudic:mastered', providerId: 'eudic', remoteId: 'mastered', name: '已掌握', role: 'known', status: 'ok', lastSyncAt: 6, lastAttemptAt: 6, wordCount: 800 },
        'src:eudic:-1': { id: 'src:eudic:-1', providerId: 'eudic', remoteId: '-1', name: '旧', orphaned: true, status: 'error', lastSyncAt: 1, lastAttemptAt: 1, wordCount: 9, error: 'x' },
      },
      providers: {},
    };
    expect(sourceItem('eudic', '欧路', idx)).toMatchObject({ level: 'ok', text: '已同步 1 本生词本（3 词）、1 本熟词本', lastSyncAt: 6, href: '#sources' });
    idx.books['src:eudic:1']!.status = 'error';
    idx.books['src:eudic:1']!.error = '网络错误';
    expect(sourceItem('eudic', '欧路', idx).text).toBe('1 本同步失败：网络错误');
    idx.books['src:eudic:mastered']!.status = 'error';
    idx.providers.eudic = { lastListAt: 7, error: '授权失效，请重新填写 token' };
    expect(sourceItem('eudic', '欧路', idx)).toMatchObject({ level: 'error', text: '授权失效，请重新填写 token' });
    // 从未成功同步过的来源失败（默认启用有道但没登录）：显示为尚未同步并附原因，不算错误
    expect(sourceItem('youdao', '有道', { books: {}, providers: { youdao: { lastListAt: 1, error: '未登录有道' } } })).toMatchObject({ level: 'never', text: '未登录有道' });
    expect(sourceItem('youdao', '有道', { books: {}, providers: {} }).level).toBe('never');
  });

  it('总级别与总述', () => {
    expect(worstLevel(['ok', 'off', 'pending'])).toBe('pending');
    expect(worstLevel(['off'])).toBe('off');
    const a = { id: 'a', kind: 'backend' as const, name: 'A', href: '', lastSyncAt: 0 };
    expect(summaryText([{ ...a, level: 'off', text: '' }], 'off')).toBe('未开启任何同步');
    expect(summaryText([{ ...a, level: 'ok', text: '' }, { ...a, name: 'B', level: 'ok', text: '' }], 'ok')).toBe('已全部同步');
    expect(summaryText([{ ...a, level: 'error', text: '401' }], 'error')).toBe('A：401');
  });
});

describe('getStatusSummary / syncAll', () => {
  it('汇总启用的来源与后端，权限 API 不可用时按已授权处理', async () => {
    await patchSettings({ sources: { eudic: { enabled: true }, youdao: { enabled: false } } });
    await patchSourceBookState({ id: 'src:eudic:1', providerId: 'eudic', remoteId: '1', name: '测试' }, { status: 'ok', lastSyncAt: 9, wordCount: 2 });
    const sum = await getStatusSummary({ getStorageSync: async () => storageSync({ lastPullAt: 3 }), getWebDav: async () => webdav() });
    expect(sum.items.map((i) => i.id)).toEqual(['storage-sync', 'webdav', 'source:eudic']);
    expect(sum.level).toBe('ok');
    expect(sum.text).toBe('已全部同步');
    expect(sum.lastSyncAt).toBe(9);
    expect(sum.permissions.allSites).toBe(true);
    expect(sum.permissions.webdavOrigin).toBeUndefined();
  });

  it('未授权访问网站时给出权限提示', async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => false) as never);
    const sum = await getStatusSummary({ getStorageSync: async () => storageSync(), getWebDav: async () => webdav() });
    expect(sum.permissions).toMatchObject({ allSites: false, text: '未授权访问全部网站，只在已授权的网站上高亮' });
  });

  it('syncAll：只调用已启用的后端，任一失败不影响其他项并在文案中说明', async () => {
    await patchSettings({ sources: { youdao: { enabled: true } } });
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
    const s = await getSettings();
    expect(s.sync.enabled).toBe(true);
    let st = storageSync();
    const calls: string[] = [];
    const res = await syncAll({
      getStorageSync: async () => st,
      getWebDav: async () => webdav(),
      syncStorage: async () => {
        calls.push('storage');
        st = storageSync({ lastPushAt: 1 });
        return st;
      },
      syncWebDav: async () => {
        calls.push('webdav');
        return webdav();
      },
      syncSources: async () => {
        calls.push('sources');
        await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'error', error: '未登录有道词典', lastAttemptAt: 1 });
        return [{ bookId: 'src:youdao:0', ok: false, message: '未登录有道词典' }];
      },
    });
    expect(calls.sort()).toEqual(['sources', 'storage']);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('已同步：浏览器账号同步；未完成：有道词典（未登录有道词典）');
    expect(res.summary.level).toBe('never');
    expect(res.sources).toHaveLength(1);
  });

  it('syncAll：全部关闭时提示去开启', async () => {
    await patchSettings({ sync: { enabled: false }, sources: { youdao: { enabled: false } } });
    const res = await syncAll({
      getStorageSync: async () => storageSync({ enabled: false, phase: 'disabled' }),
      getWebDav: async () => webdav(),
      syncStorage: async () => storageSync(),
      syncWebDav: async () => webdav(),
      syncSources: async () => [],
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('未开启任何同步');
  });
});

describe('升级提示', () => {
  it('从旧版本升级时记录，同版本不记录，dismiss 后清除', async () => {
    const version = '3.0.0';
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'x', version });
    await recordUpdate(version);
    expect((await fakeBrowser.storage.local.get(STORAGE_KEYS.updateNotice))[STORAGE_KEYS.updateNotice]).toBeUndefined();
    await recordUpdate('2.0.1');
    const sum = await getStatusSummary({ getStorageSync: async () => storageSync(), getWebDav: async () => webdav() });
    expect(sum.updateNotice).toMatchObject({ from: '2.0.1', to: version });
    await dismissUpdateNotice();
    expect((await getStatusSummary({ getStorageSync: async () => storageSync(), getWebDav: async () => webdav() })).updateNotice).toBeUndefined();
  });
});

describe('右键菜单', () => {
  it('选中文本 → 单个英文单词', () => {
    expect(selectionToWord('  “Running,” ')).toBe('Running');
    expect(selectionToWord("don’t")).toBe("don't");
    expect(selectionToWord('well-known')).toBe('well-known');
    expect(selectionToWord('two words')).toBeUndefined();
    expect(selectionToWord('中文')).toBeUndefined();
    expect(selectionToWord('')).toBeUndefined();
  });

  it('原形取屈折还原，不取派生词根', async () => {
    const l = new DataLemmatizer();
    l.setData(JSON.parse(readFileSync(resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile);
    expect(lemmaOf('running', l)).toBe('run');
    expect(lemmaOf('went', l)).toBe('go');
    expect(lemmaOf('carelessly', l)).toBe('carelessly');
    expect(lemmaOf('news', l)).toBe('news');
  });

  it('加入生词本：写入“我的生词本”原形；标记熟词写入本地熟词本；非单词给出提示', async () => {
    const add = await runMenuAction('add', 'Running');
    expect(add).toMatchObject({ ok: true, word: 'Running', lemma: 'run' });
    expect(Object.keys((await getLocalBook(MY_WORDS_BOOK_ID))!.words)).toEqual(['run']);
    const known = await runMenuAction('known', 'went');
    expect(known).toMatchObject({ ok: true, lemma: 'go' });
    expect((await getKnownWords()).has('go')).toBe(true);
    expect(await runMenuAction('add', 'hello world')).toMatchObject({ ok: false, message: '请只选中一个英文单词' });
  });
});

describe('第二阶段 F2/F3/F5/F7：syncAll 分类、后台受理与锚点', () => {
  const item = (name: string, level: StatusItem['level'], extra: Partial<StatusItem> = {}): StatusItem => ({
    id: name,
    kind: 'backend',
    name,
    level,
    text: level,
    lastSyncAt: 0,
    href: '#sync',
    ...extra,
  });
  const sum = (items: StatusItem[]) => ({ level: 'ok' as const, text: '', lastSyncAt: 0, items, permissions: { allSites: true } });

  it('pending 单独归为“等待同步（约 N 秒/分钟后自动完成）”，ok=true 但 complete=false', () => {
    const now = 1_000_000;
    const r = summarizeSyncAll(sum([item('浏览器账号同步', 'pending', { retryAt: now + 30_000 }), item('WebDAV', 'pending', { retryAt: now + 125_000 }), item('有道词典', 'ok')]), undefined, now);
    expect(r.message).toBe('已同步：有道词典；等待同步：浏览器账号同步（约 30 秒后自动完成）、WebDAV（约 3 分钟后自动完成）');
    expect(r).toMatchObject({ ok: true, complete: false });
    expect(summarizeSyncAll(sum([item('有道词典', 'ok')]))).toMatchObject({ ok: true, complete: true, message: '已同步：有道词典' });
  });

  it('busy 单独归为“仍在同步”，只要有启用项 message 就不为空', () => {
    const r = summarizeSyncAll(sum([item('欧路词典', 'busy')]));
    expect(r.message).toBe('仍在同步：欧路词典');
    expect(r).toMatchObject({ ok: true, complete: false });
    for (const level of ['ok', 'pending', 'busy', 'error', 'never'] as const) expect(summarizeSyncAll(sum([item('X', level)])).message).not.toBe('');
  });

  it('background=true 立即返回已受理；进行中 getStatusSummary.syncAll.running=true；完成后带结果；重复调用复用同一次', async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
    await patchSettings({ sources: { youdao: { enabled: false } } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let storageCalls = 0;
    const deps = {
      getStorageSync: async () => storageSync({ lastPushAt: storageCalls ? 5 : 0 }),
      getWebDav: async () => webdav(),
      syncStorage: async () => {
        storageCalls++;
        await gate;
        return storageSync({ lastPushAt: 5 });
      },
      syncWebDav: async () => webdav(),
      syncSources: async () => [],
    };
    const accepted = await syncAll(deps, { background: true });
    expect(accepted).toMatchObject({ accepted: true, complete: false });
    expect(accepted.message).toContain('后台继续');
    expect(accepted.summary.syncAll).toMatchObject({ running: true });
    await syncAll(deps, { background: true });
    expect(storageCalls).toBe(1);
    expect((await getStatusSummary(deps)).syncAll).toMatchObject({ running: true });
    release();
    await vi.waitFor(async () => expect((await getStatusSummary(deps)).syncAll?.running).toBe(false));
    expect((await getStatusSummary(deps)).syncAll!.result).toMatchObject({ ok: true, complete: true, message: '已同步：浏览器账号同步' });
  });

  it('B1：全部同步项关闭 + background=true 时同步在受理前就结束，不抛异常且返回 accepted=true', async () => {
    await patchSettings({ sync: { enabled: false }, sources: { youdao: { enabled: false }, eudic: { enabled: false } } });
    let summaryCalls = 0;
    const deps = {
      // 第一次读状态来自 background 分支：故意拖慢，确保 runSyncAll 先完成并清空进行中标记（真实 Chromium 中的时序）
      getStorageSync: async () => {
        if (summaryCalls++ === 0) await new Promise((r) => setTimeout(r, 20));
        return storageSync({ enabled: false, phase: 'disabled' });
      },
      getWebDav: async () => webdav(),
      syncStorage: async () => storageSync(),
      syncWebDav: async () => webdav(),
      syncSources: async () => [],
    };
    const res = await syncAll(deps, { background: true });
    expect(res).toMatchObject({ accepted: true, ok: true });
    expect(typeof res.startedAt).toBe('number');
    expect(res.startedAt).toBeGreaterThan(0);
    // 后台那一次已完成：总状态带上结果
    expect((await getStatusSummary(deps)).syncAll).toMatchObject({ running: false, result: { ok: true } });
  });

  it('WebDAV 状态项指向 #sync/webdav，浏览器账号同步指向 #sync/sync', () => {
    const s = createDefaultSettings();
    s.sync.webdav = { ...s.sync.webdav, enabled: true };
    expect(webdavItem(webdav({ enabled: true }), s).href).toBe('#sync/webdav');
    expect(storageSyncItem(storageSync()).href).toBe('#sync/sync');
  });
});

describe('第二阶段 F4：右键菜单拒绝含非英文字母的词', () => {
  it('café / fiancé 不截断、不写入任何词书并提示', async () => {
    expect(selectionToWord('café')).toBeUndefined();
    expect(selectionToWord('“fiancé.”')).toBeUndefined();
    for (const w of ['café', 'fiancé']) {
      const r = await runMenuAction('add', w);
      expect(r).toMatchObject({ ok: false });
      expect(r.message).toContain('非英文字母');
    }
    expect(await runMenuAction('known', 'café')).toMatchObject({ ok: false });
    expect(await getLocalBook(MY_WORDS_BOOK_ID)).toBeUndefined();
    expect((await getKnownWords()).size).toBe(0);
  });
});

describe('移动端没有 contextMenus', () => {
  it('contextMenus 为 undefined 时后台初始化不抛错，总状态与同步消息正常', async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
    const desc = Object.getOwnPropertyDescriptor(fakeBrowser, 'contextMenus');
    Object.defineProperty(fakeBrowser, 'contextMenus', { value: undefined, configurable: true, writable: true });
    try {
      const { setupBackground } = await import('@/background/index');
      expect(() => setupBackground()).not.toThrow();
      const { sendToBackground } = await import('@/core/messaging');
      const summary = await sendToBackground('getStatusSummary', {});
      expect(summary.items[0]).toMatchObject({ id: 'storage-sync' });
      const res = await sendToBackground('syncAll', {});
      expect(res.message).not.toBe('');
    } finally {
      if (desc) Object.defineProperty(fakeBrowser, 'contextMenus', desc);
    }
  });
});

describe('B2：openOptions 消息（悬浮球“完整设置”“去处理”）', () => {
  /** 与悬浮球 openOptionsPage 相同的原始信封发送方式，按响应 ok 判断成功 */
  const send = (data: unknown) => fakeBrowser.runtime.sendMessage({ ns: 'hnw', type: 'openOptions', data }) as Promise<{ ok: boolean; error?: string } | undefined>;

  beforeEach(async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
    const { setupBackground } = await import('@/background/index');
    setupBackground();
  });

  it('不带 hash：调用 runtime.openOptionsPage，不新开标签页', async () => {
    const openPage = vi.fn(async () => {});
    vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockImplementation(openPage);
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    for (const data of [{}, { hash: '' }, { hash: '#' }]) expect(await send(data)).toMatchObject({ ok: true });
    expect(openPage).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
  });

  it('带 hash：新标签页打开 options.html#hash（前导 # 可有可无）', async () => {
    const openPage = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockImplementation(async () => {});
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation((async () => ({})) as never);
    expect(await send({ hash: 'sync/webdav' })).toMatchObject({ ok: true });
    expect(await send({ hash: '#sources' })).toMatchObject({ ok: true });
    const base = fakeBrowser.runtime.getURL('/options.html' as '/');
    expect(create.mock.calls.map(([p]) => (p as { url: string }).url)).toEqual([`${base}#sync/webdav`, `${base}#sources`]);
    expect(openPage).not.toHaveBeenCalled();
  });

  it('打开失败时响应 ok=false（悬浮球据此提示从扩展菜单进入）', async () => {
    vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockImplementation(async () => {
      throw new Error('no options page');
    });
    expect(await send({})).toMatchObject({ ok: false, error: 'no options page' });
  });
});
