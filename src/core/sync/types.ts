import type { SyncDataKind } from '../settings/schema';

/**
 * storage.sync 跨设备同步契约（background 分片拥有实现，UI 只读 SyncStatus）。
 *
 * 数据切分为“段（segment）”，每段独立压缩（deflate-raw + base64）后切片写入 storage.sync：
 * - `settings`：设置（去掉本机字段 sync 与各来源 apiToken），按 updatedAt LWW
 * - `known`：熟词本（含墓碑），并集合并；紧凑编码见 known-codec.ts（超配额时降级为天精度时间）
 * - `lbr`：本地词书删除墓碑
 * - `lb:<uuid>`：每本本地导入词书一段（超配额时先降级为仅单词、再整本跳过）
 * 云端来源词书不同步（各设备可重新拉取）。
 *
 * storage.sync 键：
 * - `hnw:m`：SyncManifest（各段的切片数、哈希、更新时间）
 * - `hnw:<segId>:<i>`：第 i 个切片（base64 字符串）
 */

export const SYNC_MANIFEST_KEY = 'hnw:m';
export const SYNC_CHUNK_KEY_PREFIX = 'hnw:';

export function syncChunkKey(segId: string, index: number): string {
  return `${SYNC_CHUNK_KEY_PREFIX}${segId}:${index}`;
}

/** chrome.storage.sync 配额（与 chrome.storage.sync.QUOTA_* 常量一致；运行时优先读取 API 上的值） */
export interface SyncQuota {
  /** 总字节（键长 + JSON 序列化值长度），Chrome 为 102400 */
  quotaBytes: number;
  /** 单项字节，Chrome 为 8192 */
  quotaBytesPerItem: number;
  /** 最多项数，Chrome 为 512 */
  maxItems: number;
  /** 预留余量字节（不计划用满，避免边界误差导致整次写入失败） */
  reserveBytes: number;
}

export const DEFAULT_SYNC_QUOTA: SyncQuota = {
  quotaBytes: 102400,
  quotaBytesPerItem: 8192,
  maxItems: 512,
  reserveBytes: 2048,
};

/**
 * 写入节流：Chrome 限制 MAX_WRITE_OPERATIONS_PER_MINUTE=120、PER_HOUR=1800。
 * 每次推送最多 2 次写操作（set + remove），防抖 + 最小间隔保证远低于上限。
 */
export const SYNC_PUSH_DEBOUNCE_MS = 5_000;
export const SYNC_MIN_PUSH_INTERVAL_MS = 10_000;
/** 触发写频率限制后的退避时间 */
export const SYNC_RATE_LIMIT_BACKOFF_MS = 60_000;

/** 段的同步级别：full=完整；reduced=降级（本地词书仅单词，不含释义） */
export type SegmentLevel = 'full' | 'reduced';

export interface ManifestSegment {
  kind: SyncDataKind;
  /** 切片数 */
  n: number;
  /** 编码后字符串的短哈希，用于判断是否需要重写 */
  h: string;
  /** 段内数据的更新时间（settings.updatedAt / 本地词书 updatedAt），仅展示与诊断 */
  at: number;
  level: SegmentLevel;
}

export interface SyncManifest {
  v: 1;
  /** 最近一次写入的设备 id（随机，存于本机 syncState） */
  device: string;
  /** 最近一次写入时间 */
  at: number;
  segs: Record<string, ManifestSegment>;
}

/** 待写入的段：variants 按偏好排列（先 full 再 reduced），规划时取第一个放得下的 */
export interface SegmentCandidate {
  id: string;
  kind: SyncDataKind;
  /** 数值越小越优先：settings 0、known 1、lbr 2、本地词书 10+ */
  priority: number;
  at: number;
  /** UI 展示名（如本地词书名） */
  label: string;
  variants: { level: SegmentLevel; encoded: string }[];
}

/** 段在本次规划中的结果 */
export type SegmentSyncState = 'synced' | 'reduced' | 'skipped' | 'kept';

export interface SegmentUsage {
  id: string;
  kind: SyncDataKind;
  label: string;
  bytes: number;
  items: number;
  /** synced=完整同步；reduced=降级同步；skipped=超配额未同步；kept=本机未启用该类同步，保留远端已有数据 */
  state: SegmentSyncState;
}

export interface SyncUsage {
  bytes: number;
  quotaBytes: number;
  items: number;
  maxItems: number;
  segments: SegmentUsage[];
}

export type SyncPhase = 'disabled' | 'idle' | 'pending' | 'syncing' | 'error';

/** storage.local `syncState`：同步状态（background 写，UI 读/监听） */
export interface SyncStatus {
  enabled: boolean;
  phase: SyncPhase;
  /** 本机设备 id */
  deviceId: string;
  lastPushAt: number;
  lastPullAt: number;
  error?: string;
  /** 最近一次规划的用量（含超配额被跳过的段） */
  usage?: SyncUsage;
}
