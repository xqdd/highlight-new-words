import { browser } from 'wxt/browser';
import { hasOriginAccess } from '../platform/permissions';
import type { Settings, WebDavSettings } from '../settings/schema';
import { getSettings } from '../settings/store';
import { LOCAL_BOOK_KEY_PREFIX, SOURCE_BOOK_KEY_PREFIX, STORAGE_KEYS } from '../storage/keys';
import { SyncBackendError, SyncConflictError } from './backend';
import { WEBDAV_LOCK_TIMEOUT_S, WebDavBackend, WebDavLockedError, webdavError, webdavPaths, type WebDavConfig, type WebDavHeldLock, type WebDavLockStore } from './backends/webdav';
import { SnapshotBuilder, runSyncCycle, type SnapshotScope } from './snapshot';
import type { BackendSyncStatus, WebDavTestResult } from './types';

/** WebDAV 同步范围：settings.sync.webdav.include（可选含来源词书缓存）；WebDAV 自身连接信息不会写进 WebDAV */
export function webdavScope(s: Settings): SnapshotScope {
  return { backend: 'webdav', include: { ...s.sync.webdav.include } };
}

/** 本机数据变化后的防抖（WebDAV 每次同步是 GET + PUT 整个文件，防抖比 storage.sync 长） */
export const WEBDAV_DEBOUNCE_MS = 10_000;
/** 连续改动时最多等待 */
export const WEBDAV_MAX_WAIT_MS = 60_000;
/** 服务器限流（429/503）后的退避 */
export const WEBDAV_RATELIMIT_BACKOFF_MS = 10 * 60_000;
/** 一轮同步内冲突（412 / 被锁 423 / 回读校验不一致）的最多尝试次数 */
export const WEBDAV_MAX_ATTEMPTS = 5;
/** 一轮内冲突重试仍失败：随机 30–90 秒后自动再同步（不停在 error，避免本机写入长时间没推上去） */
export const WEBDAV_CONFLICT_RETRY_MS: [number, number] = [30_000, 90_000];
/** 服务器瞬时错误（5xx，如 LOCK 偶发 500）后随机 60–120 秒自动再同步 */
export const WEBDAV_SERVER_RETRY_MS: [number, number] = [60_000, 120_000];

/** 本机写锁令牌存 storage.local（SW 持锁时被回收，重启后由后端先 UNLOCK） */
const storageLockStore: WebDavLockStore = {
  async load() {
    const res = await browser.storage.local.get(STORAGE_KEYS.webdavLock);
    return res[STORAGE_KEYS.webdavLock] as WebDavHeldLock | undefined;
  },
  async save(lock) {
    if (lock) await browser.storage.local.set({ [STORAGE_KEYS.webdavLock]: lock });
    else await browser.storage.local.remove(STORAGE_KEYS.webdavLock);
  },
};

export interface WebDavSyncOptions {
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  maxWaitMs?: number;
  /** 主机权限检查（默认 platform.hasOriginAccess），测试可注入 */
  hasAccess?: (url: string) => Promise<boolean>;
  /** 后端退避/回读等待（测试注入以免真实等待） */
  sleep?: (ms: number) => Promise<void>;
}

const isConfigured = (w: WebDavSettings) => !!(w.url.trim() && w.username.trim() && w.password);

/**
 * 触发 WebDAV 推送的本机键：同 storage.sync，另加来源词书缓存。
 * 按 include 过滤：未勾选的类别变化不触发同步（坚果云等按请求数限流，避免白白多一次 GET）；
 * 设置键总是触发（同步配置本身变化，如刚填好地址、勾选类别）
 */
function isWebDavLocalKey(key: string, include: WebDavSettings['include']): boolean {
  if (key === STORAGE_KEYS.settings) return true;
  if (key === STORAGE_KEYS.knownWords) return include.knownWords;
  if (key === STORAGE_KEYS.localBooks || key.startsWith(LOCAL_BOOK_KEY_PREFIX)) return include.localBooks;
  if (key.startsWith(SOURCE_BOOK_KEY_PREFIX)) return !!include.sourceBooks;
  return false;
}

/**
 * WebDAV 同步服务（background 中实例化一个）：调度（数据变化防抖 / 启动 / 定时）+ 状态 + 连接测试。
 * 一轮同步 = runSyncCycle（GET → 合并 → PUT If-Match，412 时重新拉取合并后重试，最多 3 次）。
 *
 * 定时同步不使用 alarms 权限：SW 每次被唤醒（打开网页、popup 等）时检查是否到期，存活期间用 setTimeout。
 */
export class WebDavSyncService {
  private readonly builder = new SnapshotBuilder();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly hasAccess: (url: string) => Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private firstPendingAt = 0;
  private running: Promise<unknown> = Promise.resolve();
  private statusChain: Promise<unknown> = Promise.resolve();
  /** 设置未变时复用后端实例（保留“目录已存在”缓存） */
  private backend?: { key: string; impl: WebDavBackend };

  constructor(private readonly opts: WebDavSyncOptions = {}) {
    this.debounceMs = opts.debounceMs ?? WEBDAV_DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? WEBDAV_MAX_WAIT_MS;
    this.hasAccess = opts.hasAccess ?? hasOriginAccess;
  }

  /** 注册本机数据变化监听（SW 启动同步阶段调用） */
  listen(): void {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // 只有设置中的同步配置变化（如刚填好地址）也会到这里：按最新设置判断是否需要同步
      void getSettings().then((s) => {
        const w = s.sync.webdav;
        if (!w.enabled || !isConfigured(w) || !w.autoSync.onChange) return;
        if (Object.keys(changes).some((k) => isWebDavLocalKey(k, w.include))) this.schedule();
      });
    });
  }

  /** SW 启动时调用（迁移完成后）：启动同步或到期的定时同步，并安排存活期间的下一次定时同步 */
  async onStartup(): Promise<void> {
    const s = await getSettings();
    const w = s.sync.webdav;
    let st = await this.getStatus();
    // SW 在同步途中被回收：持久化状态停在 syncing（新 SW 里没有进行中的同步），复位为 pending 并保留 lastError，
    // 再安排一次同步补上可能没写成功的改动（不受“启动时同步”开关与 60 秒间隔限制）
    const interrupted = st.phase === 'syncing';
    if (!w.enabled || !isConfigured(w)) {
      if (interrupted) await this.setStatus({ phase: w.enabled ? 'idle' : 'disabled', notice: undefined });
      return;
    }
    if (interrupted) {
      this.schedule();
      st = await this.setStatus({ phase: 'pending', notice: '上次同步被中断，稍后自动重试' });
    }
    const intervalMs = w.autoSync.intervalMinutes * 60_000;
    const due = intervalMs > 0 && Date.now() - st.lastSyncAt >= intervalMs;
    if (!interrupted && ((w.autoSync.onStartup && Date.now() - st.lastSyncAt > 60_000) || due)) await this.syncNow().catch(() => {});
    else if (!interrupted && st.recheckAt) {
      // 上个 SW 安排的无锁写入复查还没做（SW 在复查前被回收）：到期立即复查，未到期按剩余时间安排
      const left = st.recheckAt - Date.now();
      if (left <= 0) await this.syncNow().catch(() => {});
      else this.timer = setTimeout(() => void this.syncNow().catch(() => {}), left);
    }
    this.armInterval(intervalMs);
  }

  private armInterval(intervalMs: number): void {
    clearTimeout(this.intervalTimer);
    if (intervalMs > 0) {
      // 本轮失败只记日志，finally 中照常续排下一轮：用 .then 续排时一次 reject 就会让定时同步链永久中断
      this.intervalTimer = setTimeout(
        () =>
          void this.syncNow()
            .catch((e) => console.warn('[hnw] WebDAV 定时同步失败', e))
            .finally(() => this.armInterval(intervalMs)),
        intervalMs,
      );
    }
  }

  /** 防抖同步：最后一次变化后 debounceMs；连续变化时从第一次未同步的变化起最多 maxWaitMs */
  schedule(): void {
    clearTimeout(this.timer);
    const now = Date.now();
    if (!this.firstPendingAt) this.firstPendingAt = now;
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - now));
    void this.setStatus({ phase: 'pending', notice: undefined });
    this.timer = setTimeout(() => void this.syncNow().catch(() => {}), wait);
  }

  private backendFor(cfg: WebDavConfig): WebDavBackend {
    const key = JSON.stringify(cfg);
    if (this.backend?.key !== key) {
      this.backend = { key, impl: new WebDavBackend(cfg, { fetchImpl: this.opts.fetchImpl, sleep: this.opts.sleep, lockStore: storageLockStore }) };
    }
    return this.backend.impl;
  }

  /** 立即同步一轮（串行执行），返回最新状态；未启用/未配置时返回 disabled */
  syncNow(): Promise<BackendSyncStatus> {
    clearTimeout(this.timer);
    return this.serial(async () => {
      this.firstPendingAt = 0;
      const settings = await getSettings();
      const w = settings.sync.webdav;
      if (!w.enabled) return this.setStatus({ enabled: false, phase: 'disabled', error: undefined, notice: undefined });
      if (!isConfigured(w)) return this.setStatus({ enabled: true, phase: 'error', error: '请先填写 WebDAV 地址、用户名和密码' });
      const prev = await this.getStatus();
      if (prev.retryAt && prev.retryAt > Date.now()) {
        this.timer = setTimeout(() => void this.syncNow().catch(() => {}), prev.retryAt - Date.now());
        return this.setStatus({ phase: 'pending' });
      }
      if (!(await this.hasAccess(w.url))) {
        return this.setStatus({ enabled: true, phase: 'error', error: `未授权访问 ${new URL(w.url).host}，请在选项页点击“测试连接”授权` });
      }
      await this.setStatus({ enabled: true, phase: 'syncing' });
      try {
        const res = await runSyncCycle(this.backendFor(w), this.builder, { deviceId: prev.deviceId, scopeOf: webdavScope, maxAttempts: WEBDAV_MAX_ATTEMPTS });
        const now = Date.now();
        // 服务器不支持锁：写入只有回读校验，稍后复查一轮（复查无变化时只有一次 GET，不再写）；
        // 复查时间写进状态，SW 在复查前被回收时下次启动补做（onStartup）
        if (res.recheckAfterMs) this.timer = setTimeout(() => void this.syncNow().catch(() => {}), res.recheckAfterMs);
        return await this.setStatus({
          phase: 'idle',
          error: undefined,
          notice: undefined,
          retryAt: undefined,
          recheckAt: res.recheckAfterMs ? now + res.recheckAfterMs : undefined,
          lastSyncAt: now,
          lastPullAt: now,
          ...(res.wrote ? { lastPushAt: now } : {}),
          remoteBytes: res.wrote ? res.plan.usage.bytes : res.remote.bytes,
          segments: res.plan.segments.length + Object.keys(res.plan.kept).length,
          conflictRetries: res.conflictRetries,
        });
      } catch (e) {
        console.warn('[hnw] WebDAV 同步失败', e);
        if (e instanceof SyncBackendError && e.code === 'ratelimit') {
          const retryAt = Date.now() + WEBDAV_RATELIMIT_BACKOFF_MS;
          this.timer = setTimeout(() => void this.syncNow().catch(() => {}), WEBDAV_RATELIMIT_BACKOFF_MS);
          return this.setStatus({ phase: 'pending', error: undefined, retryAt, notice: `${e.message}（${new Date(retryAt).toLocaleTimeString()}）` });
        }
        if (e instanceof SyncConflictError) {
          // 多台设备持续同时写入 / 文件被锁定：本机改动还没推上去，不能报成功也不该停在 error 等用户处理，随机延迟后自动再同步
          const [min, max] = WEBDAV_CONFLICT_RETRY_MS;
          const delay = min + Math.floor(Math.random() * (max - min));
          const secs = Math.round(delay / 1000);
          this.timer = setTimeout(() => void this.syncNow().catch(() => {}), delay);
          const notice =
            e instanceof WebDavLockedError
              ? `同步文件被另一设备锁定（对方正在同步，或其同步中断留下的锁最长 ${WEBDAV_LOCK_TIMEOUT_S} 秒后自动解除），约 ${secs} 秒后自动重试`
              : `多台设备同时写入，重试 ${WEBDAV_MAX_ATTEMPTS} 次仍冲突，${secs} 秒后自动再试`;
          return this.setStatus({ phase: 'pending', error: undefined, notice });
        }
        if (e instanceof SyncBackendError && e.code === 'server' && (e.status ?? 0) >= 500) {
          // 服务器瞬时错误（如 LOCK/PUT 偶发 500/502）：不停在 error，稍后自动重试
          const [min, max] = WEBDAV_SERVER_RETRY_MS;
          const delay = min + Math.floor(Math.random() * (max - min));
          this.timer = setTimeout(() => void this.syncNow().catch(() => {}), delay);
          return this.setStatus({ phase: 'pending', error: undefined, notice: `${e.message}，约 ${Math.round(delay / 1000)} 秒后自动重试` });
        }
        return this.setStatus({ phase: 'error', error: e instanceof Error ? e.message : String(e), notice: undefined });
      }
    });
  }

  /**
   * 测试连接（options“测试连接”按钮；调用方应先在点击处理中 requestOriginAccess(url)）：
   * PROPFIND 根地址 → 逐级确保目录（MKCOL）→ PUT/DELETE 探测文件确认可写 → 读取现有同步文件。
   * cfg 不传时用已保存的设置。
   */
  async test(cfg?: Partial<WebDavConfig>): Promise<WebDavTestResult> {
    const saved = (await getSettings()).sync.webdav;
    const conf: WebDavConfig = { url: cfg?.url ?? saved.url, username: cfg?.username ?? saved.username, password: cfg?.password ?? saved.password, dir: cfg?.dir ?? saved.dir };
    const steps: WebDavTestResult['steps'] = [];
    const fail = (step: string, e: unknown): WebDavTestResult => {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ step, ok: false, detail });
      return { ok: false, message: detail, steps };
    };
    let paths: ReturnType<typeof webdavPaths>;
    try {
      const u = new URL(conf.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('地址必须以 http:// 或 https:// 开头');
      paths = webdavPaths(conf);
    } catch (e) {
      return fail('检查地址', e instanceof TypeError ? new Error('地址格式不正确') : e);
    }
    if (!(await this.hasAccess(conf.url))) return fail('检查权限', new Error(`未授权访问 ${new URL(conf.url).host}`));
    const backend = new WebDavBackend(conf, { fetchImpl: this.opts.fetchImpl, sleep: this.opts.sleep });
    const client = backend.client;
    try {
      const st = await client.propfind(paths.base);
      if (st !== 207 && st !== 200) throw webdavError(st, paths.base);
      steps.push({ step: '连接服务器', ok: true });
    } catch (e) {
      return fail('连接服务器', e);
    }
    try {
      const created = await client.ensureDirs();
      steps.push({ step: '同步目录', ok: true, detail: created.length ? `已创建 ${conf.dir}` : `${conf.dir || '/'} 已存在` });
    } catch (e) {
      return fail('同步目录', e);
    }
    const probe = (paths.dirs[paths.dirs.length - 1] ?? paths.base) + '.hnw-probe';
    try {
      await client.put(probe, '{}', undefined);
      await client.delete(probe);
      steps.push({ step: '写入权限', ok: true });
    } catch (e) {
      return fail('写入权限', e);
    }
    try {
      const remote = await backend.read();
      const n = Object.keys(remote.segs).length;
      steps.push({ step: '同步文件', ok: true, detail: remote.version ? `已有同步数据（${n} 段，${Math.ceil((remote.bytes ?? 0) / 1024)} KB）` : '尚无同步数据，首次同步时创建' });
    } catch (e) {
      return fail('同步文件', e);
    }
    return { ok: true, message: '连接成功', steps };
  }

  getStatus(): Promise<BackendSyncStatus & { deviceId: string }> {
    return this.withStatus(async () => {
      const res = await browser.storage.local.get(STORAGE_KEYS.webdavSyncState);
      const prev = res[STORAGE_KEYS.webdavSyncState] as (BackendSyncStatus & { deviceId: string }) | undefined;
      if (prev?.deviceId) return prev;
      const init = { backend: 'webdav' as const, enabled: false, phase: 'idle' as const, lastSyncAt: 0, lastPullAt: 0, lastPushAt: 0, ...prev, deviceId: crypto.randomUUID() };
      await browser.storage.local.set({ [STORAGE_KEYS.webdavSyncState]: init });
      return init;
    });
  }

  private async setStatus(patch: Partial<BackendSyncStatus>): Promise<BackendSyncStatus & { deviceId: string }> {
    const cur = await this.getStatus();
    return this.withStatus(async () => {
      const res = await browser.storage.local.get(STORAGE_KEYS.webdavSyncState);
      const next = { ...cur, ...(res[STORAGE_KEYS.webdavSyncState] as object | undefined), ...patch };
      await browser.storage.local.set({ [STORAGE_KEYS.webdavSyncState]: next });
      return next;
    });
  }

  private withStatus<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.statusChain.then(fn, fn);
    this.statusChain = next.catch(() => {});
    return next;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.running.then(fn, fn);
    this.running = next.catch(() => {});
    return next;
  }
}
