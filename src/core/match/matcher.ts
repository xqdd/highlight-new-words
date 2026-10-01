import type { Lemmatizer } from '../lemma/types';
import type { BookId } from '../settings/schema';
import type { WordBook } from '../wordbook/types';

/** 匹配结果 */
export interface MatchResult {
  /** 页面上的原始单词 */
  surface: string;
  /** 命中的词条（小写原形或词书中收录的原词） */
  lemma: string;
  /** 命中的词书 id，按启用顺序（优先级）排列，首个决定高亮样式 */
  bookIds: BookId[];
}

export interface WordMatcherOptions {
  lemmatizer: Lemmatizer;
  /** 已加载的启用词书，顺序即优先级 */
  books: WordBook[];
  /** 熟词本（小写） */
  known: ReadonlySet<string>;
}

/**
 * 匹配服务：surface -> {lemma, bookIds}。
 *
 * 规则：
 * 1. 熟词优先：surface 的任一候选原形在熟词本中则不匹配（known wins）
 * 2. 按候选顺序（原词优先，其次还原形式）找到第一个出现在任一启用词书中的候选作为 lemma
 * 3. bookIds 收集包含该 lemma 的全部启用词书
 * 结果按小写 surface 缓存，同一页面重复单词只计算一次。
 */
export class WordMatcher {
  private readonly cache = new Map<string, MatchResult | null>();

  constructor(private readonly opts: WordMatcherOptions) {}

  match(surface: string): MatchResult | null {
    const key = surface.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached && { ...cached, surface };
    const result = this.compute(key);
    this.cache.set(key, result);
    return result && { ...result, surface };
  }

  private compute(key: string): MatchResult | null {
    const { lemmatizer, books, known } = this.opts;
    if (books.length === 0) return null;
    const candidates = lemmatizer.candidates(key);
    if (candidates.some((c) => known.has(c))) return null;
    for (const c of candidates) {
      const bookIds = books.filter((b) => b.has(c)).map((b) => b.meta.id);
      if (bookIds.length > 0) return { surface: key, lemma: c, bookIds };
    }
    return null;
  }
}
