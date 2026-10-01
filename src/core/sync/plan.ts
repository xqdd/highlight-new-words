import { chunkString, syncItemBytes } from './codec';
import {
  SYNC_MANIFEST_KEY,
  syncChunkKey,
  type ManifestSegment,
  type SegmentCandidate,
  type SegmentUsage,
  type SyncQuota,
  type SyncUsage,
} from './types';

/** 规划结果中被选中写入的段 */
export interface PlannedSegment {
  id: string;
  entry: Omit<ManifestSegment, 'h'>;
  encoded: string;
  chunks: string[];
}

export interface SyncPlan {
  segments: PlannedSegment[];
  /** 保留的远端段（本机未启用该类同步），原样保留在 manifest 中 */
  kept: Record<string, ManifestSegment>;
  usage: SyncUsage;
}

/** 单个切片可容纳的字符数：单项上限 - 键长 - JSON 引号 2 字节 - 余量 */
function chunkCapacity(quota: SyncQuota, segId: string): number {
  return quota.quotaBytesPerItem - syncChunkKey(segId, 999).length - 2 - 16;
}

/** manifest 中一个段条目大约占用的字节（规划时累加，避免 manifest 本身超单项上限） */
function manifestEntryBytes(id: string, entry: Omit<ManifestSegment, 'h'>): number {
  return syncItemBytes(id, { ...entry, h: '000000000000' });
}

/**
 * 超配额取舍（纯函数）：按 priority 升序依次放入，每段取第一个放得下的 variant（full -> reduced），
 * 都放不下则跳过（state=skipped，UI 显示“未同步”）。总字节与项数均不超过配额，manifest 本身不超单项上限。
 * kept 为需原样保留的远端段（本机未启用的类别），先计入占用；keptBytes 为其实际字节（未知时按满切片估算）。
 */
export function planSyncLayout(
  candidates: SegmentCandidate[],
  quota: SyncQuota,
  kept: Record<string, ManifestSegment> = {},
  keptBytes: Record<string, number> = {},
): SyncPlan {
  const budgetBytes = quota.quotaBytes - quota.reserveBytes;
  const manifestBudget = quota.quotaBytesPerItem - 256;
  // manifest 固定部分
  let manifestBytes = syncItemBytes(SYNC_MANIFEST_KEY, { v: 1, device: 'x'.repeat(36), at: Date.now(), segs: {} });
  let bytes = 0;
  let items = 1;
  const usage: SegmentUsage[] = [];
  for (const [id, seg] of Object.entries(kept)) {
    const segBytes = keptBytes[id] ?? seg.n * quota.quotaBytesPerItem;
    bytes += segBytes;
    items += seg.n;
    manifestBytes += manifestEntryBytes(id, seg);
    usage.push({ id, kind: seg.kind, label: id, bytes: segBytes, items: seg.n, state: 'kept' });
  }
  const segments: PlannedSegment[] = [];
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority)) {
    let placed = false;
    for (const v of c.variants) {
      const chunks = chunkString(v.encoded, chunkCapacity(quota, c.id));
      const segBytes = chunks.reduce((sum, ch, i) => sum + syncItemBytes(syncChunkKey(c.id, i), ch), 0);
      const entry = { kind: c.kind, n: chunks.length, at: c.at, level: v.level };
      const entryBytes = manifestEntryBytes(c.id, entry);
      if (
        bytes + segBytes + manifestBytes + entryBytes <= budgetBytes &&
        items + chunks.length <= quota.maxItems &&
        manifestBytes + entryBytes <= manifestBudget
      ) {
        bytes += segBytes;
        items += chunks.length;
        manifestBytes += entryBytes;
        segments.push({ id: c.id, entry, encoded: v.encoded, chunks });
        usage.push({ id: c.id, kind: c.kind, label: c.label, bytes: segBytes, items: chunks.length, state: v.level === 'full' ? 'synced' : 'reduced' });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const smallest = c.variants[c.variants.length - 1]?.encoded.length ?? 0;
      usage.push({ id: c.id, kind: c.kind, label: c.label, bytes: smallest, items: 0, state: 'skipped' });
    }
  }
  return {
    segments,
    kept,
    usage: { bytes: bytes + manifestBytes, quotaBytes: quota.quotaBytes, items, maxItems: quota.maxItems, segments: usage },
  };
}
