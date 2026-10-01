import { browser, type Browser } from 'wxt/browser';
import { getSettings } from '../settings/store';
import type { Settings } from '../settings/schema';
import { LOCAL_BOOK_KEY_PREFIX, STORAGE_KEYS } from '../storage/keys';
import type { RemoteSnapshot } from './backend';
import { StorageSyncBackend } from './backends/storage-sync';
import { SnapshotBuilder, applyRemoteSnapshot, runSyncCycle, type SnapshotScope } from './snapshot';
import {
  DEFAULT_SYNC_QUOTA,
  SYNC_CHUNK_KEY_PREFIX,
  SYNC_HOURLY_BACKOFF_MS,
  SYNC_MANIFEST_KEY,
  SYNC_MIN_PUSH_INTERVAL_MS,
  SYNC_PUSH_DEBOUNCE_MS,
  SYNC_PUSH_MAX_WAIT_MS,
  SYNC_RATE_LIMIT_BACKOFF_MS,
  SYNC_WRITE_BUDGET,
  type SyncManifest,
  type SyncQuota,
  type SyncStatus,
} from './types';

type StorageArea = Browser.storage.StorageArea;

export interface StorageSyncOptions {
  /** 默认 browser.storage.sync；测试可注入 */
  area?: StorageArea;
  quota?: Partial<SyncQuota>;
  debounceMs?: number;
  minIntervalMs?: number;
  maxWaitMs?: number;
}

/** chrome.storage.sync 后端的同步范围：settings.sync.include（来源词书缓存不同步，WebDAV 密码可随凭据上传） */
export function storageSyncScope(s: Settings): SnapshotScope {
  return { backend: 'storage-sync', include: { ...s.sync.include, sourceBooks: false } };
}

/** 本机 storage.local 中会触发推送的键 */
function isSyncedLocalKey(key: string): boolean {
  return key === STORAGE_KEYS.settings || key === STORAGE_KEYS.knownWords || key === STORAGE_KEYS.localBooks || key.startsWith(LOCAL_BOOK_KEY_PREFIX);
}

/**
 * storage.sync 同步服务（仅在 background 中实例化一个）。
 *
 * 流程：
 * - 本机数据变化（storage.local onChanged）-> 防抖 schedulePush
 * - 其他设备写入（storage.sync onChanged）-> 防抖 pull 合并到本机
 * - push 总是先 pull 合并再写，避免覆盖其他设备的修改；只重写哈希变化的段，一次 set + 一次 remove
 * 合并写回本机会再次触发 local onChanged，但此时规划结果与远端一致，不会产生写操作，不会循环。
 */
export class StorageSyncService {
  private readonly area: StorageArea;
  private readonly quota: SyncQuota;
  /** 传输层：chrome.storage.sync 后端（manifest + 切片 + 配额取舍） */
  readonly backend: StorageSyncBackend;
  /** 快照构造（含编码缓存） */
  private readonly builder = new SnapshotBuilder();
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly maxWaitMs: number;
  private pushTimer?: ReturnType<typeof setTimeout>;
  /** 第一次未推送改动的时间（防抖 maxWait 的起点）；推送开始时清零 */
  private firstPendingAt = 0;
  /** 本机 storage.sync 写操作时间（滑动窗口，用于自我限额与每小时退避推算） */
  private writeLog: number[] = [];
  private pullTimer?: ReturnType<typeof setTimeout>;
  private lastPushStart = 0;
  private backoffUntil = 0;
  private running: Promise<unknown> = Promise.resolve();
  /** syncState 读改写串行化（只有本服务写 syncState） */
  private statusChain: Promise<unknown> = Promise.resolve();

  constructor(opts: StorageSyncOptions = {}) {
    this.area = opts.area ?? browser.storage.sync;
    const api = browser.storage.sync as unknown as Partial<SyncQuota> & { QUOTA_BYTES?: number; QUOTA_BYTES_PER_ITEM?: number; MAX_ITEMS?: number };
    this.quota = {
      ...DEFAULT_SYNC_QUOTA,
      quotaBytes: api.QUOTA_BYTES ?? DEFAULT_SYNC_QUOTA.quotaBytes,
      quotaBytesPerItem: api.QUOTA_BYTES_PER_ITEM ?? DEFAULT_SYNC_QUOTA.quotaBytesPerItem,
      maxItems: api.MAX_ITEMS ?? DEFAULT_SYNC_QUOTA.maxItems,
      ...opts.quota,
    };
    this.debounceMs = opts.debounceMs ?? SYNC_PUSH_DEBOUNCE_MS;
    this.minIntervalMs = opts.minIntervalMs ?? SYNC_MIN_PUSH_INTERVAL_MS;
    this.maxWaitMs = opts.maxWaitMs ?? SYNC_PUSH_MAX_WAIT_MS;
    this.backend = new StorageSyncBackend(this.area, this.quota, () => this.writeLog.push(Date.now()));
  }

  /** 注册 storage 变化监听（须在 SW 启动同步阶段调用）；启动同步由调用方在迁移完成后调用 syncNow */
  listen(): void {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && Object.keys(changes).some(isSyncedLocalKey)) this.schedulePush();
      if (area === 'sync' && Object.keys(changes).some((k) => k.startsWith(SYNC_CHUNK_KEY_PREFIX))) {
        // 本机自己写入也会触发 sync 区 onChanged：manifest 的 device 是本机时无需拉取
        const writer = (changes[SYNC_MANIFEST_KEY]?.newValue as SyncManifest | undefined)?.device;
        void this.getStatus().then((st) => {
          if (writer && writer === st.deviceId) return;
          this.schedulePull();
        });
      }
    });
  }

  /**
   * 防抖推送：最后一次变化后 debounceMs；连续变化时从第一次未推送的变化起最多等 maxWaitMs（防抖不会无限推迟）；
   * 同时满足：距上次推送 ≥ minIntervalMs、不在写频率退避期内、本机写操作计数在自我限额内。
   */
  schedulePush(): void {
    clearTimeout(this.pushTimer);
    const now = Date.now();
    if (!this.firstPendingAt) this.firstPendingAt = now;
    const debounced = Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - now);
    const wait = Math.max(0, debounced, this.lastPushStart + this.minIntervalMs - now, this.backoffUntil - now, this.budgetWait(now));
    if (this.backoffUntil <= now) void this.setStatus({ phase: 'pending', error: undefined });
    this.pushTimer = setTimeout(() => void this.syncNow().catch(() => {}), wait);
  }

  /** 自我限额：写入 2 次（set + remove）后仍不超过 SYNC_WRITE_BUDGET 所需等待的毫秒数 */
  private budgetWait(now: number): number {
    this.writeLog = this.writeLog.filter((t) => now - t < 3_600_000);
    const lastMinute = this.writeLog.filter((t) => now - t < 60_000);
    let wait = 0;
    if (lastMinute.length + 2 > SYNC_WRITE_BUDGET.perMinute) wait = Math.max(wait, lastMinute[lastMinute.length + 2 - SYNC_WRITE_BUDGET.perMinute - 1]! + 60_000 - now);
    if (this.writeLog.length + 2 > SYNC_WRITE_BUDGET.perHour) wait = Math.max(wait, this.writeLog[this.writeLog.length + 2 - SYNC_WRITE_BUDGET.perHour - 1]! + 3_600_000 - now);
    return wait;
  }

  /**
   * 写频率超限后的退避截止时间：每分钟上限退避 60s；每小时上限按本机写入记录推算窗口释放时间（最早一次写入 + 1 小时），
   * 没有记录（如 SW 刚重启）时退避整 1 小时。
   */
  private backoffFor(raw: string, now: number): number {
    if (!/PER_HOUR/i.test(raw)) return now + SYNC_RATE_LIMIT_BACKOFF_MS;
    const recent = this.writeLog.filter((t) => now - t < 3_600_000);
    return recent.length ? Math.max(now + SYNC_RATE_LIMIT_BACKOFF_MS, recent[0]! + SYNC_HOURLY_BACKOFF_MS) : now + SYNC_HOURLY_BACKOFF_MS;
  }

  schedulePull(): void {
    clearTimeout(this.pullTimer);
    this.pullTimer = setTimeout(() => void this.serial(() => this.pull()).catch(() => {}), 2_000);
  }

  /** 立即 pull + push（串行执行，避免并发），返回最新状态 */
  syncNow(): Promise<SyncStatus> {
    clearTimeout(this.pushTimer);
    return this.serial(async () => {
      const settings = await getSettings();
      if (!settings.sync.enabled) return this.setStatus({ enabled: false, phase: 'disabled', error: undefined });
      const prev = await this.getStatus();
      // 退避截止时间持久化在 syncState：SW 被回收重启后仍遵守（内存中的 backoffUntil 会丢失）
      this.backoffUntil = Math.max(this.backoffUntil, prev.retryAt ?? 0);
      await this.setStatus({ enabled: true, phase: 'syncing' });
      try {
        const remote = await this.pull();
        // 写频率退避期 / 自我限额内只拉取不写入，到期后自动补推（状态为 pending + 提示，不显示为错误）
        const now = Date.now();
        if (now < this.backoffUntil || this.budgetWait(now) > 0) {
          this.schedulePush();
          return await this.setStatus({ phase: 'pending', error: undefined, notice: this.backoffNotice() });
        }
        this.lastPushStart = now;
        this.firstPendingAt = 0;
        await this.push(remote);
        return await this.setStatus({ phase: 'idle', error: undefined, notice: undefined, retryAt: undefined });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn('[hnw] storage.sync 同步失败', e);
        if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE/i.test(raw)) {
          // 触发写频率限制：按分钟/小时窗口退避后自动重试（SW 若被回收，下次启动读 retryAt 继续遵守）
          this.backoffUntil = this.backoffFor(raw, Date.now());
          this.schedulePush();
          return this.setStatus({ phase: 'pending', error: undefined, retryAt: this.backoffUntil, notice: this.backoffNotice() });
        }
        const error = /QUOTA_BYTES/i.test(raw) ? `超出同步空间配额：${raw}` : raw;
        return this.setStatus({ phase: 'error', error, notice: undefined });
      }
    });
  }

  /** 退避期提示文案：本地修改已保存，只是推迟上传 */
  private backoffNotice(): string {
    const at = Math.max(this.backoffUntil, Date.now() + this.budgetWait(Date.now()));
    const t = new Date(at);
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return `写入过于频繁，已暂停上传，将于 ${hhmm} 自动重试（本机修改已保存）`;
  }

  /** 读取状态；首次读取时生成并持久化设备 id（manifest.device 用它区分本机写入） */
  getStatus(): Promise<SyncStatus> {
    return this.withStatus(async () => {
      const res = await browser.storage.local.get(STORAGE_KEYS.syncState);
      const prev = res[STORAGE_KEYS.syncState] as SyncStatus | undefined;
      if (prev?.deviceId) return prev;
      const init: SyncStatus = { enabled: true, phase: 'idle', lastPushAt: 0, lastPullAt: 0, ...prev, deviceId: crypto.randomUUID() };
      await browser.storage.local.set({ [STORAGE_KEYS.syncState]: init });
      return init;
    });
  }

  private async setStatus(patch: Partial<SyncStatus>): Promise<SyncStatus> {
    const cur = await this.getStatus();
    return this.withStatus(async () => {
      // 重新读取，避免与并发的 setStatus 互相覆盖
      const res = await browser.storage.local.get(STORAGE_KEYS.syncState);
      const next = { ...cur, ...(res[STORAGE_KEYS.syncState] as SyncStatus | undefined), ...patch };
      await browser.storage.local.set({ [STORAGE_KEYS.syncState]: next });
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

  /** 读取远端并合并到本机，返回远端快照（供 push 复用，避免重复读取）；关闭同步时返回 undefined */
  async pull(): Promise<RemoteSnapshot | undefined> {
    const settings = await getSettings();
    if (!settings.sync.enabled) return undefined;
    const remote = await this.backend.read();
    await applyRemoteSnapshot(remote, storageSyncScope(settings));
    await this.setStatus({ lastPullAt: Date.now() });
    return remote;
  }

  /**
   * 规划并写入远端；remote 为 pull 读到的快照。写前发现其他设备刚写过（SyncConflictError）时
   * 重新拉取合并后重试（runSyncCycle，最多 3 次），不会覆盖对方的改动。
   */
  async push(remote: RemoteSnapshot | undefined): Promise<void> {
    const status = await this.getStatus();
    const res = await runSyncCycle(this.backend, this.builder, { deviceId: status.deviceId, scopeOf: storageSyncScope, firstRemote: remote });
    await this.setStatus({ usage: res.plan.usage, ...(res.wrote ? { lastPushAt: Date.now() } : {}), ...(res.conflictRetries ? { lastPullAt: Date.now() } : {}) });
  }
}
