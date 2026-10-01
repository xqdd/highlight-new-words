import type { Browser } from 'wxt/browser';
import { SyncConflictError, type BackendWriteResult, type RemoteSnapshot, type SyncBackend } from '../backend';
import { shortHash, stableStringify, syncItemBytes } from '../codec';
import { planSyncLayout, splitManifestSegs, type SyncPlan } from '../plan';
import {
  SYNC_CHUNK_KEY_PREFIX,
  SYNC_MANIFEST_KEY,
  syncChunkKey,
  syncManifestPartKey,
  type ManifestSegment,
  type SegmentCandidate,
  type SyncManifest,
  type SyncManifestPart,
  type SyncQuota,
} from '../types';

type StorageArea = Browser.storage.StorageArea;

/**
 * 读取（可能分片的）manifest：合并 hnw:m 与 hnw:m:<i> 的段目录。分片缺失（其他设备写入未完成/被删）时
 * incomplete=true：缺失分片中的段本轮视为未知（不拉取、不当作删除），推送时重写完整 manifest。
 */
export function readManifest(all: Record<string, unknown>): (SyncManifest & { incomplete?: boolean }) | undefined {
  const head = all[SYNC_MANIFEST_KEY] as SyncManifest | undefined;
  if (!head) return undefined;
  const segs = { ...head.segs };
  let incomplete = false;
  for (let i = 1; i < (head.parts ?? 1); i++) {
    const part = all[syncManifestPartKey(i)] as SyncManifestPart | undefined;
    if (!part?.segs) incomplete = true;
    else Object.assign(segs, part.segs);
  }
  return { ...head, segs, incomplete };
}

/** manifest 版本标识：写入设备 + 写入时间（每次写 manifest 都会变化） */
function manifestVersion(m: Pick<SyncManifest, 'device' | 'at'> | undefined): string | null {
  return m ? `${m.device}@${m.at}` : null;
}

/** storage.sync 快照：除通用字段外带原始条目（计算保留段字节、失效切片） */
interface StorageSyncSnapshot extends RemoteSnapshot {
  all: Record<string, unknown>;
  manifest?: SyncManifest & { incomplete?: boolean };
}

/**
 * chrome.storage.sync 后端：manifest + 切片，配额取舍见 plan.ts。
 *
 * 冲突检测：storage.sync 没有条件写，写前重新读取 `hnw:m`，版本（device@at）与 read 时不同则抛 SyncConflictError；
 * 读 manifest 不计入写频率限额。剩余的竞态窗口（两台设备在同一毫秒级窗口内各自写入）由段哈希校验兜底：
 * 哈希不符的段读取时跳过，随后的推送会重写一致的数据。
 */
export class StorageSyncBackend implements SyncBackend {
  readonly id = 'storage-sync' as const;

  constructor(
    private readonly area: StorageArea,
    readonly quota: SyncQuota,
    /** 每次 set/remove 前回调（StorageSyncService 记录写操作时间，用于自我限额与退避推算） */
    private readonly onWriteOp: () => void = () => {},
  ) {}

  async read(): Promise<StorageSyncSnapshot> {
    const all = (await this.area.get(null)) as Record<string, unknown>;
    const manifest = readManifest(all);
    return {
      version: manifestVersion(manifest),
      segs: manifest?.segs ?? {},
      incomplete: manifest?.incomplete,
      all,
      manifest,
      bytes: Object.entries(all).reduce((s, [k, v]) => s + syncItemBytes(k, v), 0),
      readSegment: async (id) => {
        const seg = manifest?.segs[id];
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
        return encoded;
      },
    };
  }

  async list(): Promise<{ version: string | null; segs: Record<string, ManifestSegment> }> {
    const head = (await this.area.get(SYNC_MANIFEST_KEY)) as Record<string, unknown>;
    const parts = (head[SYNC_MANIFEST_KEY] as SyncManifest | undefined)?.parts ?? 1;
    const all = parts > 1 ? ((await this.area.get(Array.from({ length: parts }, (_, i) => syncManifestPartKey(i)))) as Record<string, unknown>) : head;
    const m = readManifest(all);
    return { version: manifestVersion(m), segs: m?.segs ?? {} };
  }

  plan(candidates: SegmentCandidate[], base: RemoteSnapshot, kept: Record<string, ManifestSegment>): SyncPlan {
    const all = (base as StorageSyncSnapshot).all ?? {};
    const keptBytes: Record<string, number> = {};
    for (const [id, seg] of Object.entries(kept)) {
      keptBytes[id] = Array.from({ length: seg.n }, (_, i) => syncChunkKey(id, i)).reduce((s, k) => s + syncItemBytes(k, all[k] ?? ''), 0);
    }
    return planSyncLayout(candidates, this.quota, kept, keptBytes);
  }

  /** 只重写哈希变化的段；一次 set（切片与 manifest 同批写入）+ 一次 remove，最多计 2 次写操作 */
  async write(plan: SyncPlan, base: RemoteSnapshot, deviceId: string): Promise<BackendWriteResult> {
    const snap = base as StorageSyncSnapshot;
    const manifest = snap.manifest;
    const segs: Record<string, ManifestSegment> = { ...plan.kept };
    const toSet: Record<string, unknown> = {};
    for (const p of plan.segments) {
      const h = await shortHash(p.encoded);
      segs[p.id] = { ...p.entry, h };
      const old = manifest?.segs[p.id];
      if (!old || old.h !== h || old.n !== p.chunks.length) p.chunks.forEach((c, i) => (toSet[syncChunkKey(p.id, i)] = c));
    }
    // 远端段与本次规划一致时不写 manifest；段目录超过单项上限时分片写入（hnw:m + hnw:m:<i>），与切片同批
    const sameSegs = manifest && !manifest.incomplete && stableStringify(manifest.segs) === stableStringify(segs);
    const parts = splitManifestSegs(segs, this.quota);
    const at = Date.now();
    if (!sameSegs || Object.keys(toSet).length > 0) {
      parts.forEach((part, i) => {
        toSet[syncManifestPartKey(i)] =
          i === 0 ? ({ v: 1, device: deviceId, at, segs: part, ...(parts.length > 1 ? { parts: parts.length } : {}) } satisfies SyncManifest) : ({ segs: part } satisfies SyncManifestPart);
      });
    }
    const manifestKeys = parts.map((_, i) => syncManifestPartKey(i));
    const liveKeys = new Set([...manifestKeys, ...Object.entries(segs).flatMap(([id, s]) => Array.from({ length: s.n }, (_, i) => syncChunkKey(id, i)))]);
    const toRemove = Object.keys(snap.all ?? {}).filter((k) => k.startsWith(SYNC_CHUNK_KEY_PREFIX) && !liveKeys.has(k));

    if (Object.keys(toSet).length === 0 && toRemove.length === 0) return { wrote: false, version: base.version, writeOps: 0 };
    // 写前检查：read 之后其他设备写过 manifest -> 冲突，调用方重新拉取合并后重试（不覆盖对方刚写的段）
    const current = (await this.area.get(SYNC_MANIFEST_KEY))[SYNC_MANIFEST_KEY] as SyncManifest | undefined;
    if (manifestVersion(current) !== base.version) throw new SyncConflictError('chrome.storage.sync 上的数据刚被其他设备修改');

    let writeOps = 0;
    if (Object.keys(toSet).length > 0) {
      this.onWriteOp();
      writeOps++;
      await this.area.set(toSet);
    }
    if (toRemove.length > 0) {
      this.onWriteOp();
      writeOps++;
      await this.area.remove(toRemove);
    }
    const wroteManifest = toSyncManifest(toSet[SYNC_MANIFEST_KEY]);
    return { wrote: Object.keys(toSet).length > 0, version: wroteManifest ? manifestVersion(wroteManifest) : base.version, writeOps };
  }

  async getUsage(): Promise<{ bytes: number; quotaBytes?: number }> {
    const area = this.area as StorageArea & { getBytesInUse?: (keys?: null) => Promise<number> };
    // getBytesInUse 在部分实现（Firefox 旧版、测试替身）中不可用：退回按读取内容自行计算（与 Chrome 计费规则一致）
    let bytes: number;
    try {
      bytes = await area.getBytesInUse!(null);
    } catch {
      bytes = (await this.read()).bytes ?? 0;
    }
    return { bytes, quotaBytes: this.quota.quotaBytes };
  }
}

function toSyncManifest(v: unknown): SyncManifest | undefined {
  return v && typeof v === 'object' && 'device' in v ? (v as SyncManifest) : undefined;
}
