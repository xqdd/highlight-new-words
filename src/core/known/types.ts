/**
 * 熟词本契约（storage `knownWords` 键）。
 *
 * 为支持多设备合并（storage.sync），熟词带时间戳并保留删除墓碑：
 * - words：熟词（小写原形）-> 加入时间 ms
 * - removed：已撤销的熟词 -> 撤销时间 ms（墓碑），超过 KNOWN_TOMBSTONE_TTL 后清理
 * 合并规则见 merge.ts 的 mergeKnownWords：并集，同一词取最新的“加入/撤销”动作。
 */
export interface KnownWordsData {
  words: Record<string, number>;
  removed: Record<string, number>;
}

/** 墓碑保留 180 天：超过此时长未同步的设备可能“复活”已撤销的熟词，可接受 */
export const KNOWN_TOMBSTONE_TTL = 180 * 24 * 60 * 60 * 1000;

/** 熟词本导出格式 */
export type KnownExportFormat = 'txt' | 'csv';
