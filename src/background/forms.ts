import type { Lemmatizer } from '@/core/lemma/types';
import { inflectionRuleCandidates, normalizeSurface } from '@/core/lemma/rules';

/**
 * 删除/移除用的“同原形词形”判定（只看屈折变化，不含派生）。
 *
 * 为什么不复用高亮匹配的候选链（core/match/forms.ts 的 findWordFormsOfLemma）：
 * 高亮候选链 = [原词, 屈折原形, 派生词根链]，runner→run、careless/careful/carelessly→care、ability→able 都在链上。
 * 高亮时这样做没有风险（熟词 care 让 careless 不高亮），但远端删除不可恢复（有道只能加回默认分组、欧路 cookie 模式加不回），
 * 所以删除集合必须更保守：生词本中的词 w 只有在下面两种情况才算 target 的词形：
 *   1. w 本身就是 target（大小写不敏感）；
 *   2. w 经屈折还原（复数/三单/-ed/-ing/比较级/不规则形 went、gone、better）得到 target。
 * 屈折原形来自 Lemmatizer#analyze 的 inflections（DataLemmatizer 查表 + 规则兜底），未实现 analyze 的实现退回纯屈折规则。
 *
 * 已知取舍：数据表中个别词是同形异义（lay 既是 lie 的过去式也是原形动词、found 既是 find 的过去式也是 found 原形），
 * 标记 lie 会删除生词本里的 lay。调用方在确认提示中列出将删除的词（previewWordAction），由用户确认。
 */
export function inflectionalLemmas(word: string, lemmatizer: Lemmatizer): string[] {
  const analysis = lemmatizer.analyze?.(word);
  if (analysis?.fromTable) return [analysis.base, ...analysis.inflections];
  // 数据表未收录（或实现不提供 analyze）：走屈折规则，但不接受 -er/-est 的还原。
  // 常见比较级（bigger/better）都在表内；表外以 -er 结尾的长尾词绝大多数是施事名词（runner、zapper），
  // 规则会把它们当比较级还原成 run/zap，用于删除时就会误删
  const base = analysis?.base ?? normalizeSurface(word);
  if (/(?:er|est)$/.test(base)) return [base];
  return [base, ...(analysis?.inflections ?? inflectionRuleCandidates(base))];
}

/**
 * 在一组词条 key（小写）中找出 target 的屈折词形（含 target 本身）。
 * sameLemma=false（同原形开关关闭）时只处理当前词形 surface 与 target 本身，不做任何还原。
 */
export function findInflectedForms(
  target: string,
  words: Iterable<string>,
  lemmatizer: Lemmatizer,
  opts: { sameLemma: boolean; surface?: string } = { sameLemma: true },
): string[] {
  const t = target.toLowerCase();
  const surface = opts.surface?.toLowerCase();
  const out: string[] = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw === t || (surface && lw === surface)) out.push(w);
    else if (opts.sameLemma && inflectionalLemmas(lw, lemmatizer).includes(t)) out.push(w);
  }
  return out;
}

/**
 * 同形异义词形（后台层删除保护）：删除集合中“本身也是独立单词”的不规则词形，如 lie 的 lay（放置）、find 的 found（创立）、
 * see 的 saw（锯子）、wind 的 wound（伤口）。判定：
 *   1. 不是 target 本身，也不是用户点的页面词形 surface；
 *   2. 不能由屈折规则从该词还原到 target（running/runs/studied 这类规则变化不算）；
 *   3. 打包词典中该词有自己的屈折变化（laid、founded、sawing…），说明它也是一个原形词。
 * 词典缺失该词（ran、went、lain 没有独立词条）时不算同形异义。
 * 这些词的远端删除必须带 confirmed（用户在确认框中看过）才执行，见 known.ts#markKnown。
 */
export async function findHomographForms(
  keys: string[],
  target: string,
  surface: string,
  lookupForms: (word: string) => Promise<{ word: string }[] | undefined>,
): Promise<string[]> {
  const t = target.toLowerCase();
  const out: string[] = [];
  for (const k of keys) {
    const w = k.toLowerCase();
    if (w === t || w === surface.toLowerCase()) continue;
    if (inflectionRuleCandidates(w).includes(t)) continue;
    const forms = await lookupForms(w);
    if (forms?.some((f) => f.word.toLowerCase() !== w)) out.push(k);
  }
  return out;
}
