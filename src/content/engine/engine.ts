import type { Dictionary } from '@/core/dict/types';
import type { MatchResult, WordMatcher } from '@/core/match/matcher';
import type { CodeBlockSettings, InlineTranslationMode } from '@/core/settings/schema';
import { isLightText } from './color';
import {
  ATTR_CODE,
  ATTR_IN_LINK,
  ATTR_LEMMA,
  ATTR_LOW_CONFIDENCE,
  ATTR_ON_DARK,
  ATTR_REVEALED,
  ATTR_TIGHT,
  CODE_COMMENT_STRING_SELECTOR,
  TAG_MARK,
  TAG_TRANSLATION,
  isInsideOwnNode,
  type ScanOptions,
} from './dom';
import {
  dropGroup,
  hasFragments,
  highlightTextNode,
  markSurface,
  ownerTextOf,
  reserveTranslationSlot,
  restoreGroup,
  setMarkTranslation,
  unwrapAll,
  type HighlightOptions,
} from './highlighter';
import { codeRootOf, createTextWalker, isRootSkipped, isTextCandidate } from './scanner';

export interface EngineOptions {
  root: HTMLElement;
  matcher: WordMatcher;
  dictionary: Dictionary;
  inlineTranslation: InlineTranslationMode;
  /** 模糊自测（v5）：译文模糊，点按译文切换清晰；engine 拦截点按，不触发卡片与链接 */
  translationBlur?: boolean;
  /** 代码块中标注生词（v8）；变化时由调用方 rebuild */
  code?: CodeBlockSettings;
  /** 已高亮的不同词条集合变化（节流后）回调，用于徽章计数上报 */
  onLemmasChanged?: (lemmas: string[]) => void;
}

/** 每个处理切片的时间预算上下限（ms）：空闲回调给多少用多少，但不超过上限，避免长任务卡顿 */
const SLICE_MIN_MS = 4;
const SLICE_MAX_MS = 12;
/**
 * 启动时的首个切片：不等空闲回调（页面加载期间空闲回调可能推迟到 200ms 超时），立即处理文档前部，
 * 让首屏标注尽量赶在首次绘制/用户阅读之前；预算仍远低于 50ms 长任务线。
 */
const FIRST_SLICE_MS = 24;
const REPORT_DELAY_MS = 400;
/** 页面明暗主题切换（html/body 的 class/style 等属性变化）后，重新判断深色上下文的防抖时间 */
const THEME_RECHECK_MS = 300;
/** 队列已消费部分超过该长度时压缩数组，避免 shift() 的 O(n) 开销 */
const QUEUE_COMPACT_AT = 1024;
/**
 * 行内译文懒插入的视口外扩范围：单词进入“视口上下各一屏”时才插入译文。
 * 插入发生在屏外，被推移的内容用户看不到（不计入 CLS）；视口上方的插入由浏览器滚动锚定抵消。
 */
const TRANSLATION_ROOT_MARGIN = '100% 0px 100% 0px';
/** 受限容器判断最多向上看几层（行内祖先 + 第一个块级容器 + 其父级） */
const TIGHT_MAX_DEPTH = 6;
/** 视为“按钮类控件”的标签与 role：标签文字一般不换行、宽度由内容决定，插入占位译文会撑宽控件 */
const CONTROL_TAGS = new Set(['BUTTON', 'SUMMARY']);
const CONTROL_ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'switch']);

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
  /** 元素 -> 是否受限容器 的缓存（页面主题切换时一并清空） */
  private tightCache = new WeakMap<Element, boolean>();
  /** 行内译文懒插入：等待接近视口的 mark（无 IntersectionObserver 的环境直接插入） */
  private translationObserver?: IntersectionObserver;
  /** 模糊自测的点按拦截（window 捕获阶段，早于卡片在 document 上的监听） */
  private quizListener?: (e: Event) => void;
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
    this.bindQuiz();
    const view = this.opts.root.ownerDocument.defaultView;
    if (view && typeof view.IntersectionObserver === 'function') {
      this.translationObserver = new view.IntersectionObserver((entries) => this.onTranslationVisible(entries), {
        rootMargin: TRANSLATION_ROOT_MARGIN,
      });
    }
    this.enqueue(this.opts.root);
    this.drain(FIRST_SLICE_MS, true);
  }

  /** 停止并移除全部高亮（DOM 还原为高亮前的文本节点） */
  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = undefined;
    this.unwatchPageTheme();
    this.unbindQuiz();
    this.translationObserver?.disconnect();
    this.translationObserver = undefined;
    this.visibleQueue = [];
    if (this.visibleFrame) this.opts.root.ownerDocument.defaultView?.cancelAnimationFrame(this.visibleFrame);
    this.visibleFrame = 0;
    this.queue = [];
    this.queueHead = 0;
    this.walker = null;
    this.processed = new WeakSet();
    this.darkCache = new WeakMap();
    this.tightCache = new WeakMap();
    this.suppressed.clear();
    unwrapAll(this.opts.root);
    if (this.lemmas.size > 0) {
      this.lemmas.clear();
      this.scheduleReport();
    }
  }

  /** 代码块设置变化（需随后 rebuild 才生效） */
  setCode(code: CodeBlockSettings | undefined): void {
    this.opts = { ...this.opts, code };
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

  /** 行内翻译模式变化：off 时不再查询词典；切换为开启时为已有 mark 补齐翻译；blur 为模糊自测开关 */
  setInlineTranslation(mode: InlineTranslationMode, blur = this.opts.translationBlur): void {
    const prev = this.opts.inlineTranslation;
    this.opts.inlineTranslation = mode;
    this.opts.translationBlur = blur;
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

  /** 扫描选项：代码块开关（v8） */
  private get scanOpts(): ScanOptions {
    const c = this.opts.code;
    return c?.enabled ? { codeEnabled: true, codeScope: c.scope } : {};
  }

  /** 高亮一个文本节点：代码中的文本按标识符拆分（注释/字符串不跳过编程熟词） */
  private highlight(t: Text): HTMLElement[] {
    let hopts: HighlightOptions | undefined;
    if (this.opts.code?.enabled && codeRootOf(t)) {
      hopts = { code: t.parentElement?.closest(CODE_COMMENT_STRING_SELECTOR) ? 'prose' : 'identifier' };
    }
    return highlightTextNode(t, this.matchWord, (left) => this.processed.add(left), hopts);
  }

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
        newMarks.push(...this.highlight(o));
      }
      this.markContexts(newMarks);
    });
    // 重做的切分组立即写入译文（取缓存），不走懒插入，避免同一段落的其他生词译文闪烁
    void this.fillTranslations(newMarks, true);
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
        if (!this.processed.has(t) && isTextCandidate(t, this.scanOpts)) return t;
        continue;
      }
      if (root.nodeType === Node.ELEMENT_NODE && isRootSkipped(root as Element, this.scanOpts)) continue;
      this.walker = createTextWalker(root, (t) => this.processed.has(t), this.scanOpts);
    }
  }

  private hasPending(): boolean {
    return this.walker !== null || this.queueHead < this.queue.length;
  }

  /** 按时间预算处理队列 */
  private drain(budgetMs: number, first = false): void {
    // 首个切片由 start() 直接调用，此时已登记的空闲回调仍会到来（届时继续处理剩余部分），不能清掉 scheduled
    if (!first) this.scheduled = false;
    if (this.stopped) return;
    const deadline = performance.now() + (first ? budgetMs : Math.min(Math.max(budgetMs, SLICE_MIN_MS), SLICE_MAX_MS));
    const newMarks: HTMLElement[] = [];
    this.withoutObserving(() => {
      let t: Text | null;
      while (performance.now() < deadline && (t = this.nextTextNode())) {
        if (!t.isConnected) continue;
        newMarks.push(...this.highlight(t));
        // 原节点处理后只剩首个命中词之前的文字，记为已处理；内容被改写时会从集合移除
        this.processed.add(t);
      }
      // 一片中的写操作全部完成后再统一读取计算样式，只触发一次样式计算
      this.markContexts(newMarks);
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
    if (this.hasPending() && !this.scheduled) {
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
   * 给 mark 打上下文标记（先统一读、再统一写）：
   * - 深色上下文：依据父元素的计算文字颜色，浅色文字 ≈ 深色背景，比逐级查找背景色（透明、背景图）更可靠也更便宜；
   *   链接常用中等亮度的强调色，改用链接外层元素的文字颜色判断
   * - 链接内：只看 DOM，不读样式
   * - 受限容器：见 isTightContext（代码中的 mark 本来就不占位，不必判断）
   * ruby 模式下，正文 mark 在同一帧插入占位注解，预留行高（见 style.ts）。
   */
  private markContexts(marks: HTMLElement[]): void {
    if (marks.length === 0) return;
    const flags = marks.map((m) => {
      const parent = m.parentElement;
      const code = m.hasAttribute(ATTR_CODE);
      return { dark: this.isDarkContext(parent), link: !!parent?.closest('a'), tight: !code && this.isTightContext(parent) };
    });
    const ruby = this.opts.inlineTranslation === 'ruby';
    marks.forEach((m, i) => {
      const f = flags[i]!;
      m.toggleAttribute(ATTR_ON_DARK, f.dark);
      m.toggleAttribute(ATTR_IN_LINK, f.link);
      m.toggleAttribute(ATTR_TIGHT, f.tight);
      if (ruby && !f.tight && !m.hasAttribute(ATTR_CODE) && !m.hasAttribute(ATTR_LOW_CONFIDENCE)) {
        reserveTranslationSlot(m);
      }
    });
  }

  /**
   * 受限容器（预研要求）：占位译文会撑破或改变布局的位置，译文退化为悬停浮层。
   * 从父元素向上检查：按钮类控件；不换行（white-space nowrap/pre、text-wrap-mode nowrap）；text-overflow:ellipsis；
   * line-clamp；块级盒 overflow hidden/clip 且高度只有一行（固定高度的单行容器）。
   * 只看行内祖先、第一个非行内容器及其父级（flex 项目常把约束放在父级）。结果按元素缓存。
   */
  private isTightContext(el: Element | null): boolean {
    if (!el) return false;
    const cached = this.tightCache.get(el);
    if (cached !== undefined) return cached;
    const view = el.ownerDocument.defaultView;
    let tight = false;
    let blocksSeen = 0;
    for (let cur: Element | null = el, depth = 0; cur && view && depth < TIGHT_MAX_DEPTH && blocksSeen < 2; cur = cur.parentElement, depth++) {
      if (CONTROL_TAGS.has(cur.tagName.toUpperCase()) || CONTROL_ROLES.has(cur.getAttribute('role') ?? '')) {
        tight = true;
        break;
      }
      const cs = view.getComputedStyle(cur);
      const ws = cs.whiteSpace;
      if (ws === 'nowrap' || ws === 'pre' || cs.getPropertyValue('text-wrap-mode') === 'nowrap' || cs.textOverflow === 'ellipsis') {
        tight = true;
        break;
      }
      const clamp = cs.getPropertyValue('-webkit-line-clamp');
      if (clamp && clamp !== 'none') {
        tight = true;
        break;
      }
      if (cs.display === 'inline' || cs.display === 'contents') continue;
      blocksSeen++;
      const clips = (v: string) => v === 'hidden' || v === 'clip';
      if (clips(cs.overflowY) || clips(cs.overflowX)) {
        const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        if (lineHeight > 0 && (cur as HTMLElement).clientHeight > 0 && (cur as HTMLElement).clientHeight < lineHeight * 1.8) {
          tight = true;
          break;
        }
      }
    }
    this.tightCache.set(el, tight);
    return tight;
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
        this.tightCache = new WeakMap();
        this.withoutObserving(() => this.markContexts([...this.opts.root.querySelectorAll<HTMLElement>(TAG_MARK)]));
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

  /** mark 是否需要译文：正文看行内译文模式；代码只有“浮动小标注”时需要 */
  private needsTranslation(m: Element): boolean {
    if (m.hasAttribute(ATTR_CODE)) return !!this.opts.code?.enabled && this.opts.code.display === 'float';
    return this.opts.inlineTranslation !== 'off';
  }

  /**
   * 填充行内翻译：缺失的词条先批量查询；写入分两种：
   * - 已在 DOM 中带占位/译文的 mark（重做切分组、ruby 占位）与无 IntersectionObserver 的环境：立即写入（不闪烁）
   * - 其余交给 IntersectionObserver，接近视口（上下各一屏）时再写入，屏外内容的推移不计入 CLS，也省掉远处的布局开销
   */
  private async fillTranslations(marks: HTMLElement[], immediate = false): Promise<void> {
    const targets = marks.filter((m) => this.needsTranslation(m));
    if (targets.length === 0) return;
    const missing = new Set<string>();
    for (const m of targets) {
      for (const key of translationKeys(m)) if (!this.translations.has(key)) missing.add(key);
    }
    if (missing.size > 0) {
      const found = await this.opts.dictionary.lookupMany(missing);
      for (const lemma of missing) this.translations.set(lemma, found.get(lemma)?.short ?? null);
    }
    const io = immediate ? undefined : this.translationObserver;
    const now: HTMLElement[] = [];
    for (const m of targets) {
      if (!m.isConnected) continue;
      if (io && !this.translationOf(m)) now.push(m); // 无释义：立即移除占位
      else if (io && !m.querySelector(TAG_TRANSLATION)) io.observe(m);
      else now.push(m);
    }
    this.applyTranslations(now);
  }

  /** mark 的短释义：优先页面词形自己的词条，没有再用原形（见 translationKeys） */
  private translationOf(m: Element): string | null {
    for (const key of translationKeys(m)) {
      const tr = this.translations.get(key);
      if (tr) return tr;
    }
    return null;
  }

  private applyTranslations(marks: Iterable<Element>): void {
    this.withoutObserving(() => {
      for (const m of marks) {
        if (!m.isConnected) continue;
        const tr = this.translationOf(m);
        setMarkTranslation(m, tr ? shortenTranslation(tr) : undefined);
      }
    });
  }

  /**
   * 懒插入：接近视口的 mark 写入译文。
   * - 视口外（上下扩展区）的一次性写入：被推移的内容不可见，不计入 CLS
   * - 视口内的按段落分帧写入（文档顺序，一帧一段）：CLS 每帧按“受影响面积 × 最大位移”计分，
   *   一次全写时最下方内容的累计位移最大、受影响面积也最大；逐段写入时每帧只推移一段的增量，总分约为一次写入的一半
   */
  private onTranslationVisible(entries: IntersectionObserverEntry[]): void {
    const offscreen: Element[] = [];
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.translationObserver?.unobserve(e.target);
      if (!this.needsTranslation(e.target)) continue;
      const r = e.boundingClientRect;
      const inViewport = r.bottom > 0 && r.top < (e.target.ownerDocument.defaultView?.innerHeight ?? 0);
      if (inViewport) this.visibleQueue.push(e.target);
      else offscreen.push(e.target);
    }
    if (offscreen.length > 0) this.applyTranslations(offscreen);
    if (this.visibleQueue.length > 0 && !this.visibleFrame) this.flushVisibleByBlock();
  }

  /** 视口内待写入译文的 mark（按段落分帧写入） */
  private visibleQueue: Element[] = [];
  private visibleFrame = 0;

  private flushVisibleByBlock(): void {
    const view = this.opts.root.ownerDocument.defaultView;
    const queue = this.visibleQueue;
    if (queue.length === 0 || !view) {
      this.visibleFrame = 0;
      return;
    }
    const block = blockOf(queue[0]!);
    const now = queue.filter((m) => blockOf(m) === block);
    this.visibleQueue = queue.filter((m) => blockOf(m) !== block);
    this.applyTranslations(now);
    this.visibleFrame = view.requestAnimationFrame(() => this.flushVisibleByBlock());
  }

  // ---------------- 模糊自测 ----------------

  /**
   * 模糊自测（v5）：点按模糊的译文切换清晰/模糊。在 window 捕获阶段拦截（早于卡片在 document 上的监听），
   * 阻止链接跳转与卡片打开；悬停在译文上也不触发卡片的悬停打开（否则卡片会直接给出答案）。
   */
  private bindQuiz(): void {
    const view = this.opts.root.ownerDocument.defaultView;
    if (!view) return;
    this.quizListener = (e: Event) => {
      if (!this.opts.translationBlur || this.opts.inlineTranslation === 'off' || this.opts.inlineTranslation === 'hover') return;
      const target = e.target;
      if (!(target instanceof Element) || target.tagName.toLowerCase() !== TAG_TRANSLATION) return;
      const mark = target.parentElement;
      if (!mark || mark.hasAttribute(ATTR_TIGHT) || mark.hasAttribute(ATTR_CODE)) return;
      e.stopPropagation();
      if (e.type === 'click') {
        e.preventDefault();
        this.withoutObserving(() => target.toggleAttribute(ATTR_REVEALED));
      }
    };
    for (const type of ['click', 'pointerdown', 'pointerover', 'mouseover']) view.addEventListener(type, this.quizListener, true);
  }

  private unbindQuiz(): void {
    const view = this.opts.root.ownerDocument.defaultView;
    if (!view || !this.quizListener) return;
    for (const type of ['click', 'pointerdown', 'pointerover', 'mouseover']) view.removeEventListener(type, this.quizListener, true);
    this.quizListener = undefined;
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

/** mark 所在的段落级容器（分帧写入译文的单位） */
function blockOf(m: Element): Element | null {
  return m.parentElement?.closest('p,li,dd,dt,td,th,h1,h2,h3,h4,h5,h6,blockquote,figcaption,div,section,article') ?? null;
}

/**
 * 查释义用的词：先页面词形（小写），再原形。
 * 派生词在词典里通常有自己的词条（committee=委员会、carelessly=粗心地），用原形（commit=犯罪、careless）会译错；
 * 屈折变化（proposals、citing）词典没有单独词条，自然回退到原形。
 */
function translationKeys(m: Element): string[] {
  const lemma = m.getAttribute(ATTR_LEMMA)!;
  const surface = markSurface(m).toLowerCase().replace(/['’]s$/, '');
  return surface && surface !== lemma ? [surface, lemma] : [lemma];
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
