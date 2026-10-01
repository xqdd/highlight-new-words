import type { SyncPlan } from './plan';
import type { ManifestSegment, SegmentCandidate, SyncBackendId } from './types';

/**
 * 同步后端抽象（追加需求 v4 第 11 条）。
 *
 * 快照 = 若干“段”（settings / known / lbr / lb:<id> / sb:<id> / cred），每段 JSON → deflate-raw → base64（codec.ts），
 * 段的构造与合并只在 snapshot.ts 中实现一次，各后端只负责传输：
 *
 * | 后端 | 存储形式 | 版本（乐观并发） | 容量 |
 * | --- | --- | --- | --- |
 * | storage-sync | `hnw:m` manifest + `hnw:<段>:<i>` 切片 | manifest 的 device@at | 100KB/8KB/512 项，plan 取舍 |
 * | webdav | `<dir>/hnw-sync.json` 单文件（段目录 + 段数据） | HTTP ETag（If-Match / If-None-Match: *） | 不限 |
 *
 * 冲突语义：write 发现远端在 read 之后被其他设备改过（ETag 不符 → 412、manifest 版本变化）时抛 SyncConflictError，
 * 不写任何数据；调用方（runSyncCycle）重新 read → 合并到本机 → 重新规划 → 再写，最多 maxAttempts 次。
 * 合并本身满足交换律与幂等（熟词并集 + 墓碑、设置与本地词书按时间 LWW），所以重试不会丢数据。
 */

/** 远端快照（read 的结果） */
export interface RemoteSnapshot {
  /** 远端版本标识；远端还没有数据时为 null */
  version: string | null;
  /** 段目录 */
  segs: Record<string, ManifestSegment>;
  /** 段目录不完整（storage.sync manifest 分片缺失）：缺失的段视为未知，不拉取、不当作删除 */
  incomplete?: boolean;
  /** 读取某段的编码数据；缺片、哈希与目录不符时返回 undefined（该段本轮跳过） */
  readSegment(id: string): Promise<string | undefined>;
  /** 远端快照占用字节（展示用） */
  bytes?: number;
}

export interface BackendWriteResult {
  /** 是否真的写了远端（内容无变化时为 false） */
  wrote: boolean;
  version: string | null;
  /** 本次写操作次数（storage.sync 计入写频率限额） */
  writeOps: number;
}

export interface SyncBackend {
  readonly id: SyncBackendId;
  /** 读取远端快照（全量段目录，段数据可懒读取） */
  read(): Promise<RemoteSnapshot>;
  /** 只读远端版本与段目录（廉价操作，用于展示与写前检查） */
  list(): Promise<{ version: string | null; segs: Record<string, ManifestSegment> }>;
  /**
   * 按后端容量规划要写入的段：storage.sync 按配额取舍（plan.ts 的 planSyncLayout），其他后端全部写入。
   * kept 为远端已有、本机未启用该类别的段（原样保留，可能是其他设备的数据）。
   */
  plan(candidates: SegmentCandidate[], base: RemoteSnapshot, kept: Record<string, ManifestSegment>): SyncPlan;
  /** 写入规划结果；远端版本已不是 base.version 时抛 SyncConflictError（不写任何数据） */
  write(plan: SyncPlan, base: RemoteSnapshot, deviceId: string): Promise<BackendWriteResult>;
  /** 远端用量（字节；有配额的后端附配额） */
  getUsage(): Promise<{ bytes: number; quotaBytes?: number }>;
}

/** 写入冲突：远端在本次读取之后被其他设备修改 */
export class SyncConflictError extends Error {
  constructor(message = '远端数据已被其他设备修改') {
    super(message);
    this.name = 'SyncConflictError';
  }
}

/** 后端可读的错误（认证失败、未授权、网络错误等），message 为给用户看的中文 */
export class SyncBackendError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'permission' | 'network' | 'notfound' | 'quota' | 'ratelimit' | 'server' | 'config',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncBackendError';
  }
}
