import { normalizeSurface, ruleCandidates } from './rules';
import type { LemmaAnalysis, Lemmatizer } from './types';

/**
 * 打包的词形还原数据（scripts/lemma/build-lemma-data.mjs 生成，public/data/lemma/lemma.json）。
 * e：词 -> "屈折原形1,屈折原形2|派生词根1,派生词根2"；空串表示该词不做任何还原（news、business）。
 * 只收录规则处理不对的词（不规则变化、规则会误生成真实词的词、派生词），其余词运行时走规则。
 */
export interface LemmaDataFile {
  v: 1;
  e: Record<string, string>;
}

const EMPTY: string[] = [];

/**
 * 数据驱动的词形还原：覆盖表优先，未收录的词走规则兜底。
 *
 * - 词汇表内的词（考试词 + COCA/BNC 前 3 万 + 其屈折变形）结果与构建期真值一致：
 *   不规则变化查表、规则会误还原的词（used ↛ us、business ↛ busy、news ↛ new）被表纠正。
 * - 词汇表外的长尾词按规则生成候选，匹配阶段只接受词书中存在的候选。
 * - init 前（或数据加载失败）退化为纯规则，接口仍可用。
 */
export class DataLemmatizer implements Lemmatizer {
  private table: Map<string, string> | null = null;
  private loading: Promise<void> | null = null;
  /** analyze 结果缓存：同一页面大量重复单词，数据加载后清空一次 */
  private readonly cache = new Map<string, LemmaAnalysis>();

  constructor(private readonly loadData?: () => Promise<LemmaDataFile>) {}

  init(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.loadData) return;
      try {
        this.setData(await this.loadData());
      } catch (e) {
        // 数据缺失不影响扩展运行，只是退化为规则还原
        console.warn('[hnw] 词形还原数据加载失败，使用规则兜底', e);
      }
    })();
    return this.loading;
  }

  /** 直接注入数据（单测、构建期评测用） */
  setData(data: LemmaDataFile): void {
    this.table = new Map(Object.entries(data.e));
    this.cache.clear();
  }

  analyze(surface: string): LemmaAnalysis {
    const base = normalizeSurface(surface);
    const cached = this.cache.get(base);
    if (cached) return cached;
    let result: LemmaAnalysis;
    const entry = this.table?.get(base);
    if (entry !== undefined) {
      const bar = entry.indexOf('|');
      const infl = bar < 0 ? entry : entry.slice(0, bar);
      const deriv = bar < 0 ? '' : entry.slice(bar + 1);
      result = {
        base,
        inflections: infl ? infl.split(',') : EMPTY,
        derivations: deriv ? deriv.split(',') : EMPTY,
        fromTable: true,
      };
    } else {
      result = { base, ...ruleCandidates(base), fromTable: false };
    }
    this.cache.set(base, result);
    return result;
  }

  /** 契约：[小写原词, 去所有格形式, ...屈折原形, ...派生词根]，去重 */
  candidates(surface: string): string[] {
    const lower = surface.toLowerCase();
    const { base, inflections, derivations } = this.analyze(surface);
    const out = [lower];
    for (const c of [base, ...inflections, ...derivations]) if (!out.includes(c)) out.push(c);
    return out;
  }

  /**
   * 屈折原形（不含派生，对标 wink-lemmatizer / compromise 的 lemma）。
   * - 查表命中：表内第一个屈折原形（都是真实词），没有则为原词；
   * - 规则兜底：第一个满足 isWord 的屈折候选；都不是已知词且原词本身也不是已知词时（faxed、megapixels），
   *   取规则首选候选；否则为原词。isWord 一般为扩展打包词典的词条判定。
   */
  lemma(surface: string, isWord: (w: string) => boolean): string {
    const { base, inflections, fromTable } = this.analyze(surface);
    if (fromTable) return inflections[0] ?? base;
    return inflections.find(isWord) ?? (isWord(base) ? base : (inflections[0] ?? base));
  }

  /** 派生词根：最近一级派生词根（beautifully -> beautiful、loneliness -> lonely），没有则同 lemma() */
  root(surface: string, isWord: (w: string) => boolean): string {
    const { derivations, fromTable } = this.analyze(surface);
    return derivations.find((c) => fromTable || isWord(c)) ?? this.lemma(surface, isWord);
  }
}
