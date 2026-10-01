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
 * - 服务器不返回 ETag 时退化为“写前再 GET 一次比较内容哈希”（仍有极小竞态窗口，合并幂等可在下次同步修复）
 * - 目录不存在时逐级 MKCOL（坚果云要求先建目录才能 PUT，405 表示已存在）
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

/** 最小 WebDAV 客户端（只用 PROPFIND / MKCOL / GET / PUT / DELETE） */
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

  /** 逐级确保目录存在（PROPFIND 不存在则 MKCOL；MKCOL 405 = 已存在） */
  async ensureDirs(): Promise<string[]> {
    const created: string[] = [];
    for (const dir of webdavPaths(this.cfg).dirs) {
      const st = await this.propfind(dir);
      if (st === 207 || st === 200) continue;
      if (st !== 404) throw webdavError(st, dir);
      const res = await this.request('MKCOL', dir);
      if (res.status === 201) created.push(dir);
      else if (res.status !== 405) throw webdavError(res.status, dir);
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

  /** PUT 文件；ifMatch=null 表示要求文件不存在（If-None-Match: *）；412 抛 SyncConflictError */
  async put(url: string, body: string, ifMatch: string | null | undefined): Promise<string | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    else if (ifMatch === null) headers['If-None-Match'] = '*';
    const res = await this.request('PUT', url, { headers, body });
    if (res.status === 412) throw new SyncConflictError('WebDAV 上的同步文件刚被其他设备修改');
    if (!res.ok) throw webdavError(res.status, url);
    return res.headers.get('ETag');
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

export class WebDavBackend implements SyncBackend {
  readonly id = 'webdav' as const;
  readonly client: WebDavClient;
  /** 本轮已确认目录存在（避免每次同步都 PROPFIND 目录） */
  private dirsReady = false;

  constructor(cfg: WebDavConfig, fetchImpl?: typeof fetch) {
    this.client = new WebDavClient(cfg, fetchImpl);
  }

  private get fileUrl(): string {
    return webdavPaths(this.client.cfg).file;
  }

  async read(): Promise<WebDavSnapshot> {
    const got = await this.client.get(this.fileUrl);
    if (!got) return { version: null, etag: null, segs: {}, readSegment: async () => undefined, bytes: 0 };
    const file = parseFile(got.text);
    // 文件损坏（非本扩展格式）：按空远端处理，但版本仍为当前 ETag，写入时 If-Match 覆盖它
    const etag = got.etag ?? '';
    const version = got.etag ?? `h:${await shortHash(got.text)}`;
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
    let ifMatch: string | null | undefined;
    if (snap.etag === null) ifMatch = null;
    else if (snap.etag) ifMatch = snap.etag;
    else {
      // 服务器不提供 ETag：写前重新读取比较内容哈希
      const cur = await this.client.get(this.fileUrl);
      const curVersion = cur ? (cur.etag ?? `h:${await shortHash(cur.text)}`) : null;
      if (curVersion !== base.version) throw new SyncConflictError('WebDAV 上的同步文件刚被其他设备修改');
      ifMatch = undefined;
    }
    let etag: string | null;
    try {
      etag = await this.client.put(this.fileUrl, body, ifMatch);
    } catch (e) {
      // 目录被删除（409/404）：重建目录后重试一次
      if (e instanceof SyncBackendError && e.code === 'notfound') {
        await this.client.ensureDirs();
        etag = await this.client.put(this.fileUrl, body, ifMatch);
      } else throw e;
    }
    return { wrote: true, version: etag ?? `h:${await shortHash(body)}`, writeOps: 1 };
  }

  async getUsage(): Promise<{ bytes: number }> {
    return { bytes: (await this.read()).bytes ?? 0 };
  }
}
