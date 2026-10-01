import { normalizeKnown } from '../known/merge';
import type { KnownWordsData } from '../known/types';
import { getOwn, setOwn } from '../storage/own-record';
import type { SegmentLevel } from './types';

/**
 * 熟词本同步段的紧凑编码（压缩前），比直接 JSON {词: 毫秒时间} 小 40%~60%：
 * - 单词按字母序用 '\n' 拼成一个字符串（相邻词前缀相同，deflate 压缩率高）
 * - 加入时间与单词一一对应，存为相对最早时间的 base36 整数，用 ',' 拼接
 *   - full：秒精度
 *   - reduced：天精度（超配额时的降级，同一天内先删后加/先加后删的顺序可能判断不准）
 * - 墓碑（撤销记录，通常很少）保持毫秒精度原样
 *
 * 实测（ECDICT 真实单词，加入时间在一年内随机分布）：1.5 万词 full ≈ 142KB、reduced ≈ 92KB（base64 后）；
 * 同一时间批量导入的 1.5 万词 full ≈ 62KB。
 */
export interface KnownSegment {
  /** 编码版本 */
  f: 2;
  /** 时间单位毫秒数：1000（秒）或 86400000（天） */
  u: number;
  /** 基准时间（单位数） */
  b: number;
  /** 字母序单词，'\n' 分隔 */
  w: string;
  /** 与 w 对应的相对时间（base36），',' 分隔 */
  t: string;
  /** 墓碑：词 -> 撤销时间 ms */
  r: Record<string, number>;
}

const UNIT: Record<SegmentLevel, number> = { full: 1000, reduced: 86_400_000 };

export function encodeKnownSegment(data: KnownWordsData, level: SegmentLevel): KnownSegment {
  const unit = UNIT[level];
  const words = Object.keys(data.words).sort();
  const units = words.map((w) => Math.floor((getOwn(data.words, w) ?? 0) / unit));
  const base = units.length ? Math.min(...units) : 0;
  return { f: 2, u: unit, b: base, w: words.join('\n'), t: units.map((x) => (x - base).toString(36)).join(','), r: { ...data.removed } };
}

/** 解码；兼容早期直接存 KnownWordsData 的段 */
export function decodeKnownSegment(raw: unknown): KnownWordsData {
  const seg = raw as Partial<KnownSegment> | undefined;
  if (!seg || seg.f !== 2) return normalizeKnown(raw);
  const words: Record<string, number> = {};
  if (seg.w) {
    const list = seg.w.split('\n');
    const times = (seg.t ?? '').split(',');
    list.forEach((w, i) => setOwn(words, w, ((seg.b ?? 0) + parseInt(times[i] ?? '0', 36)) * (seg.u ?? 1000)));
  }
  return { words, removed: { ...(seg.r ?? {}) } };
}
