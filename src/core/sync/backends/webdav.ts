import { SyncBackendError, SyncConflictError, type BackendWriteResult, type RemoteSnapshot, type SyncBackend } from '../backend';
import { shortHash } from '../codec';
import type { SyncPlan } from '../plan';
import type { ManifestSegment, SegmentCandidate, SegmentUsage } from '../types';

/**
 * WebDAV 同步后端（坚果云、Nextcloud、群晖、Apache/nginx dav 等）。
 *
 * 远端只有一个文件 `<url>/<dir>/hnw-sync.json`（WebDavSnapshotFile），整体 GET / PUT：
 * - 读：GET，记下 ETag（没有 ETag 的服务器用内容哈希作为版本）
 * - 写：PUT 带 `If-Match: <etag>`（文件已存在）或 `If-None-Match: *`（首次创建）；服务器返回 412 表示别的设备刚写过 →
 *   SyncConflictError，调用方重新拉取、合并后重试
 * - 写入全程持有 WebDAV class 2 排他写锁（LOCK → [GET 比较] → PUT 带 `If: (<锁令牌>)` → UNLOCK）：
 *   Apache mod_dav 的 If-Match 检查与写入之间没有原子性，且同一秒内修改过的文件只返回弱 ETag（不能用于 If-Match），
 *   两台设备同一秒同步时“比较 GET → 无条件 PUT”会互相覆盖（第 3 轮真实 Apache 12 轮丢 11 轮）。持锁期间其他设备的
 *   LOCK/PUT 得到 423，按冲突处理：随机退避后重新拉取、合并、再写。
 * - 弱 ETag / 无 ETag：持锁后重新 GET 比较内容哈希，与 read 时一致才 PUT
 * - 服务器不支持 LOCK（405/501 等 4xx）：退化为“写后回读校验”（强 ETag 也做，If-Match 在 Apache 上不是原子的）——PUT 后
 *   随机等待 300–1500 ms 再 GET，内容与自己写入的不一致说明被并发写入覆盖，按冲突重新拉取合并再写；校验通过前不算
 *   写入成功；另外 5–15 秒后再同步一轮复查（覆盖对方 PUT 比本机回读还慢落地的情况，复查时间由调用方持久化）。
 *   LOCK 返回 500/502/504 属于瞬时错误：本轮退避重试，仍失败则报服务器错误，不判定为“不支持锁”
 * - 本机持有的锁令牌持久化（WebDavLockStore）：SW 在持锁时被回收，重启后的第一次写入先 UNLOCK 自己的残留锁，
 *   不必等锁超时
 * - 目录：远端文件存在（read 得到 200）即说明目录存在，不再 PROPFIND；文件不存在时先 PROPFIND 最深一级目录，
 *   不存在才自顶向下逐级 MKCOL（坚果云要求先建目录才能 PUT）；MKCOL 返回 403/405 时再 PROPFIND 一次，目录已存在
 *   （并发建目录时 Apache 对较晚的请求返回 403）视为成功
 * - 目录在网盘端被删除/移动：LOCK、PUT、回读 GET 任一步返回 404/409（或 PUT 403 且目录确实不存在，Apache 的行为）时清除“目录已存在”缓存，逐级 MKCOL 后整次写入
 *   （LOCK → 比较 → PUT → UNLOCK）重试一次（第 4 轮 J1：之前只包住了 PUT，LOCK 409 时 SW 存活期间一直报路径不存在）
 *
 * 认证用 HTTP Basic（Authorization 头，UTF-8 编码），credentials: 'omit' 不带浏览器 cookie。
 * 主机权限：chrome 产物的 host_permissions 已覆盖 http/https；Firefox 等可撤销主机权限的浏览器由 options 在“测试连接”
 * 点击时 requestOriginAccess(url) 运行时申请，background 同步前用 hasOriginAccess 检查（见 background/webdav.ts）。
 */

export const WEBDAV_FILE_NAME = 'hnw-sync.json';

/** 远端文件结构：段目录与段数据放在一起，保证一次 PUT 原子替换 */
export interface WebDavSnapshotFile {
  format: 'hnw-sync';
  v: 1;
  device: string;
  at: number;
  segs: Record<string, ManifestSegment & { d: string }>;
}

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  dir: string;
}

/** 规范化：url 补尾部 /；dir 去首尾 /，多级目录逐段编码 */
export function webdavPaths(cfg: Pick<WebDavConfig, 'url' | 'dir'>): { base: string; dirs: string[]; file: string } {
  const base = cfg.url.trim().replace(/\/*$/, '/');
  const segs = cfg.dir
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(encodeURIComponent);
  const dirs = segs.map((_, i) => base + segs.slice(0, i + 1).join('/') + '/');
  return { base, dirs, file: (dirs[dirs.length - 1] ?? base) + WEBDAV_FILE_NAME };
}

function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

/** HTTP 状态码 -> 给用户看的错误 */
export function webdavError(status: number, what: string): SyncBackendError {
  if (status === 401) return new SyncBackendError('WebDAV 用户名或密码错误（坚果云等需使用“应用密码”）', 'auth', status);
  if (status === 403) return new SyncBackendError(`WebDAV 拒绝访问${what}（无权限或应用密码只读）`, 'permission', status);
  if (status === 404 || status === 409) return new SyncBackendError(`WebDAV 路径不存在：${what}`, 'notfound', status);
  if (status === 423) return new SyncBackendError(`WebDAV 文件被锁定：${what}，稍后重试`, 'server', status);
  if (status === 429 || status === 503) return new SyncBackendError('WebDAV 服务器限制请求频率（坚果云免费版每 30 分钟有请求次数上限），稍后自动重试', 'ratelimit', status);
  if (status === 507) return new SyncBackendError('WebDAV 存储空间不足', 'quota', status);
  return new SyncBackendError(`WebDAV 请求失败（HTTP ${status}）：${what}`, 'server', status);
}

/**
 * 写锁超时：持锁期间只做一次 GET + PUT（锁只在请求开始时检查，慢网络上传大文件超过超时也不影响本次 PUT）。
 * 本机 SW 在持锁时被回收：重启后用持久化的令牌主动 UNLOCK；其他设备的残留锁最多 60 秒后由服务器自动释放，
 * 期间本机按“被锁定”退避、稍后自动重试
 */
export const WEBDAV_LOCK_TIMEOUT_S = 60;

/**
 * LOCK 结果：token 为 `<opaquelocktoken:…>`（含尖括号，可直接放进 If / Lock-Token 头）；locked = 被其他设备持有（423）；
 * unsupported = 服务器不支持锁（405/501 等）；transient = 服务器瞬时错误（500/502/504），下次还应尝试加锁
 */
export type WebDavLockResult = { token: string } | { locked: true } | { unsupported: true } | { transient: number };

/** 本机持有的写锁（持久化到 storage.local，SW 重启后据此释放残留锁） */
export interface WebDavHeldLock {
  url: string;
  token: string;
  at: number;
}

/** 锁令牌持久化（background 用 storage.local 实现；不传时只在内存中，SW 重启后丢失） */
export interface WebDavLockStore {
  load(): Promise<WebDavHeldLock | undefined>;
  save(lock: WebDavHeldLock | undefined): Promise<void>;
}

/** 同步文件被其他设备（或本机中断的同步）锁定：按冲突退避重试，调用方据此给出“被锁定”的提示 */
export class WebDavLockedError extends SyncConflictError {
  constructor() {
    super('WebDAV 上的同步文件正被其他设备写入（已锁定）');
    this.name = 'WebDavLockedError';
  }
}

const isNotFound = (e: unknown) => e instanceof SyncBackendError && e.code === 'notfound';

/** 最小 WebDAV 客户端（只用 PROPFIND / MKCOL / GET / PUT / DELETE / LOCK / UNLOCK） */
export class WebDavClient {
  constructor(
    readonly cfg: WebDavConfig,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async request(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { Authorization: basicAuth(this.cfg.username, this.cfg.password), ...init.headers },
        body: init.body,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e) {
      throw new SyncBackendError(`无法连接 WebDAV 服务器（${new URL(url).host}）：${e instanceof Error ? e.message : String(e)}`, 'network');
    }
  }

  /** PROPFIND Depth:0：集合/文件是否存在；返回状态码（207 存在、404 不存在） */
  async propfind(url: string): Promise<number> {
    const res = await this.request('PROPFIND', url, {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>',
    });
    return res.status;
  }

  /**
   * 确保同步目录存在，返回新建的目录。
   * knownMissing=false：先 PROPFIND 最深一级（已存在时只需 1 个请求），不存在再自顶向下 MKCOL；
   * knownMissing=true（LOCK/PUT 刚返回 404/409）：直接自顶向下 MKCOL。MKCOL 201 = 新建，405 = 已存在
   */
  async ensureDirs(knownMissing = false): Promise<string[]> {
    const dirs = webdavPaths(this.cfg).dirs;
    if (!dirs.length) return [];
    if (!knownMissing) {
      const deepest = dirs[dirs.length - 1]!;
      const st = await this.propfind(deepest);
      if (st === 207 || st === 200) return [];
      if (st !== 404) throw webdavError(st, deepest);
    }
    const created: string[] = [];
    for (const dir of dirs) {
      const res = await this.request('MKCOL', dir);
      if (res.status === 201) {
        created.push(dir);
        continue;
      }
      // 405 Method Not Allowed：集合已存在（RFC 4918 9.3.1）
      if (res.status === 405) continue;
      // 403/405：可能是另一台设备刚并发建好了目录（Apache 对较晚的并发 MKCOL 返回 403，2026-10 docker 实测
      // 4 个并发 MKCOL 得到 403 403 403 201），再查一次，确实不存在才报错
      if (res.status === 403) {
        const again = await this.propfind(dir);
        if (again === 207 || again === 200) continue;
      }
      throw webdavError(res.status, dir);
    }
    return created;
  }

  /** GET 文件：不存在返回 undefined */
  async get(url: string): Promise<{ text: string; etag: string | null } | undefined> {
    const res = await this.request('GET', url);
    if (res.status === 404) return undefined;
    if (!res.ok) throw webdavError(res.status, url);
    return { text: await res.text(), etag: res.headers.get('ETag') };
  }

  /**
   * PUT 文件；ifMatch=null 表示要求文件不存在（If-None-Match: *）；lockToken 为本设备持有的写锁。
   * 412（版本不符）与 423（被其他设备锁定）抛 SyncConflictError，由调用方重新拉取合并后重试
   */
  async put(url: string, body: string, ifMatch: string | null | undefined, lockToken?: string): Promise<string | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    else if (ifMatch === null) headers['If-None-Match'] = '*';
    if (lockToken) headers.If = `(${lockToken})`;
    const res = await this.request('PUT', url, { headers, body });
    if (res.status === 412) throw new SyncConflictError('WebDAV 上的同步文件刚被其他设备修改');
    if (res.status === 423) throw new WebDavLockedError();
    if (!res.ok) throw webdavError(res.status, url);
    return res.headers.get('ETag');
  }

  /**
   * LOCK：对文件加排他写锁（文件不存在时服务器创建“锁定的空资源”，Apache 对它 GET 仍返回 404）。
   * 不支持锁的服务器（405/501/400/403/415/422 等 4xx）返回 unsupported，调用方退化为写后回读校验；
   * 500/502/504 是瞬时错误（返回 transient，不能据此判定不支持锁，第 4 轮 Q2）；404/409（目录不存在）等抛错
   */
  async lock(url: string, owner: string): Promise<WebDavLockResult> {
    const res = await this.request('LOCK', url, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Timeout: `Second-${WEBDAV_LOCK_TIMEOUT_S}`, Depth: '0' },
      body:
        '<?xml version="1.0" encoding="utf-8"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope>' +
        `<d:locktype><d:write/></d:locktype><d:owner>${owner.replace(/[<>&]/g, '')}</d:owner></d:lockinfo>`,
    });
    if (res.status === 423) return { locked: true };
    if ([401, 404, 409, 429, 503, 507].includes(res.status)) throw webdavError(res.status, url);
    if (res.status === 501) return { unsupported: true };
    if (res.status >= 500) return { transient: res.status };
    if (!res.ok) return { unsupported: true };
    // 令牌优先取 Lock-Token 响应头，取不到时从响应体 <d:locktoken><d:href> 解析
    const header = res.headers.get('Lock-Token')?.trim();
    if (header) return { token: header.startsWith('<') ? header : `<${header}>` };
    const href = /<(?:\w+:)?locktoken>\s*<(?:\w+:)?href>\s*([^<\s]+)\s*</i.exec(await res.text())?.[1];
    return href ? { token: `<${href}>` } : { unsupported: true };
  }

  /**
   * UNLOCK：尽力释放（失败也没关系，锁会超时自动释放）。返回 false 表示网络/服务器错误、锁可能仍在（调用方保留持久化的
   * 令牌，下次再释放）；4xx（锁已过期、令牌不存在、文件已删除）视为已释放
   */
  async unlock(url: string, token: string): Promise<boolean> {
    try {
      const res = await this.request('UNLOCK', url, { headers: { 'Lock-Token': token } });
      return res.status < 500;
    } catch (e) {
      console.warn('[hnw] WebDAV 解锁失败（锁会超时自动释放）', e);
      return false;
    }
  }

  async delete(url: string): Promise<void> {
    const res = await this.request('DELETE', url);
    if (!res.ok && res.status !== 404) throw webdavError(res.status, url);
  }
}

interface WebDavSnapshot extends RemoteSnapshot {
  /** 读取时的 ETag；null = 文件不存在；'' = 服务器不提供 ETag（用内容哈希作版本） */
  etag: string | null;
  file?: WebDavSnapshotFile;
}

function parseFile(text: string): WebDavSnapshotFile | undefined {
  try {
    const f = JSON.parse(text) as WebDavSnapshotFile;
    return f && f.format === 'hnw-sync' && f.segs && typeof f.segs === 'object' ? f : undefined;
  } catch {
    return undefined;
  }
}

/** 远端内容版本：强 ETag 优先，否则内容哈希；文件不存在为 null */
async function versionOf(got: { text: string; etag: string | null } | undefined): Promise<string | null> {
  if (!got) return null;
  const strong = got.etag && !got.etag.startsWith('W/') ? got.etag : null;
  return strong ?? `h:${await shortHash(got.text)}`;
}

/** 模块加载时取到的 setTimeout：退避/回读等待不受测试或页面替换的计时器影响 */
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const defaultSleep = (ms: number) => new Promise<void>((r) => nativeSetTimeout(r, ms));
const randomBetween = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

export interface WebDavBackendOptions {
  fetchImpl?: typeof fetch;
  /** 等待实现（测试注入以免真实等待） */
  sleep?: (ms: number) => Promise<void>;
  /** 锁令牌持久化（SW 重启后释放本机残留锁） */
  lockStore?: WebDavLockStore;
}

/** LOCK 瞬时错误（500/502/504）在一次写入内的最多尝试次数 */
const LOCK_TRANSIENT_ATTEMPTS = 3;

export class WebDavBackend implements SyncBackend {
  readonly id = 'webdav' as const;
  readonly client: WebDavClient;
  /** 已确认目录存在（避免每次同步都 PROPFIND 目录）；任何 404/409 都会清除，下一次写入重新确认/重建 */
  private dirsReady = false;
  /** 服务器是否支持 LOCK：undefined = 未探测；false（405/501 等）后本实例不再尝试，改用写后回读校验 */
  private lockSupported?: boolean;
  /** 本实例是否已检查过持久化的残留锁（每个 SW 生命周期只检查一次） */
  private staleLockChecked = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockStore?: WebDavLockStore;

  constructor(cfg: WebDavConfig, opts: WebDavBackendOptions | typeof fetch = {}) {
    // 兼容旧签名 new WebDavBackend(cfg, fetchImpl)
    const o = typeof opts === 'function' ? { fetchImpl: opts } : opts;
    this.client = new WebDavClient(cfg, o.fetchImpl);
    this.sleep = o.sleep ?? defaultSleep;
    this.lockStore = o.lockStore;
  }

  private get fileUrl(): string {
    return webdavPaths(this.client.cfg).file;
  }

  async read(): Promise<WebDavSnapshot> {
    const got = await this.client.get(this.fileUrl);
    // 同步文件存在 => 目录一定存在，写入前不必再 PROPFIND（手机上每次同步少一次往返）
    if (got) this.dirsReady = true;
    if (!got) return { version: null, etag: null, segs: {}, readSegment: async () => undefined, bytes: 0 };
    const file = parseFile(got.text);
    // 文件损坏（非本扩展格式）：按空远端处理，但版本仍为当前 ETag，写入时 If-Match 覆盖它。
    // 弱 ETag（W/"…"）不能用于 If-Match（RFC 9110 要求强比较，服务器必回 412）：Apache 在文件修改的同一秒内返回弱 ETag
    // （2026-10 docker bytemark/webdav 实测），此时按“无 ETag”处理，写前重新 GET 比较内容哈希
    const strong = got.etag && !got.etag.startsWith('W/') ? got.etag : null;
    const etag = strong ?? '';
    const version = await versionOf(got);
    const segs: Record<string, ManifestSegment> = {};
    for (const [id, seg] of Object.entries(file?.segs ?? {})) {
      const { d: _d, ...meta } = seg;
      segs[id] = meta;
    }
    if (got.text && !file) console.warn('[hnw] WebDAV 同步文件不是本扩展格式，将被覆盖');
    return {
      version,
      etag,
      file,
      segs,
      bytes: new TextEncoder().encode(got.text).length,
      readSegment: async (id) => {
        const seg = file?.segs[id];
        if (!seg || typeof seg.d !== 'string') return undefined;
        if ((await shortHash(seg.d)) !== seg.h) {
          console.warn('[hnw] WebDAV 段哈希不一致，跳过', id);
          return undefined;
        }
        return seg.d;
      },
    };
  }

  async list(): Promise<{ version: string | null; segs: Record<string, ManifestSegment> }> {
    const r = await this.read();
    return { version: r.version, segs: r.segs };
  }

  /** WebDAV 没有容量限制：每段取第一个（完整）变体 */
  plan(candidates: SegmentCandidate[], _base: RemoteSnapshot, kept: Record<string, ManifestSegment>): SyncPlan {
    const segments = candidates.map((c) => {
      const v = c.variants[0]!;
      return { id: c.id, entry: { kind: c.kind, n: 1, at: c.at, level: v.level }, encoded: v.encoded, chunks: [v.encoded] };
    });
    const usage: SegmentUsage[] = [
      ...Object.entries(kept).map(([id, s]) => ({ id, kind: s.kind, label: id, bytes: 0, items: 1, state: 'kept' as const })),
      ...segments.map((p, i) => ({ id: p.id, kind: p.entry.kind, label: candidates[i]!.label, bytes: p.encoded.length, items: 1, state: 'synced' as const })),
    ];
    const bytes = segments.reduce((s, p) => s + p.encoded.length, 0);
    return { segments, kept, usage: { bytes, quotaBytes: 0, items: segments.length, maxItems: 0, segments: usage } };
  }

  async write(plan: SyncPlan, base: RemoteSnapshot, deviceId: string): Promise<BackendWriteResult> {
    const snap = base as WebDavSnapshot;
    const segs: WebDavSnapshotFile['segs'] = {};
    // 保留段：原样带上远端数据
    for (const [id, meta] of Object.entries(plan.kept)) {
      const d = snap.file?.segs[id]?.d;
      if (typeof d === 'string') segs[id] = { ...meta, d };
    }
    for (const p of plan.segments) segs[p.id] = { ...p.entry, h: await shortHash(p.encoded), d: p.encoded };
    // 内容无变化不写（段目录与哈希一致）
    const same =
      snap.file &&
      Object.keys(segs).length === Object.keys(snap.file.segs).length &&
      Object.entries(segs).every(([id, s]) => snap.file!.segs[id]?.h === s.h && snap.file!.segs[id]?.at === s.at && snap.file!.segs[id]?.level === s.level);
    if (same) return { wrote: false, version: base.version, writeOps: 0 };

    if (!this.dirsReady) {
      await this.client.ensureDirs();
      this.dirsReady = true;
    }
    const body = JSON.stringify({ format: 'hnw-sync', v: 1, device: deviceId, at: Date.now(), segs } satisfies WebDavSnapshotFile);
    const url = this.fileUrl;
    await this.releaseStaleLock(url);

    let res: { etag: string | null; locked: boolean };
    try {
      res = await this.writeOnce(url, body, snap, deviceId);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      // 同步目录在网盘端被删除/移动（LOCK/PUT 返回 409、回读 404 等）：清除缓存，逐级重建目录后整次写入重试一次
      console.info('[hnw] WebDAV 同步目录不存在，重建后重试');
      this.dirsReady = false;
      await this.client.ensureDirs(true);
      this.dirsReady = true;
      res = await this.writeOnce(url, body, snap, deviceId);
    }
    const { etag, locked } = res;
    const version = etag && !etag.startsWith('W/') ? etag : `h:${await shortHash(body)}`;
    // 无锁：其他设备较慢的 PUT（大文件、慢网络）可能在本机回读之后才落地，建议稍后再同步一轮复查
    if (!locked) return { wrote: true, version, writeOps: 1, recheckAfterMs: randomBetween(5_000, 15_000) };
    return { wrote: true, version, writeOps: 1 };
  }

  /**
   * 一次完整写入：[LOCK] → [锁内比较 GET] → PUT → [UNLOCK] / 无锁时 PUT 后回读校验。
   * 目录不存在（404/409）时抛 notfound 的 SyncBackendError，由 write 重建目录后重试
   */
  private async writeOnce(url: string, body: string, snap: WebDavSnapshot, deviceId: string): Promise<{ etag: string | null; locked: boolean }> {
    // 1. 加写锁（服务器支持时）：持锁期间其他设备的 LOCK/PUT 都得到 423，“比较 → 写入”才是原子的
    const lockToken = this.lockSupported === false ? undefined : await this.acquireLock(url, deviceId);

    let etag: string | null;
    try {
      // 2. 无强 ETag（弱 ETag / 不提供 ETag / 文件不存在）：重新读取比较内容版本（持锁时在锁内比较）
      if (!snap.etag) {
        const curVersion = await versionOf(await this.client.get(url));
        if (curVersion !== snap.version) throw new SyncConflictError('WebDAV 上的同步文件刚被其他设备修改');
      }
      // 强 ETag 用 If-Match；文件不存在用 If-None-Match: *；弱/无 ETag 只靠锁内比较（或写后回读校验）
      const ifMatch = snap.etag ? snap.etag : snap.version === null ? null : undefined;
      try {
        etag = await this.client.put(url, body, ifMatch, lockToken);
      } catch (e) {
        // Apache（bytemark/webdav 实测）对父目录不存在的 PUT 返回 403 而不是 409：确认目录确实不存在时按 notfound 处理（重建目录）
        if (e instanceof SyncBackendError && e.status === 403 && (await this.syncDirMissing())) throw webdavError(404, url);
        throw e;
      }
    } catch (e) {
      if (isNotFound(e)) this.dirsReady = false;
      throw e;
    } finally {
      if (lockToken && (await this.client.unlock(url, lockToken))) await this.lockStore?.save(undefined);
    }

    // 3. 没有锁：写后回读校验。强 ETag 也要校验——Apache 的 If-Match 检查与写入不是原子的，两台设备同时带同一个
    //    强 ETag PUT 会都返回 204（2026-10 docker 无锁代理实测）。随机等待让同时写入的另一台设备的 PUT 先落地，
    //    回读内容不是自己写的说明被覆盖（对方可能没合并本机数据），按冲突重新拉取合并再写；校验通过前不算成功
    if (!lockToken) {
      await this.sleep(randomBetween(300, 1500));
      const after = await this.client.get(url);
      if (!after) {
        // 回读 404：文件或目录刚被删除（网盘端操作），下一次写入重新确认目录
        this.dirsReady = false;
        throw new SyncConflictError('WebDAV 上的同步文件写入后被删除');
      }
      if ((await shortHash(after.text)) !== (await shortHash(body))) {
        throw new SyncConflictError('WebDAV 上的同步文件写入后被其他设备覆盖');
      }
    }
    return { etag, locked: !!lockToken };
  }

  /**
   * 加写锁：返回令牌；服务器不支持锁返回 undefined（之后本实例不再尝试）。
   * 423 → 随机退避后抛 WebDavLockedError（按冲突重试）；500/502/504 → 退避重试，仍失败抛服务器错误（不降级为无锁）
   */
  private async acquireLock(url: string, deviceId: string): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      const lock = await this.client.lock(url, `hnw:${deviceId}`);
      if ('token' in lock) {
        this.lockSupported = true;
        await this.lockStore?.save({ url, token: lock.token, at: Date.now() });
        return lock.token;
      }
      if ('unsupported' in lock) {
        this.lockSupported = false;
        return undefined;
      }
      // 其他设备正在写：随机退避后按冲突处理（runSyncCycle 重新拉取合并再写），错开双方下一次加锁
      await this.sleep(randomBetween(300, 1500));
      if ('locked' in lock) throw new WebDavLockedError();
      if (attempt >= LOCK_TRANSIENT_ATTEMPTS) throw webdavError(lock.transient, url);
    }
  }

  /** 同步目录（最深一级）是否不存在 */
  private async syncDirMissing(): Promise<boolean> {
    const { base, dirs } = webdavPaths(this.client.cfg);
    return (await this.client.propfind(dirs[dirs.length - 1] ?? base)) === 404;
  }

  /** SW 重启后第一次写入前：释放本机上次持有、因 SW 被回收没来得及 UNLOCK 的锁（同一文件才释放） */
  private async releaseStaleLock(url: string): Promise<void> {
    if (this.staleLockChecked || !this.lockStore) return;
    this.staleLockChecked = true;
    const held = await this.lockStore.load();
    if (!held) return;
    if (held.url !== url || Date.now() - held.at > WEBDAV_LOCK_TIMEOUT_S * 1000) {
      // 地址已变更或锁早已超时：只清除记录
      await this.lockStore.save(undefined);
      return;
    }
    console.info('[hnw] 释放上次同步中断留下的 WebDAV 写锁');
    if (await this.client.unlock(url, held.token)) await this.lockStore.save(undefined);
  }

  async getUsage(): Promise<{ bytes: number }> {
    return { bytes: (await this.read()).bytes ?? 0 };
  }
}
