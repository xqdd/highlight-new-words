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
 *
 * 用户词书（来源/本地导入）与熟词本的条目可能是变形写法（欧路“已掌握”里的 criteria、导入文件里的 studies）：
 * 构造时为这些条目额外建立“条目 -> 屈折原形”索引（只做屈折还原，不做派生），
 * 页面上的原形及其他变形（criterion、study/studied）也按该条目判定为熟词/生词。
 */
export class WordMatcher {
  private readonly cache = new Map<string, MatchResult | null>();
  /** 熟词本条目的屈折原形（熟词本只有 criteria 时含 criterion） */
  private readonly knownLemmas = new Set<string>();
  /** 用户词书 id -> 其条目的屈折原形集合（生词本只有 studies 时含 study） */
  private readonly userBookLemmas = new Map<string, Set<string>>();
  /** 用户词书中变形条目 -> 屈折原形（studies -> study），命中变形条目时 lemma 归一到原形 */
  private readonly entryLemma = new Map<string, string>();

  constructor(private readonly opts: WordMatcherOptions) {
    for (const w of opts.known) for (const l of this.inflectionLemmas(w)) this.knownLemmas.add(l);
    for (const b of opts.books) {
      if (b.meta.kind === 'builtin') continue; // 内置词书本身就是原形
      const set = new Set<string>();
      for (const w of b.words()) {
        const lemmas = this.inflectionLemmas(w);
        for (const l of lemmas) set.add(l);
        if (lemmas[0] && !this.entryLemma.has(w)) this.entryLemma.set(w, lemmas[0]);
      }
      this.userBookLemmas.set(b.meta.id, set);
    }
  }

  /**
   * 词书/熟词本条目的屈折原形（不含条目自身）。查表结果都是真实词，全部采用（lives -> life, live）；
   * 规则兜底可能生成不存在的词（studies -> study, studie），无害（页面不会出现），
   * 但 -er/-est 结尾的表外词多为施事名词（runner），规则会误当比较级还原，不采用（与 background/forms 的删除判定一致）。
   */
  private inflectionLemmas(word: string): string[] {
    const a = this.opts.lemmatizer.analyze?.(word);
    if (!a || (!a.fromTable && /(?:er|est)$/.test(a.base))) return [];
    return a.inflections.filter((l) => l !== word);
  }

  private bookHas(b: WordBook, w: string): boolean {
    return b.has(w) || !!this.userBookLemmas.get(b.meta.id)?.has(w);
  }

  match(surface: string): MatchResult | null {
    const key = surface.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached && { ...cached, surface };
    const result = this.compute(key);
    this.cache.set(key, result);
    return result && { ...result, surface };
  }

  /**
   * 页面词形的屈折原形（projections -> projection、citing -> cite；不含派生词根）。
   * 用于查释义：派生词借词根命中词书时（projections 命中 project），释义应取屈折原形自己的词条，而不是词根的。
   * 词形还原器不提供 analyze 或没有屈折变化时返回 undefined。
   */
  inflectionOf(surface: string): string | undefined {
    return this.opts.lemmatizer.analyze?.(surface).inflections[0];
  }

  private compute(key: string): MatchResult | null {
    const { lemmatizer, books, known } = this.opts;
    if (books.length === 0) return null;
    const candidates = lemmatizer.candidates(key);
    if (candidates.some((c) => known.has(c) || this.knownLemmas.has(c))) return null;
    for (const c of candidates) {
      if (!books.some((b) => this.bookHas(b, c))) continue;
      // 只命中了用户词书里的变形条目（studies）：lemma 归一到屈折原形，卡片“认识”/删除写入原形，不再产生变形熟词。
      // 规则兜底的原形可能不存在（abandone），只有查表结果或某本词书收录该原形时才归一
      const base = this.entryLemma.get(c);
      const normalize =
        base !== undefined &&
        !books.some((b) => b.meta.kind === 'builtin' && b.has(c)) &&
        (lemmatizer.analyze?.(c).fromTable || books.some((b) => b.has(base)));
      const lemma = normalize ? base : c;
      const bookIds = books.filter((b) => this.bookHas(b, lemma) || b.has(c)).map((b) => b.meta.id);
      return { surface: key, lemma, bookIds };
    }
    return null;
  }
}
