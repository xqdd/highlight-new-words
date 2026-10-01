import { getOwn, hasOwnKey, setOwn } from '../storage/own-record';
import { KNOWN_TOMBSTONE_TTL, type KnownWordsData } from './types';

/** 空熟词本 */
export function createEmptyKnown(): KnownWordsData {
  return { words: {}, removed: {} };
}

/**
 * 把存储中读出的值规范化为 KnownWordsData。
 * 兼容 v3 开发期的 string[] 结构（未发布，仅为开发者本机数据不丢失），时间记为 0。
 */
export function normalizeKnown(raw: unknown): KnownWordsData {
  if (Array.isArray(raw)) return { words: Object.fromEntries(raw.map((w) => [String(w).toLowerCase(), 0])), removed: {} };
  if (!raw || typeof raw !== 'object') return createEmptyKnown();
  const r = raw as Partial<KnownWordsData>;
  return { words: { ...(r.words ?? {}) }, removed: { ...(r.removed ?? {}) } };
}

/**
 * 加入/撤销熟词（纯函数，返回新对象）；words 统一转小写。
 * 单词作 key 一律走 own-record（constructor、__proto__ 等单词不能命中原型链或改写原型）
 */
export function applyKnownChange(data: KnownWordsData, words: Iterable<string>, known: boolean, now = Date.now()): KnownWordsData {
  const next: KnownWordsData = { words: { ...data.words }, removed: { ...data.removed } };
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (known) {
      setOwn(next.words, w, now);
      delete next.removed[w];
    } else if (hasOwnKey(next.words, w)) {
      delete next.words[w];
      setOwn(next.removed, w, now);
    }
  }
  return next;
}

/**
 * 多设备合并：并集 + 墓碑。
 * 同一词取两侧最新的加入时间 added 与最新的撤销时间 removed，added > removed 则为熟词，否则保留墓碑。
 * 同时清理超过 KNOWN_TOMBSTONE_TTL 的墓碑。合并满足交换律与幂等，可重复执行。
 */
export function mergeKnownWords(a: KnownWordsData, b: KnownWordsData, now = Date.now()): KnownWordsData {
  const out = createEmptyKnown();
  const all = new Set([...Object.keys(a.words), ...Object.keys(b.words), ...Object.keys(a.removed), ...Object.keys(b.removed)]);
  for (const w of all) {
    const added = Math.max(getOwn(a.words, w) ?? -1, getOwn(b.words, w) ?? -1);
    const removed = Math.max(getOwn(a.removed, w) ?? -1, getOwn(b.removed, w) ?? -1);
    if (added > removed) setOwn(out.words, w, added);
    else if (now - removed < KNOWN_TOMBSTONE_TTL) setOwn(out.removed, w, removed);
  }
  return out;
}
