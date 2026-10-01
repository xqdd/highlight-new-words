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

/**
 * manifest 分片：段目录超过单项上限时，第 0 片仍在 `hnw:m`（含 parts 总片数），第 i≥1 片在 `hnw:m:<i>`（{ segs }）。
 * 段 id 不会是 'm'，所以与切片键 `hnw:<segId>:<i>` 不冲突。
 */
export function syncManifestPartKey(index: number): string {
  return index === 0 ? SYNC_MANIFEST_KEY : `${SYNC_MANIFEST_KEY}:${index}`;
}
/** manifest 最多分片数（每片约 90 个段目录项，16 片足够 1000+ 本本地词书，实际受 512 项与 100KB 总配额约束） */
export const SYNC_MAX_MANIFEST_PARTS = 16;

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
 * 写入节流：Chrome 限制 MAX_WRITE_OPERATIONS_PER_MINUTE=120、PER_HOUR=1800（每次 set/remove 调用计 1 次）。
 * 每次推送最多 2 次写操作（set + remove），防抖 + 最小间隔 + 最大等待保证：
 * - 连续改动时最迟 SYNC_PUSH_MAX_WAIT_MS 推送一次（其他设备不会长时间看不到变化）
 * - 本机写操作计数（滑动窗口）不超过上限的 80%，超出时延后到窗口释放
 */
export const SYNC_PUSH_DEBOUNCE_MS = 5_000;
/** 连续改动时，从第一次未推送的改动起最多等待这么久就推送（防抖的 maxWait） */
export const SYNC_PUSH_MAX_WAIT_MS = 30_000;
export const SYNC_MIN_PUSH_INTERVAL_MS = 10_000;
/** 触发每分钟写入上限后的退避时间 */
export const SYNC_RATE_LIMIT_BACKOFF_MS = 60_000;
/** 触发每小时写入上限后的退避上限（按本机写入记录推算窗口释放时间，没有记录时退避整 1 小时） */
export const SYNC_HOURLY_BACKOFF_MS = 60 * 60_000;
/** 本机自我限额（Chrome 上限的 80%） */
export const SYNC_WRITE_BUDGET = { perMinute: 96, perHour: 1440 } as const;

/** 段的同步级别：full=完整；reduced=降级（本地词书仅单词，不含释义） */
export type SegmentLevel = 'full' | 'reduced';

/**
 * 段的数据类别：SyncDataKind 三类 + sourceBooks（来源词书缓存，仅 WebDAV / 手动备份可选）+ credentials（勾选随同步上传的凭据）。
 * credentials 段受 include.settings 控制（凭据本质是设置的一部分）。
 */
export type SyncSegmentKind = SyncDataKind | 'sourceBooks' | 'credentials';

export interface ManifestSegment {
  kind: SyncSegmentKind;
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
  /** manifest 总片数（>1 时其余段目录在 `hnw:m:<i>`，见 syncManifestPartKey）；缺省为 1 */
  parts?: number;
}

/** manifest 第 i≥1 片 */
export interface SyncManifestPart {
  segs: Record<string, ManifestSegment>;
}

/** 待写入的段：variants 按偏好排列（先 full 再 reduced），规划时取第一个放得下的 */
export interface SegmentCandidate {
  id: string;
  kind: SyncSegmentKind;
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
  kind: SyncSegmentKind;
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
  /** 写频率退避：在此时间前不写入（phase=pending，自动重试）；持久化以便 SW 重启后仍遵守 */
  retryAt?: number;
  /** 非错误的提示（如“写入过于频繁，将于 10:32 自动重试”），phase=pending 时展示；error 只用于 phase=error */
  notice?: string;
}

// ---------------- 同步后端（SyncBackend，background 第 3 轮新增） ----------------

/** 同步后端：chrome.storage.sync、WebDAV；手动备份导入导出不是持续同步的后端，复用同一套快照与合并（见 backup.ts） */
export type SyncBackendId = 'storage-sync' | 'webdav';

/** WebDAV 等非 storage.sync 后端的同步状态（storage.sync 沿用 SyncStatus，字段兼容） */
export interface BackendSyncStatus {
  backend: SyncBackendId;
  enabled: boolean;
  phase: SyncPhase;
  /** 最近一次成功同步（拉取 + 推送完成）的时间 */
  lastSyncAt: number;
  lastPullAt: number;
  lastPushAt: number;
  error?: string;
  notice?: string;
  /** 远端快照大小（字节）与段数，仅展示 */
  remoteBytes?: number;
  segments?: number;
  /** 最近一次同步因并发写冲突（412）重试的次数，仅诊断 */
  conflictRetries?: number;
  /** 服务器限流退避：此时间前不请求（phase=pending） */
  retryAt?: number;
  /**
   * 待复查时间（WebDAV 服务器不支持锁时，写入后 5–15 秒复查一轮）：持久化以便 SW 在复查前被回收时，
   * 下次启动立即补做（第 5 轮新增，可选）
   */
  recheckAt?: number;
  /** 本机设备 id（写入远端文件的 device 字段） */
  deviceId?: string;
}

/** 手动备份文件格式标识 */
export const BACKUP_FORMAT = 'highlight-new-words-backup';
export type BackupImportMode = 'merge' | 'overwrite';

/** 某一类数据的导入差异计数 */
export interface BackupDiffCount {
  /** 本机没有、导入后新增 */
  added: number;
  /** 导入后从本机删除（合并时因备份中的删除记录更新；覆盖时因备份中没有） */
  removed: number;
  /** 本机已有、内容不同、导入后变为备份中的版本 */
  updated: number;
  /** 两边都有且不同的条目数（合并时按时间取较新者，覆盖时以备份为准） */
  conflicts: number;
}

/** 导入预览（只读，不写本机） */
export interface BackupImportPreview {
  mode: BackupImportMode;
  /** 备份导出时间与来源设备 */
  exportedAt: number;
  device?: string;
  settings: { changed: boolean; willApply: boolean; conflict: boolean };
  knownWords: BackupDiffCount;
  localBooks: BackupDiffCount;
  sourceBooks?: BackupDiffCount;
  /** 将写入本机的凭据（只有备份中含有、且本机勾选“随同步上传”的凭据） */
  credentials: string[];
  /** 汇总：added/removed/updated/conflicts 之和 */
  total: BackupDiffCount;
  /** 简短中文说明 */
  summary: string;
}

export interface BackupImportResult {
  ok: boolean;
  preview: BackupImportPreview;
  message: string;
}

/** exportBackup 结果：content 为 JSON 文本，或 gzip 后的 base64（compress=true） */
export interface BackupExport {
  fileName: string;
  mime: string;
  encoding: 'json' | 'gzip-base64';
  content: string;
  /** 原始 JSON 字节数 */
  bytes: number;
  /** skippedCredentials：勾选了随同步上传、但导出时未传 includeCredentials 而未写入备份的凭据数（第 4 轮新增，可选） */
  counts: { knownWords: number; localBooks: number; sourceBooks: number; credentials: number; skippedCredentials?: number };
}

/** WebDAV 连接测试结果（逐步说明，options 直接展示） */
export interface WebDavTestResult {
  ok: boolean;
  message: string;
  steps: { step: string; ok: boolean; detail?: string }[];
}
