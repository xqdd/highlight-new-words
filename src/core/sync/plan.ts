import { chunkString, syncItemBytes } from './codec';
import {
  SYNC_MANIFEST_KEY,
  SYNC_MAX_MANIFEST_PARTS,
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

/** manifest 中一个段条目大约占用的字节（规划时累加，决定 manifest 分片数） */
function manifestEntryBytes(id: string, entry: Omit<ManifestSegment, 'h'>): number {
  return dirEntryBytes(id, { ...entry, h: '000000000000' });
}

/** 段目录中一项的实际字节：`"id":{…},`，比 syncItemBytes 多键名引号、冒号与逗号 4 字节 */
function dirEntryBytes(id: string, seg: unknown): number {
  return syncItemBytes(id, seg) + 4;
}

/** 每片 manifest 可容纳的段目录字节（单项上限减去键与外层结构余量） */
export function manifestPartBudget(quota: SyncQuota): number {
  return quota.quotaBytesPerItem - 256;
}

/**
 * 把段目录按字节贪心切成若干片（与 planSyncLayout 的估算一致），第 0 片额外承载 v/device/at/parts，预留在 256 字节余量里。
 */
export function splitManifestSegs(segs: Record<string, ManifestSegment>, quota: SyncQuota): Record<string, ManifestSegment>[] {
  const budget = manifestPartBudget(quota);
  const parts: Record<string, ManifestSegment>[] = [{}];
  let used = 0;
  for (const [id, seg] of Object.entries(segs)) {
    const b = dirEntryBytes(id, seg);
    if (used + b > budget && Object.keys(parts[parts.length - 1]!).length > 0) {
      parts.push({});
      used = 0;
    }
    parts[parts.length - 1]![id] = seg;
    used += b;
  }
  return parts;
}

/**
 * 超配额取舍（纯函数）：按 priority 升序依次放入，每段取第一个放得下的 variant（full -> reduced），
 * 都放不下则跳过（state=skipped，UI 显示“未同步”）。总字节与项数（含 manifest 分片）均不超过配额；
 * manifest 段目录超过单项上限时分片（splitManifestSegs），最多 SYNC_MAX_MANIFEST_PARTS 片。
 * kept 为需原样保留的远端段（本机未启用的类别），先计入占用；keptBytes 为其实际字节（未知时按满切片估算）。
 */
export function planSyncLayout(
  candidates: SegmentCandidate[],
  quota: SyncQuota,
  kept: Record<string, ManifestSegment> = {},
  keptBytes: Record<string, number> = {},
): SyncPlan {
  const budgetBytes = quota.quotaBytes - quota.reserveBytes;
  const partBudget = manifestPartBudget(quota);
  // manifest 固定部分（第 0 片的 v/device/at/parts）
  const manifestFixed = syncItemBytes(SYNC_MANIFEST_KEY, { v: 1, device: 'x'.repeat(36), at: Date.now(), segs: {}, parts: 99 });
  /** 段目录字节（不含固定部分）；按片估算：每片另计键名与外层结构约 32 字节 */
  let dirBytes = 0;
  // 贪心切片每片末尾可能浪费不到一个目录项（约 100 字节），按每片少 128 字节估算，保证实际片数不超过估算
  const partsFor = (dir: number) => Math.max(1, Math.ceil(dir / (partBudget - 128)));
  const manifestTotal = (dir: number) => manifestFixed + dir + (partsFor(dir) - 1) * 32;
  let bytes = 0;
  /** 段切片项数（manifest 片数另算） */
  let items = 0;
  const usage: SegmentUsage[] = [];
  for (const [id, seg] of Object.entries(kept)) {
    const segBytes = keptBytes[id] ?? seg.n * quota.quotaBytesPerItem;
    bytes += segBytes;
    items += seg.n;
    dirBytes += manifestEntryBytes(id, seg);
    usage.push({ id, kind: seg.kind, label: id, bytes: segBytes, items: seg.n, state: 'kept' });
  }
  const segments: PlannedSegment[] = [];
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority)) {
    let placed = false;
    for (const v of c.variants) {
      const chunks = chunkString(v.encoded, chunkCapacity(quota, c.id));
      const segBytes = chunks.reduce((sum, ch, i) => sum + syncItemBytes(syncChunkKey(c.id, i), ch), 0);
      const entry = { kind: c.kind, n: chunks.length, at: c.at, level: v.level };
      const nextDir = dirBytes + manifestEntryBytes(c.id, entry);
      if (
        bytes + segBytes + manifestTotal(nextDir) <= budgetBytes &&
        items + chunks.length + partsFor(nextDir) <= quota.maxItems &&
        partsFor(nextDir) <= SYNC_MAX_MANIFEST_PARTS
      ) {
        bytes += segBytes;
        items += chunks.length;
        dirBytes = nextDir;
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
    usage: { bytes: bytes + manifestTotal(dirBytes), quotaBytes: quota.quotaBytes, items: items + partsFor(dirBytes), maxItems: quota.maxItems, segments: usage },
  };
}
