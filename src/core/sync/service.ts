import { browser, type Browser } from 'wxt/browser';
import { getKnownData, saveKnownData } from '../known/store';
import { mergeKnownWords } from '../known/merge';
import { getSettings, saveSettings } from '../settings/store';
import type { Settings, SyncDataKind } from '../settings/schema';
import { LOCAL_BOOK_KEY_PREFIX, STORAGE_KEYS, localBookKey } from '../storage/keys';
import { getLocalBook, getLocalIndex, updateLocalIndex } from '../wordbook/user-store';
import type { LocalBookData } from '../wordbook/types';
import { decodeSyncValue, encodeSyncValue, shortHash, stableStringify, syncItemBytes } from './codec';
import {
  fromLocalBookSegment,
  mergeSyncedSettings,
  pickSyncedSettings,
  planLocalBooksMerge,
  toLocalBookSegment,
  type LocalBookSegment,
  type SyncedSettings,
} from './merge';
import { decodeKnownSegment, encodeKnownSegment } from './known-codec';
import { planSyncLayout } from './plan';
import {
  DEFAULT_SYNC_QUOTA,
  SYNC_CHUNK_KEY_PREFIX,
  SYNC_MANIFEST_KEY,
  SYNC_MIN_PUSH_INTERVAL_MS,
  SYNC_PUSH_DEBOUNCE_MS,
  SYNC_RATE_LIMIT_BACKOFF_MS,
  syncChunkKey,
  type ManifestSegment,
  type SegmentCandidate,
  type SyncManifest,
  type SyncQuota,
  type SyncStatus,
} from './types';

type StorageArea = Browser.storage.StorageArea;

/** 段 id 约定 */
const SEG_SETTINGS = 'settings';
const SEG_KNOWN = 'known';
const SEG_LOCAL_REMOVED = 'lbr';
const SEG_LOCAL_PREFIX = 'lb:';

export interface StorageSyncOptions {
  /** 默认 browser.storage.sync；测试可注入 */
  area?: StorageArea;
  quota?: Partial<SyncQuota>;
  debounceMs?: number;
  minIntervalMs?: number;
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
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private pushTimer?: ReturnType<typeof setTimeout>;
  private pullTimer?: ReturnType<typeof setTimeout>;
  private lastPushStart = 0;
  private backoffUntil = 0;
  private running: Promise<unknown> = Promise.resolve();
  /** syncState 读改写串行化（只有本服务写 syncState） */
  private statusChain: Promise<unknown> = Promise.resolve();
  /** 编码缓存：本地词书较大时避免每次推送都重新压缩，key = 段id@更新时间@级别 */
  private encodeCache = new Map<string, string>();

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

  /** 防抖推送：最后一次变化后 debounceMs，且距上次推送不少于 minIntervalMs */
  schedulePush(): void {
    clearTimeout(this.pushTimer);
    const wait = Math.max(this.debounceMs, this.lastPushStart + this.minIntervalMs - Date.now(), this.backoffUntil - Date.now());
    void this.setStatus({ phase: 'pending' });
    this.pushTimer = setTimeout(() => void this.syncNow().catch(() => {}), wait);
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
      await this.setStatus({ enabled: true, phase: 'syncing' });
      try {
        const remote = await this.pull();
        // 写频率退避期内只拉取不写入，到期后自动补推
        if (Date.now() < this.backoffUntil) {
          this.schedulePush();
          return await this.setStatus({ phase: 'pending' });
        }
        this.lastPushStart = Date.now();
        await this.push(remote);
        return await this.setStatus({ phase: 'idle', error: undefined });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn('[hnw] storage.sync 同步失败', e);
        if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE/i.test(raw)) {
          // 触发写频率限制：退避后自动重试一次（SW 若被回收，下次启动会再同步）
          this.backoffUntil = Date.now() + SYNC_RATE_LIMIT_BACKOFF_MS;
          this.schedulePush();
          return this.setStatus({ phase: 'error', error: '写入过于频繁，已暂停 1 分钟后自动重试' });
        }
        const error = /QUOTA_BYTES/i.test(raw) ? `超出同步空间配额：${raw}` : raw;
        return this.setStatus({ phase: 'error', error });
      }
    });
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

  /** 读取远端并合并到本机，返回远端全部条目（供 push 复用，避免重复读取） */
  async pull(): Promise<Record<string, unknown>> {
    const settings = await getSettings();
    if (!settings.sync.enabled) return {};
    const all = (await this.area.get(null)) as Record<string, unknown>;
    const manifest = all[SYNC_MANIFEST_KEY] as SyncManifest | undefined;
    if (!manifest) return all;
    const include = settings.sync.include;
    const read = async <T>(id: string): Promise<T | undefined> => {
      const seg = manifest.segs[id];
      if (!seg) return undefined;
      const parts: string[] = [];
      for (let i = 0; i < seg.n; i++) {
        const part = all[syncChunkKey(id, i)];
        // 切片缺失说明其他设备写入未完成，本轮跳过该段
        if (typeof part !== 'string') return undefined;
        parts.push(part);
      }
      const encoded = parts.join('');
      // 两台设备几乎同时推送时，manifest 与切片可能来自不同设备：哈希不符则跳过该段，本机随后推送会重写一致的数据
      if ((await shortHash(encoded)) !== seg.h) {
        console.warn('[hnw] storage.sync 段哈希不一致，跳过', id);
        return undefined;
      }
      try {
        return await decodeSyncValue<T>(encoded);
      } catch (e) {
        console.warn('[hnw] storage.sync 段解码失败，跳过', id, e);
        return undefined;
      }
    };

    if (include.settings) {
      const remote = await read<SyncedSettings>(SEG_SETTINGS);
      const merged = remote && mergeSyncedSettings(settings, remote);
      if (merged) await saveSettings(merged, { keepUpdatedAt: true });
    }
    if (include.knownWords) {
      const raw = await read<unknown>(SEG_KNOWN);
      if (raw) {
        const remote = decodeKnownSegment(raw);
        const local = await getKnownData();
        const merged = mergeKnownWords(local, remote);
        if (stableStringify(merged) !== stableStringify(local)) await saveKnownData(merged);
      }
    }
    if (include.localBooks) {
      const remoteRemoved = (await read<Record<string, number>>(SEG_LOCAL_REMOVED)) ?? {};
      const remoteBooks: LocalBookSegment[] = [];
      for (const id of Object.keys(manifest.segs).filter((s) => s.startsWith(SEG_LOCAL_PREFIX))) {
        const seg = await read<LocalBookSegment>(id);
        if (seg) remoteBooks.push(seg);
      }
      await this.applyLocalBooks(remoteBooks, remoteRemoved);
    }
    await this.setStatus({ lastPullAt: Date.now() });
    return all;
  }

  private async applyLocalBooks(remoteBooks: LocalBookSegment[], remoteRemoved: Record<string, number>): Promise<void> {
    const local = await getLocalIndex();
    const plan = planLocalBooksMerge(local, remoteBooks, remoteRemoved);
    if (plan.upsert.length === 0 && plan.remove.length === 0 && stableStringify(plan.removed) === stableStringify(local.removed)) return;
    const items: Record<string, LocalBookData> = {};
    for (const seg of plan.upsert) {
      // 远端为降级段（只有单词）而本机已有该书：保留本机同词的释义/音标，避免改名等小改动导致释义丢失
      const prev = 'list' in seg && local.books[seg.meta.id] ? await getLocalBook(seg.meta.id) : undefined;
      items[localBookKey(seg.meta.id)] = fromLocalBookSegment(seg, prev);
    }
    if (Object.keys(items).length > 0) await browser.storage.local.set(items);
    await browser.storage.local.remove(plan.remove.map(localBookKey));
    await updateLocalIndex((index) => {
      for (const seg of plan.upsert) index.books[seg.meta.id] = seg.meta;
      for (const id of plan.remove) delete index.books[id];
      index.removed = plan.removed;
    });
  }

  private async encodeCached(key: string, value: () => unknown): Promise<string> {
    let enc = this.encodeCache.get(key);
    if (!enc) {
      enc = await encodeSyncValue(value());
      this.encodeCache.set(key, enc);
    }
    return enc;
  }

  /** 按本机数据构造候选段 */
  private async buildCandidates(settings: Settings): Promise<SegmentCandidate[]> {
    const include = settings.sync.include;
    const out: SegmentCandidate[] = [];
    if (include.settings) {
      const encoded = await encodeSyncValue(pickSyncedSettings(settings));
      out.push({ id: SEG_SETTINGS, kind: 'settings', priority: 0, at: settings.updatedAt, label: '设置', variants: [{ level: 'full', encoded }] });
    }
    if (include.knownWords) {
      const known = await getKnownData();
      // 熟词本/墓碑没有单一更新时间，at 记 0（at 参与 manifest 比较，不能用当前时间，否则每次都会重写 manifest）
      // 超配额时先降级为天精度时间（见 known-codec.ts）
      out.push({
        id: SEG_KNOWN,
        kind: 'knownWords',
        priority: 1,
        at: 0,
        label: '熟词本',
        variants: [
          { level: 'full', encoded: await encodeSyncValue(encodeKnownSegment(known, 'full')) },
          { level: 'reduced', encoded: await encodeSyncValue(encodeKnownSegment(known, 'reduced')) },
        ],
      });
    }
    if (include.localBooks) {
      const index = await getLocalIndex();
      const encoded = await encodeSyncValue(index.removed);
      out.push({ id: SEG_LOCAL_REMOVED, kind: 'localBooks', priority: 2, at: 0, label: '已删除词书记录', variants: [{ level: 'full', encoded }] });
      // 小书优先：同样的配额下能同步更多本
      const metas = Object.values(index.books).sort((a, b) => a.wordCount - b.wordCount);
      for (const [i, meta] of metas.entries()) {
        const data = await getLocalBook(meta.id);
        if (!data) continue;
        const segId = SEG_LOCAL_PREFIX + meta.id.slice(meta.id.indexOf(':') + 1);
        out.push({
          id: segId,
          kind: 'localBooks',
          priority: 10 + i,
          at: meta.updatedAt,
          label: meta.name,
          variants: [
            { level: 'full', encoded: await this.encodeCached(`${segId}@${meta.updatedAt}@full`, () => toLocalBookSegment(meta, data, false)) },
            { level: 'reduced', encoded: await this.encodeCached(`${segId}@${meta.updatedAt}@reduced`, () => toLocalBookSegment(meta, data, true)) },
          ],
        });
      }
    }
    return out;
  }

  /** 规划并写入远端；remote 为 pull 读到的远端全部条目 */
  async push(remote: Record<string, unknown>): Promise<void> {
    const settings = await getSettings();
    const status = await this.getStatus();
    const manifest = remote[SYNC_MANIFEST_KEY] as SyncManifest | undefined;
    const include: Record<SyncDataKind, boolean> = settings.sync.include;

    // 本机未启用的类别：远端已有的段原样保留（可能是其他设备的数据）
    const kept: Record<string, ManifestSegment> = {};
    const keptBytes: Record<string, number> = {};
    for (const [id, seg] of Object.entries(manifest?.segs ?? {})) {
      if (include[seg.kind]) continue;
      kept[id] = seg;
      keptBytes[id] = Array.from({ length: seg.n }, (_, i) => syncChunkKey(id, i)).reduce((s, k) => s + syncItemBytes(k, remote[k] ?? ''), 0);
    }

    const plan = planSyncLayout(await this.buildCandidates(settings), this.quota, kept, keptBytes);
    const segs: Record<string, ManifestSegment> = { ...kept };
    const toSet: Record<string, unknown> = {};
    for (const p of plan.segments) {
      const h = await shortHash(p.encoded);
      segs[p.id] = { ...p.entry, h };
      const old = manifest?.segs[p.id];
      if (!old || old.h !== h || old.n !== p.chunks.length) p.chunks.forEach((c, i) => (toSet[syncChunkKey(p.id, i)] = c));
    }
    // 远端段与本次规划一致时不写 manifest
    const sameSegs = manifest && stableStringify(manifest.segs) === stableStringify(segs);
    if (!sameSegs || Object.keys(toSet).length > 0) {
      toSet[SYNC_MANIFEST_KEY] = { v: 1, device: status.deviceId, at: Date.now(), segs } satisfies SyncManifest;
    }
    const liveKeys = new Set([SYNC_MANIFEST_KEY, ...Object.entries(segs).flatMap(([id, s]) => Array.from({ length: s.n }, (_, i) => syncChunkKey(id, i)))]);
    const toRemove = Object.keys(remote).filter((k) => k.startsWith(SYNC_CHUNK_KEY_PREFIX) && !liveKeys.has(k));

    // 一次 set（切片与 manifest 同批写入）+ 一次 remove，计 2 次写操作
    if (Object.keys(toSet).length > 0) await this.area.set(toSet);
    if (toRemove.length > 0) await this.area.remove(toRemove);
    await this.setStatus({ usage: plan.usage, ...(Object.keys(toSet).length > 0 ? { lastPushAt: Date.now() } : {}) });
  }
}
