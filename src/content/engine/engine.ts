import type { Dictionary } from '@/core/dict/types';
import type { MatchResult, WordMatcher } from '@/core/match/matcher';
import type { InlineTranslationMode } from '@/core/settings/schema';
import { isLightText } from './color';
import { ATTR_LEMMA, ATTR_ON_DARK, TAG_MARK, isInsideOwnNode } from './dom';
import {
  dropGroup,
  hasFragments,
  highlightTextNode,
  ownerTextOf,
  restoreGroup,
  setMarkTranslation,
  unwrapAll,
} from './highlighter';
import { createTextWalker, isRootSkipped, isTextCandidate } from './scanner';

export interface EngineOptions {
  root: HTMLElement;
  matcher: WordMatcher;
  dictionary: Dictionary;
  inlineTranslation: InlineTranslationMode;
  /** 已高亮的不同词条集合变化（节流后）回调，用于徽章计数上报 */
  onLemmasChanged?: (lemmas: string[]) => void;
}

/** 每个处理切片的时间预算上下限（ms）：空闲回调给多少用多少，但不超过上限，避免长任务卡顿 */
const SLICE_MIN_MS = 4;
const SLICE_MAX_MS = 12;
const REPORT_DELAY_MS = 400;
/** 页面明暗主题切换（html/body 的 class/style 等属性变化）后，重新判断深色上下文的防抖时间 */
const THEME_RECHECK_MS = 300;
/** 队列已消费部分超过该长度时压缩数组，避免 shift() 的 O(n) 开销 */
const QUEUE_COMPACT_AT = 1024;

/**
 * 高亮引擎：初次全量扫描 + MutationObserver 增量处理 + 行内翻译填充。
 *
 * 流程：待处理根节点入队 -> 用可恢复的 TreeWalker 逐个取文本节点、按时间预算切片处理
 * -> 每片结束后统一读取上下文明暗（先写后读，一片只触发一次样式计算）-> 批量查询词典填充行内翻译。
 *
 * 与页面框架共存（SPA）：页面原始文本节点始终留在原位（见 highlighter 切分组），
 * 页面改写其内容时丢弃旧片段重做，删除/移动它时把片段文字拼回，保证不重复、不丢字、框架持有的引用不失效。
 * 自身 DOM 改动引起的 mutation 通过 observer.takeRecords() 丢弃，不会自我触发。
 */
export class HighlightEngine {
  /** 待展开的根节点（新插入的子树、被改写的文本节点等），queueHead 之前的已消费 */
  private queue: Node[] = [];
  private queueHead = 0;
  /** 正在遍历的子树 */
  private walker: TreeWalker | null = null;
  /** 已处理且无需再扫描的文本节点（含已切分的原节点与剩余片段）；内容被改写时移除 */
  private processed = new WeakSet<Text>();
  private readonly lemmas = new Set<string>();
  private readonly translations = new Map<string, string | null>();
  /** 乐观移除（标记熟词）的词条：在 matcher 更新前也不再高亮，rebuild 时清空 */
  private readonly suppressed = new Set<string>();
  /** 元素 -> 是否深色上下文 的缓存（页面主题切换时整体重算） */
  private darkCache = new WeakMap<Element, boolean>();
  private observer?: MutationObserver;
  private themeObserver?: MutationObserver;
  private colorSchemeQuery?: MediaQueryList;
  private themeTimer?: ReturnType<typeof setTimeout>;
  private themeRecheck?: () => void;
  private scheduled = false;
  private stopped = true;
  private reportTimer?: ReturnType<typeof setTimeout>;
  private recountTimer?: ReturnType<typeof setTimeout>;

  constructor(private opts: EngineOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.opts.root, { childList: true, subtree: true, characterData: true });
    this.watchPageTheme();
    this.enqueue(this.opts.root);
  }

  /** 停止并移除全部高亮（DOM 还原为高亮前的文本节点） */
  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = undefined;
    this.unwatchPageTheme();
    this.queue = [];
    this.queueHead = 0;
    this.walker = null;
    this.processed = new WeakSet();
    this.darkCache = new WeakMap();
    this.suppressed.clear();
    unwrapAll(this.opts.root);
    if (this.lemmas.size > 0) {
      this.lemmas.clear();
      this.scheduleReport();
    }
  }

  /** 匹配数据（启用词书、用户词书新增词等）变化后：移除全部高亮并按新 matcher 重扫 */
  rebuild(matcher: WordMatcher, dictionary: Dictionary): void {
    this.stop();
    this.opts = { ...this.opts, matcher, dictionary };
    this.translations.clear();
    this.start();
  }

  /**
   * 只会“减少命中”的数据变化（新增熟词、来源删词）时使用：换用新 matcher，只重做含高亮的文本，
   * 不重扫全页；同步完成且释义取自缓存，页面不会闪烁。
   */
  refreshMatches(matcher: WordMatcher, dictionary: Dictionary): void {
    this.opts = { ...this.opts, matcher, dictionary };
    this.redoGroups(this.opts.root.querySelectorAll(TAG_MARK));
  }

  /** 行内翻译模式变化：off 时不再查询词典；切换为开启时为已有 mark 补齐翻译 */
  setInlineTranslation(mode: InlineTranslationMode): void {
    const prev = this.opts.inlineTranslation;
    this.opts.inlineTranslation = mode;
    if (prev === 'off' && mode !== 'off') {
      void this.fillTranslations([...this.opts.root.querySelectorAll<HTMLElement>(TAG_MARK)]);
    }
  }

  /** 立即移除某个词条（含其全部词形）的高亮，如标记为熟词后无需等待存储变化与重扫 */
  removeLemma(lemma: string): void {
    this.suppressed.add(lemma);
    this.redoGroups(this.opts.root.querySelectorAll(`${TAG_MARK}[${ATTR_LEMMA}="${CSS.escape(lemma)}"]`));
  }

  get matchedLemmas(): string[] {
    return [...this.lemmas];
  }

  // ---------------- 内部实现 ----------------

  /** 当前生效的匹配：matcher 结果再排除乐观移除的词条 */
  private readonly matchWord = (w: string): MatchResult | null => {
    const m = this.opts.matcher.match(w);
    return m && !this.suppressed.has(m.lemma) ? m : null;
  };

  /** 还原给定 mark 所在的切分组，并用当前 matcher 重新高亮（同步完成） */
  private redoGroups(marks: Iterable<Element>): void {
    const owners = new Set<Text>();
    for (const m of marks) {
      const o = ownerTextOf(m);
      if (o) owners.add(o);
    }
    if (owners.size === 0) return;
    const newMarks: HTMLElement[] = [];
    this.withoutObserving(() => {
      for (const o of owners) {
        restoreGroup(o);
        newMarks.push(...highlightTextNode(o, this.matchWord, (left) => this.processed.add(left)));
      }
      this.markDarkContexts(newMarks);
    });
    void this.fillTranslations(newMarks);
    this.recountLemmas();
  }

  private onMutations(records: MutationRecord[]): void {
    for (const r of records) {
      if (r.type === 'characterData') {
        const t = r.target as Text;
        if (hasFragments(t)) {
          // 页面（框架）改写了原文本节点：旧片段已过时，丢弃后按新内容重做
          this.withoutObserving(() => dropGroup(t));
        } else if (ownerTextOf(t) || isInsideOwnNode(t)) {
          continue;
        }
        this.processed.delete(t);
        this.enqueue(t);
        continue;
      }
      for (const n of r.removedNodes) {
        // 原文本节点被页面删除或移动：把片段文字拼回原节点并移除片段，避免残留重复文字
        if (n.nodeType === Node.TEXT_NODE && hasFragments(n as Text)) {
          this.withoutObserving(() => restoreGroup(n as Text));
          this.processed.delete(n as Text);
        }
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.TEXT_NODE) continue;
        if (isInsideOwnNode(n) || ownerTextOf(n)) continue;
        this.enqueue(n);
      }
    }
    if (records.some((r) => r.type === 'childList' && r.removedNodes.length > 0)) this.scheduleRecount();
  }

  private enqueue(node: Node): void {
    this.queue.push(node);
    if (!this.scheduled) {
      this.scheduled = true;
      scheduleIdle((budget) => this.drain(budget));
    }
  }

  /** 取下一个待处理文本节点：优先继续当前子树的遍历，遍历完再取队列中的下一个根 */
  private nextTextNode(): Text | null {
    for (;;) {
      if (this.walker) {
        const n = this.walker.nextNode() as Text | null;
        if (n) return n;
        this.walker = null;
      }
      if (this.queueHead >= this.queue.length) {
        this.queue = [];
        this.queueHead = 0;
        return null;
      }
      const root = this.queue[this.queueHead++]!;
      if (this.queueHead >= QUEUE_COMPACT_AT) {
        this.queue = this.queue.slice(this.queueHead);
        this.queueHead = 0;
      }
      if (!root.isConnected) continue;
      if (root.nodeType === Node.TEXT_NODE) {
        const t = root as Text;
        if (!this.processed.has(t) && isTextCandidate(t)) return t;
        continue;
      }
      if (root.nodeType === Node.ELEMENT_NODE && isRootSkipped(root as Element)) continue;
      this.walker = createTextWalker(root, (t) => this.processed.has(t));
    }
  }

  private hasPending(): boolean {
    return this.walker !== null || this.queueHead < this.queue.length;
  }

  /** 按时间预算处理队列 */
  private drain(budgetMs: number): void {
    this.scheduled = false;
    if (this.stopped) return;
    const deadline = performance.now() + Math.min(Math.max(budgetMs, SLICE_MIN_MS), SLICE_MAX_MS);
    const newMarks: HTMLElement[] = [];
    this.withoutObserving(() => {
      let t: Text | null;
      while (performance.now() < deadline && (t = this.nextTextNode())) {
        if (!t.isConnected) continue;
        newMarks.push(...highlightTextNode(t, this.matchWord, (left) => this.processed.add(left)));
        // 原节点处理后只剩首个命中词之前的文字，记为已处理；内容被改写时会从集合移除
        this.processed.add(t);
      }
      // 一片中的写操作全部完成后再统一读取计算样式，只触发一次样式计算
      this.markDarkContexts(newMarks);
    });
    if (newMarks.length > 0) {
      let changed = false;
      for (const m of newMarks) {
        const lemma = m.getAttribute(ATTR_LEMMA)!;
        if (!this.lemmas.has(lemma)) {
          this.lemmas.add(lemma);
          changed = true;
        }
      }
      if (changed) this.scheduleReport();
      void this.fillTranslations(newMarks);
    }
    if (this.hasPending()) {
      this.scheduled = true;
      scheduleIdle((budget) => this.drain(budget));
    }
  }

  /** 执行 DOM 改动期间丢弃自身产生的 mutation，保留之前页面产生的 mutation */
  private withoutObserving(fn: () => void): void {
    const pending = this.observer?.takeRecords() ?? [];
    fn();
    this.observer?.takeRecords();
    if (pending.length > 0) this.onMutations(pending);
  }

  // ---------------- 深色上下文 ----------------

  /**
   * 判断 mark 所在上下文是否深色背景并打标记（样式据此提亮文字色）。
   * 依据父元素的计算文字颜色：浅色文字 ≈ 深色背景，比逐级查找背景色（透明、背景图）更可靠也更便宜。
   * 链接常用中等亮度的强调色，改用链接外层元素的文字颜色判断。
   */
  private markDarkContexts(marks: HTMLElement[]): void {
    if (marks.length === 0) return;
    const flags = marks.map((m) => this.isDarkContext(m.parentElement));
    marks.forEach((m, i) => m.toggleAttribute(ATTR_ON_DARK, flags[i]!));
  }

  private isDarkContext(el: Element | null): boolean {
    if (!el) return false;
    const ref = el.closest('a')?.parentElement ?? el;
    let dark = this.darkCache.get(ref);
    if (dark === undefined) {
      const view = ref.ownerDocument.defaultView;
      dark = !!view && isLightText(view.getComputedStyle(ref).color);
      this.darkCache.set(ref, dark);
    }
    return dark;
  }

  /** 监听页面明暗主题切换：系统配色变化、html/body 的 class/style/data-* 属性变化 */
  private watchPageTheme(): void {
    const doc = this.opts.root.ownerDocument;
    const recheck = () => {
      clearTimeout(this.themeTimer);
      this.themeTimer = setTimeout(() => {
        this.darkCache = new WeakMap();
        this.withoutObserving(() => this.markDarkContexts([...this.opts.root.querySelectorAll<HTMLElement>(TAG_MARK)]));
      }, THEME_RECHECK_MS);
    };
    this.themeObserver = new MutationObserver(recheck);
    for (const el of [doc.documentElement, doc.body]) {
      if (el) this.themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode'] });
    }
    this.colorSchemeQuery = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    this.colorSchemeQuery?.addEventListener?.('change', recheck);
    this.themeRecheck = recheck;
  }

  private unwatchPageTheme(): void {
    clearTimeout(this.themeTimer);
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    if (this.themeRecheck) this.colorSchemeQuery?.removeEventListener?.('change', this.themeRecheck);
    this.colorSchemeQuery = undefined;
    this.themeRecheck = undefined;
  }

  // ---------------- 行内翻译 ----------------

  /** 填充行内翻译：已缓存的词条同步写入（重做切分组时不闪烁），缺失的批量查询后再写 */
  private async fillTranslations(marks: HTMLElement[]): Promise<void> {
    if (this.opts.inlineTranslation === 'off' || marks.length === 0) return;
    const missing = new Set<string>();
    for (const m of marks) {
      const lemma = m.getAttribute(ATTR_LEMMA)!;
      if (!this.translations.has(lemma)) missing.add(lemma);
    }
    if (missing.size > 0) {
      const found = await this.opts.dictionary.lookupMany(missing);
      for (const lemma of missing) this.translations.set(lemma, found.get(lemma)?.short ?? null);
    }
    this.withoutObserving(() => {
      for (const m of marks) {
        if (!m.isConnected) continue;
        const tr = this.translations.get(m.getAttribute(ATTR_LEMMA)!);
        setMarkTranslation(m, tr ? shortenTranslation(tr) : undefined);
      }
    });
  }

  // ---------------- 词条统计上报 ----------------

  /** 页面删除了内容：稍后按 DOM 实际情况重新统计词条（徽章计数） */
  private scheduleRecount(): void {
    if (!this.opts.onLemmasChanged) return;
    clearTimeout(this.recountTimer);
    this.recountTimer = setTimeout(() => this.recountLemmas(), REPORT_DELAY_MS);
  }

  private recountLemmas(): void {
    const next = new Set<string>();
    this.opts.root.querySelectorAll(TAG_MARK).forEach((m) => next.add(m.getAttribute(ATTR_LEMMA)!));
    const changed = next.size !== this.lemmas.size || [...next].some((l) => !this.lemmas.has(l));
    if (!changed) return;
    this.lemmas.clear();
    next.forEach((l) => this.lemmas.add(l));
    this.scheduleReport();
  }

  private scheduleReport(): void {
    if (!this.opts.onLemmasChanged) return;
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => this.opts.onLemmasChanged?.(this.matchedLemmas), REPORT_DELAY_MS);
  }
}

/**
 * 行内释义只取一个短义项：去掉词性前缀与 [医]/(…) 等标注，取第一个义项，限制长度，避免撑乱排版。
 * 例：`"a. [医]结晶的, 使晶状的"` -> `结晶的`；`"n. 出租车, 出租汽车"` -> `出租车`
 */
export function shortenTranslation(s: string, max = 6): string {
  const first = s
    .split('\n')[0]!
    .replace(/^\s*(?:[a-z]+\.\s*)+/i, '')
    .replace(/\[[^\]]*\]|［[^］]*］|\([^)]*\)|（[^）]*）|<[^>]*>/g, '')
    .split(/[;；,，、]/)
    .map((x) => x.trim())
    .find((x) => x.length > 0);
  if (!first) return '';
  return first.length > max ? first.slice(0, max) + '…' : first;
}

/** 空闲时执行，回调参数为本次可用的时间预算（ms） */
function scheduleIdle(fn: (budgetMs: number) => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback((d) => fn(d.didTimeout ? SLICE_MIN_MS * 2 : d.timeRemaining()), { timeout: 200 });
  } else {
    setTimeout(() => fn(SLICE_MIN_MS * 2), 0);
  }
}
