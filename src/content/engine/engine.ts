import { isRubyMode } from '@/core/settings/inline-translation-labels';
import { collocationShort } from '@/core/dict/collocation';
import type { Dictionary } from '@/core/dict/types';
import type { MatchResult, WordMatcher } from '@/core/match/matcher';
import type { CodeBlockSettings, InlineTranslationMode } from '@/core/settings/schema';
import { isLightText } from './color';
import {
  ATTR_CODE,
  ATTR_CODE_FLOAT,
  ATTR_IN_LINK,
  ATTR_LEMMA,
  ATTR_NO_GLOSS,
  ATTR_ON_DARK,
  ATTR_REVEALED,
  ATTR_TIGHT,
  ATTR_TR_TEXT,
  CODE_COMMENT_STRING_SELECTOR,
  TAG_MARK,
  TAG_TRANSLATION,
  isInsideOwnNode,
  type ScanOptions,
} from './dom';
import {
  dropGroup,
  hasFragments,
  findHits,
  wrapHits,
  markSurface,
  ownerTextOf,
  reserveTranslationSlot,
  restoreGroup,
  setMarkTranslation,
  unwrapAll,
  type HighlightOptions,
  type TextHit,
} from './highlighter';
import { codeRootOf, createTextWalker, isRootSkipped, isTextCandidate } from './scanner';

export interface EngineOptions {
  root: HTMLElement;
  matcher: WordMatcher;
  dictionary: Dictionary;
  inlineTranslation: InlineTranslationMode;
  /** 模糊自测（v5）：译文模糊，点按译文切换清晰；engine 拦截点按，不触发卡片与链接 */
  translationBlur?: boolean;
  /** 同一段落里同一词条只在第一次出现时显示行内译文（默认开），见 thinGlosses */
  glossOncePerParagraph?: boolean;
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
/**
 * 首屏就绪（primeFirstScreen）额外的同步处理预算：比常规切片长，争取一次处理完视口内的全部文本
 *（维基桌面首屏约需 10–20ms，首个切片已处理大部分）；开启预隐藏时（见 prehide.ts）页面此时不可见，显示前即已完成。
 */
const PRIME_SLICE_MS = 16;
/**
 * 切片中“读阶段”（遍历、匹配、读计算样式）占预算的比例，剩余留给写阶段（包裹 mark、打上下文标记）。
 * 写阶段一般远比匹配快，这样整片仍大致在预算内。
 */
const SLICE_READ_RATIO = 0.7;
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
/** 动词变形词尾（-s 与名词复数同形，不算） */
const VERB_INFLECTION = /(?:ing|ed)$/;

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
  /** 词条 -> 动词短释义（DictEntry.shortVerb：short 取的是名词/形容词义时才有，如 advocate 提倡者 / 提倡） */
  private readonly verbTranslations = new Map<string, string>();
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
  /** 页面仍在解析（engine 可在 DOMContentLoaded 之前启动，见 app.ts 的 firstScreenParsed） */
  private parsing = false;
  /** 解析期间暂缓的文档末尾文本节点，DOMContentLoaded 后重新入队 */
  private deferredUntilParsed: Text[] = [];
  private onParsed?: () => void;
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
    const doc = this.opts.root.ownerDocument;
    this.parsing = doc.readyState === 'loading';
    if (this.parsing) {
      this.onParsed = () => {
        this.parsing = false;
        const deferred = this.deferredUntilParsed;
        this.deferredUntilParsed = [];
        for (const t of deferred) this.enqueue(t);
      };
      doc.addEventListener('DOMContentLoaded', this.onParsed, { once: true });
    }
    this.enqueue(this.opts.root);
    this.drain(FIRST_SLICE_MS, true);
  }

  /**
   * 首屏就绪（预研要求：降低“词后”模式 CLS）：在页面预隐藏期间调用。
   * 继续同步处理队列（预算 PRIME_SLICE_MS），再批量查释义、立即写入视口内 mark 的译文（不走懒插入）。
   * 返回后调用方显示页面：首屏的括注/注解在首次可见时已在位，不会产生布局推移。
   * 视口外的 mark 照常懒插入（屏外推移不计入 CLS）。
   */
  async primeFirstScreen(): Promise<void> {
    if (this.stopped) return;
    if (this.hasPending()) this.drain(PRIME_SLICE_MS, true);
    const view = this.opts.root.ownerDocument.defaultView;
    if (!view) return;
    const vh = view.innerHeight;
    // 先统一读位置（一次布局），只取视口内需要译文的 mark
    const visible = [...this.opts.root.querySelectorAll<HTMLElement>(TAG_MARK)].filter((m) => {
      if (!this.needsTranslation(m)) return false;
      const r = m.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.width > 0;
    });
    if (visible.length > 0) await this.fillTranslations(visible, true);
  }

  /** 停止并移除全部高亮（DOM 还原为高亮前的文本节点） */
  stop(): void {
    this.stopped = true;
    if (this.onParsed) this.opts.root.ownerDocument.removeEventListener('DOMContentLoaded', this.onParsed);
    this.onParsed = undefined;
    this.parsing = false;
    this.deferredUntilParsed = [];
    this.observer?.disconnect();
    this.observer = undefined;
    this.unwatchPageTheme();
    this.unbindQuiz();
    this.translationObserver?.disconnect();
    this.translationObserver = undefined;
    this.visibleQueue = [];
    if (this.visibleFrame) this.opts.root.ownerDocument.defaultView?.cancelAnimationFrame(this.visibleFrame);
    this.visibleFrame = 0;
    if (this.codeFloatFrame) this.opts.root.ownerDocument.defaultView?.cancelAnimationFrame(this.codeFloatFrame);
    this.codeFloatFrame = 0;
    this.pendingCodeRoots.clear();
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
    this.verbTranslations.clear();
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

  /**
   * 行内翻译设置变化：off 时不再查询词典；切换为开启时为已有 mark 补齐翻译；blur 为模糊自测开关；
   * oncePerParagraph 为“同段重复只显示首次”开关，变化时按段落重算。
   */
  setInlineTranslation(mode: InlineTranslationMode, blur = this.opts.translationBlur, oncePerParagraph = this.opts.glossOncePerParagraph): void {
    const prev = this.opts.inlineTranslation;
    const prevOnce = this.opts.glossOncePerParagraph;
    this.opts.inlineTranslation = mode;
    this.opts.translationBlur = blur;
    this.opts.glossOncePerParagraph = oncePerParagraph;
    if (prev === 'off' && mode !== 'off') {
      void this.fillTranslations([...this.opts.root.querySelectorAll<HTMLElement>(TAG_MARK)]);
    } else if (prevOnce !== oncePerParagraph) {
      this.thinGlosses([...this.opts.root.querySelectorAll<HTMLElement>(TAG_MARK)]);
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

  /** 文本节点的高亮选项：代码中的文本按标识符拆分（注释/字符串不跳过编程熟词）；只看 DOM，不读样式 */
  private highlightOpts(t: Text): HighlightOptions | undefined {
    if (!this.opts.code?.enabled || !codeRootOf(t)) return undefined;
    return { code: t.parentElement?.closest(CODE_COMMENT_STRING_SELECTOR) ? 'prose' : 'identifier' };
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
      // 先读：原节点留在原位置，新 mark 的父元素就是原节点的父元素，写之前读好它的上下文（见 drain）
      const batch = [...owners].map((o) => {
        const hopts = this.highlightOpts(o);
        return { o, hopts, ctx: this.readMarkContext(o.parentElement, !!hopts?.code) };
      });
      const items = batch.map(({ o, hopts, ctx }) => {
        this.unobserveMarks(restoreGroup(o));
        const marks = wrapHits(o, findHits(o, this.matchWord, hopts), (left) => this.processed.add(left), hopts);
        newMarks.push(...marks);
        return { marks, ctx };
      });
      this.applyMarkContexts(items);
    });
    // 重做的切分组立即写入译文（取缓存），不走懒插入，避免同一段落的其他生词译文闪烁
    void this.fillTranslations(newMarks.filter((m) => m.isConnected), true);
    this.recountLemmas();
  }

  private onMutations(records: MutationRecord[]): void {
    // 重新插入文档的、尚未写入译文的 mark（见下方 addedNodes 分支）
    const reattached: HTMLElement[] = [];
    for (const r of records) {
      if (r.type === 'characterData') {
        const t = r.target as Text;
        if (hasFragments(t)) {
          // 页面（框架）改写了原文本节点：旧片段已过时，丢弃后按新内容重做
          this.withoutObserving(() => this.unobserveMarks(dropGroup(t)));
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
          this.withoutObserving(() => this.unobserveMarks(restoreGroup(n as Text)));
          this.processed.delete(n as Text);
        } else if (n.nodeType === Node.ELEMENT_NODE && !n.isConnected) {
          // 页面删除了含 mark 的子树：尚未进入视口的 mark 仍被懒插入观察者持有，停止观察以便回收。
          // 仍在文档中的（被移动到别处）保留观察，否则译文永远不会写入
          const el = n as Element;
          if (el.localName === TAG_MARK) this.unobserveMarks([el]);
          else this.unobserveMarks(el.querySelectorAll(TAG_MARK));
        }
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.TEXT_NODE) continue;
        if (n.nodeType === Node.ELEMENT_NODE && n.isConnected) {
          // 页面把摘下的子树重新挂回（虚拟列表、keep-alive、跨任务重挂载）：其中的 mark 在删除分支已停止观察，
          // 重扫文本不会再处理它们（已高亮），需重新交给懒插入，否则永远拿不到译文。已写入译文/占位的不受影响
          const el = n as HTMLElement;
          const marks = el.localName === TAG_MARK ? [el] : el.querySelectorAll<HTMLElement>(TAG_MARK);
          for (const m of marks) if (!m.querySelector(TAG_TRANSLATION)) reattached.push(m);
        }
        if (isInsideOwnNode(n) || ownerTextOf(n)) continue;
        this.enqueue(n);
      }
    }
    if (reattached.length > 0) void this.fillTranslations(reattached);
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
    const sliceMs = first ? budgetMs : Math.min(Math.max(budgetMs, SLICE_MIN_MS), SLICE_MAX_MS);
    const readDeadline = performance.now() + sliceMs * SLICE_READ_RATIO;
    let newMarks: HTMLElement[] = [];
    this.withoutObserving(() => {
      // 读阶段：遍历、匹配，再读命中文本所在元素的计算样式（深色/受限容器/flex），不改 DOM。
      // 必须先读后写：写入 mark 后再读 getComputedStyle/clientHeight 会同步触发整页样式重算与布局，
      // 大 DOM 页面（GitHub 约 7000 节点）单次就要 100ms 以上，且发生在一次调用内，按节点检查的时间预算挡不住。
      // 空闲回调通常紧跟在一帧渲染之后，此时样式是干净的，读取几乎不花时间（结果按元素缓存）
      const found: { t: Text; hits: TextHit[]; hopts?: HighlightOptions }[] = [];
      let t: Text | null;
      while (performance.now() < readDeadline && (t = this.nextTextNode())) {
        if (!t.isConnected) continue;
        // 页面仍在解析：文档末尾的文本节点可能还会被解析器追加文字（网络分块），解析完再处理
        if (this.parsing && isAtDocumentEnd(t, this.opts.root)) {
          this.deferredUntilParsed.push(t);
          continue;
        }
        const hopts = this.highlightOpts(t);
        const hits = findHits(t, this.matchWord, hopts);
        if (hits.length > 0) found.push({ t, hits, hopts });
        // 原节点处理后只剩首个命中词之前的文字，记为已处理；内容被改写时会从集合移除
        this.processed.add(t);
      }
      const batch = found.map((f) => ({ ...f, ctx: this.readMarkContext(f.t.parentElement, !!f.hopts?.code) }));
      // 写阶段：包裹 mark 并按读阶段的结果打标记，之后不再读样式/布局
      const items = batch.map(({ t, hits, hopts, ctx }) => {
        const marks = wrapHits(t, hits, (left) => this.processed.add(left), hopts);
        newMarks.push(...marks);
        return { marks, ctx };
      });
      this.applyMarkContexts(items);
    });
    // applyMarkContexts 可能撤销了 flex/grid 直接子文本中的高亮（见 applyMarkContexts）
    newMarks = newMarks.filter((m) => m.isConnected);
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
  /** 停止观察已移出文档的 mark（行内译文懒插入），避免 IntersectionObserver 长期持有被页面删除的节点 */
  private unobserveMarks(marks: Iterable<Element>): void {
    const io = this.translationObserver;
    if (!io) return;
    for (const m of marks) io.unobserve(m);
  }

  private withoutObserving(fn: () => void): void {
    const pending = this.observer?.takeRecords() ?? [];
    fn();
    this.observer?.takeRecords();
    if (pending.length > 0) this.onMutations(pending);
  }

  // ---------------- 深色上下文 ----------------

  /**
   * 给已在文档中的 mark 打上下文标记（先统一读、再统一写），用于页面主题切换后的重判。
   * 新建 mark 不走这里：drain/redoGroups 在写入 mark 之前就读好上下文，见 readMarkContext。
   */
  private markContexts(marks: HTMLElement[]): void {
    if (marks.length === 0) return;
    const items = marks.map((m) => ({ marks: [m], ctx: this.readMarkContext(m.parentElement, m.hasAttribute(ATTR_CODE)) }));
    this.applyMarkContexts(items);
  }

  /**
   * 读 mark 所在元素（mark 的父元素，也就是被高亮文本节点的父元素）的上下文，只读不写：
   * - 深色上下文：依据父元素的计算文字颜色，浅色文字 ≈ 深色背景，比逐级查找背景色（透明、背景图）更可靠也更便宜；
   *   链接常用中等亮度的强调色，改用链接外层元素的文字颜色判断
   * - 链接内：只看 DOM，不读样式
   * - 受限容器：见 isTightContext（代码中的 mark 本来就不占位，不必判断）
   * - flex/grid 容器：见 applyMarkContexts 的空格折叠处理
   */
  private readMarkContext(parent: Element | null, code: boolean): MarkContext {
    return {
      dark: this.isDarkContext(parent),
      link: !!parent?.closest('a'),
      tight: !code && this.isTightContext(parent),
      flex: !code && this.isFlexContainer(parent),
    };
  }

  /**
   * 按读好的上下文给 mark 写标记（只写，不读样式/布局）。
   * ruby 模式下，正文 mark 在同一帧插入占位注解，预留行高（见 style.ts）。
   */
  private applyMarkContexts(items: { marks: HTMLElement[]; ctx: MarkContext }[]): void {
    const ruby = isRubyMode(this.opts.inlineTranslation);
    const undo = new Set<Text>();
    for (const { marks, ctx } of items) {
      for (const m of marks) {
        if (ctx.flex && isFlexItemBoundary(m)) {
          const owner = ownerTextOf(m);
          if (owner) undo.add(owner);
          continue;
        }
        m.toggleAttribute(ATTR_ON_DARK, ctx.dark);
        m.toggleAttribute(ATTR_IN_LINK, ctx.link);
        m.toggleAttribute(ATTR_TIGHT, ctx.tight);
        // 受限容器中的 ruby 译文改为附在词后（不撑高单行，见 style.ts），代码中不显示占位译文，二者都不预留
        if (ruby && !ctx.tight && !m.hasAttribute(ATTR_CODE)) {
          reserveTranslationSlot(m);
        }
      }
    }
    // flex/grid 容器的直接子文本被切开后，每段文字成为独立的 flex 项目，切口处的空格被折叠
    // （“Print subscriptions” 显示成 “Printsubscriptions”）：撤销这段文字的高亮，保持原样
    for (const owner of undo) restoreGroup(owner);
  }

  /** 元素是否为 flex/grid 容器（只在读阶段调用，见 readMarkContext） */
  private isFlexContainer(parent: Element | null): boolean {
    if (!parent) return false;
    const view = parent.ownerDocument.defaultView;
    return /flex|grid/.test(view?.getComputedStyle(parent).display ?? '');
  }

  /**
   * 受限容器（预研要求）：占位译文会撑破或改变布局的位置，译文退化为悬停浮层。
   * 从父元素向上检查：按钮类控件（行内元素也算）；非行内容器的不换行（white-space nowrap/pre、text-wrap-mode nowrap）、
   * text-overflow:ellipsis、line-clamp，以及 overflow hidden/clip 且高度只有一行（固定高度的单行容器）。
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
      // 行内元素的 nowrap 只让这一小段不在内部折行，所在的块照常换行，加括注不会撑破布局
      // （维基导航框 hlist 每一项都是行内 nowrap）；ellipsis、line-clamp、overflow 对行内元素本就不生效
      if (cs.display === 'inline' || cs.display === 'contents') continue;
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
      for (const key of translationKeys(m, this.opts.matcher)) if (!this.translations.has(key)) missing.add(key);
    }
    if (missing.size > 0) {
      const found = await this.opts.dictionary.lookupMany(missing);
      for (const lemma of missing) {
        const e = found.get(lemma);
        this.translations.set(lemma, e?.short ?? null);
        if (e?.shortVerb) this.verbTranslations.set(lemma, e.shortVerb);
      }
    }
    const mode = this.opts.inlineTranslation;
    if (mode === 'after' || isRubyMode(mode)) this.thinGlosses(targets);
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

  /**
   * 同段重复词的行内译文（开关 glossOncePerParagraph，默认开）：同一段落里同一词条只在第一次出现时显示译文。
   * 按段落整体重算（无状态，重做切分组后结果一致）。被省略的 mark 加 data-hnw-nogloss（CSS 隐藏其译文），
   * 仍然高亮，悬停/卡片照常可看释义；开关关闭时清掉该标记，每次出现都显示。代码中的 mark 不参与计数。
   */
  private thinGlosses(marks: HTMLElement[]): void {
    const once = this.opts.glossOncePerParagraph !== false;
    const blocks = new Set<Element>();
    for (const m of marks) {
      const b = blockOf(m);
      if (b) blocks.add(b);
    }
    for (const block of blocks) {
      const all = [...block.querySelectorAll<HTMLElement>(TAG_MARK)].filter((m) => !m.hasAttribute(ATTR_CODE));
      const seen = new Set<string>();
      for (const m of all) {
        const lemma = m.getAttribute(ATTR_LEMMA)!;
        // 没有释义的不占“首次”名额，让后面有释义的同词条照常显示
        const first = !seen.has(lemma) && !!this.translationOf(m);
        if (first) seen.add(lemma);
        m.toggleAttribute(ATTR_NO_GLOSS, once && !first);
      }
    }
  }

  /**
   * mark 的短释义：相邻词构成固定搭配时用搭配义（core/dict/collocation）；否则依次取页面词形、屈折原形、匹配原形的词条（见 translationKeys）；
   * 页面词形是动词变形（-ing/-ed）而屈折原形的首选义项不是动词时，改用其动词释义（advocating → 提倡，而不是“提倡者”）。
   */
  private translationOf(m: Element): string | null {
    const keys = translationKeys(m, this.opts.matcher);
    const lemma = keys[keys.length - 1]!;
    // 固定搭配中的义项优先（vicious cycle → 恶性的，concrete structures → 混凝土）
    const colloc = collocationOf(m, lemma);
    if (colloc) return colloc;
    if (keys.length > 1) {
      const own = this.translations.get(keys[0]!);
      if (own) return own;
      // 动词释义取屈折原形的（没有屈折原形时 keys[1] 即匹配原形）；
      // 处在形容词位置（a compelling scenario、very promising）时不强行用动词义，按下面的词条顺序取（可能不准，卡片里有完整释义）
      if (VERB_INFLECTION.test(keys[0]!) && !isAdjectivePosition(m)) {
        const verb = this.verbTranslations.get(keys[1]!);
        if (verb) return verb;
      }
      // 屈折原形自己的词条（projections → projection 预测，而不是词根 project 的“项目”）
      if (keys.length > 2) {
        const inflected = this.translations.get(keys[1]!);
        if (inflected) return inflected;
      }
    }
    return this.translations.get(lemma) ?? null;
  }

  private applyTranslations(marks: Iterable<Element>): void {
    const floatCode = !!this.opts.code?.enabled && this.opts.code.display === 'float';
    this.withoutObserving(() => {
      for (const m of marks) {
        if (!m.isConnected) continue;
        const tr = this.translationOf(m);
        setMarkTranslation(m, tr ? shortenTranslation(tr) : undefined);
        if (floatCode && tr && m.hasAttribute(ATTR_CODE)) this.pendingCodeRoots.add(m.parentElement?.closest('pre,code') ?? m.parentElement!);
      }
    });
    if (this.pendingCodeRoots.size > 0 && !this.codeFloatFrame) {
      const view = this.opts.root.ownerDocument.defaultView;
      if (view) this.codeFloatFrame = view.requestAnimationFrame(() => this.layoutCodeFloats());
    }
  }

  /** 新写入浮动小标注、待重新摆放的代码块（下一帧统一读排版、再统一写） */
  private pendingCodeRoots = new Set<Element>();
  private codeFloatFrame = 0;

  /**
   * 代码“浮动小标注”的摆放：标注绝对定位在单词上方，不占位（复制、代码块尺寸不受影响），但
   * - 代码块（pre/编辑器）通常 overflow:auto，第一行的标注会被容器顶边裁掉 -> 改放单词下方；
   * - 同一行相邻的生词标注比单词宽，会互相压住 -> 后一个改放下方，上下都放不下时只在悬停时显示。
   * 每次重排整个代码块（懒插入会分批写入标注），先读全部排版再写属性，一帧只触发一次布局计算。
   */
  private layoutCodeFloats(): void {
    this.codeFloatFrame = 0;
    const roots = [...this.pendingCodeRoots];
    this.pendingCodeRoots.clear();
    const view = this.opts.root.ownerDocument.defaultView;
    if (this.stopped || !view) return;
    const plans: [HTMLElement[], CodeFloatPlacement[]][] = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      const marks = [...root.querySelectorAll<HTMLElement>(`${TAG_MARK}[${ATTR_CODE}]`)].filter((m) => m.querySelector(`${TAG_TRANSLATION}[${ATTR_TR_TEXT}]`));
      if (marks.length === 0) continue;
      // 上一轮判为 none 的标注是 display:none，量不到宽高：先恢复显示再量（同一帧内同步完成，不会闪烁）
      const hidden = marks.filter((m) => m.getAttribute(ATTR_CODE_FLOAT) === 'none');
      if (hidden.length > 0) this.withoutObserving(() => hidden.forEach((m) => m.removeAttribute(ATTR_CODE_FLOAT)));
      const clip = scrollClipOf(marks[0]!, view);
      const items = marks.map((m) => {
        const r = m.getBoundingClientRect();
        const t = m.querySelector(TAG_TRANSLATION)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, center: (r.left + r.right) / 2, width: t.width, height: t.height };
      });
      // 没有排版信息（不可见的代码块、测试环境）：保持默认
      if (items.every((i) => i.width === 0)) continue;
      plans.push([marks, planCodeFloats(items, clip)]);
    }
    this.withoutObserving(() => {
      for (const [marks, placements] of plans) {
        marks.forEach((m, i) => {
          const p = placements[i]!;
          if (p === 'above') m.removeAttribute(ATTR_CODE_FLOAT);
          else if (m.getAttribute(ATTR_CODE_FLOAT) !== p) m.setAttribute(ATTR_CODE_FLOAT, p);
        });
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
      if (!mark || mark.hasAttribute(ATTR_CODE)) return;
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


/** mark 所在元素的上下文（写入 mark 之前读好，见 HighlightEngine#readMarkContext） */
interface MarkContext {
  dark: boolean;
  link: boolean;
  tight: boolean;
  /** 父元素是 flex/grid 容器（代码中不判断） */
  flex: boolean;
}

/**
 * flex/grid 容器中的 mark 紧邻的文字片段在切口处有空白：空白会随 flex 项目边缘被折叠。
 * 只看兄弟文本节点内容，不读样式（父元素是否 flex/grid 已在读阶段判断）。
 */
function isFlexItemBoundary(m: Element): boolean {
  const prev = m.previousSibling;
  const next = m.nextSibling;
  return (prev?.nodeType === Node.TEXT_NODE && /\s$/.test((prev as Text).data)) || (next?.nodeType === Node.TEXT_NODE && /^\s/.test((next as Text).data));
}

/** 文本节点之后（root 范围内）是否再没有任何节点：解析中的文档里，只有这个位置的文本还可能被追加 */
function isAtDocumentEnd(t: Text, root: Node): boolean {
  for (let n: Node | null = t; n && n !== root; n = n.parentNode) if (n.nextSibling) return false;
  return true;
}

/** mark 所在的段落级容器（分帧写入译文的单位） */
function blockOf(m: Element): Element | null {
  return m.parentElement?.closest('p,li,dd,dt,td,th,h1,h2,h3,h4,h5,h6,blockquote,figcaption,div,section,article') ?? null;
}

/**
 * 固定搭配义：取 mark 左右紧邻的单词（同一父元素内、中间只有空白，不跨标点），
 * 邻词按小写和去掉复数词尾（-s/-es）两种形式查 collocationShort。
 */
function collocationOf(m: Element, lemma: string): string | undefined {
  const prev = adjacentWord(m, true);
  const next = adjacentWord(m, false);
  if (!prev && !next) return undefined;
  const forms = (w: string | undefined) => (w ? [...new Set([w, w.replace(/es$/, ''), w.replace(/s$/, '')])] : [undefined]);
  for (const p of forms(prev)) for (const n of forms(next)) {
    const hit = collocationShort(lemma, p, n);
    if (hit) return hit;
  }
  return undefined;
}

export type CodeFloatPlacement = 'above' | 'below' | 'none';

/** 代码中一个生词的排版（视口坐标）：单词的上下边、水平中心，标注的宽高 */
export interface CodeFloatItem {
  top: number;
  bottom: number;
  center: number;
  width: number;
  height: number;
}

/** 标注与单词的间距（与 style.ts 浮层 translate 的 3px 一致）、相邻标注的最小水平间隔 */
const CODE_FLOAT_GAP = 3;
const CODE_FLOAT_SPACING = 2;

/**
 * 代码浮动小标注的摆放（纯计算，便于单测）：按从上到下、从左到右依次放置，
 * 优先放单词上方；上方超出滚动容器的内容顶边（首行），或与已放置的标注重叠时放下方；上下都不行时为 none（只悬停显示）。
 * clip 为滚动容器内容区的上下边（与 items 同一坐标系）；没有裁切容器时不传。
 */
export function planCodeFloats(items: CodeFloatItem[], clip?: { top: number; bottom: number }): CodeFloatPlacement[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a]!.top - items[b]!.top || items[a]!.center - items[b]!.center);
  const placed: { top: number; bottom: number; left: number; right: number }[] = [];
  const out: CodeFloatPlacement[] = new Array(items.length).fill('none');
  for (const i of order) {
    const it = items[i]!;
    const left = it.center - it.width / 2;
    const right = it.center + it.width / 2;
    const above = { top: it.top - CODE_FLOAT_GAP - it.height, bottom: it.top - CODE_FLOAT_GAP, left, right };
    const below = { top: it.bottom + CODE_FLOAT_GAP, bottom: it.bottom + CODE_FLOAT_GAP + it.height, left, right };
    const free = (b: typeof above) =>
      (!clip || (b.top >= clip.top && b.bottom <= clip.bottom)) &&
      !placed.some((p) => b.left < p.right + CODE_FLOAT_SPACING && p.left < b.right + CODE_FLOAT_SPACING && b.top < p.bottom && p.top < b.bottom);
    const box = free(above) ? above : free(below) ? below : undefined;
    if (!box) continue;
    out[i] = box === above ? 'above' : 'below';
    placed.push(box);
  }
  return out;
}

/**
 * mark 所在的滚动/裁切容器的内容区上下边（视口坐标，按滚动位置换算到内容顶端，代码块滚动后结果不变）。
 * 向上找第一个 overflow 非 visible 的祖先（pre、编辑器的滚动层）；找不到时不裁切。
 */
function scrollClipOf(m: Element, view: Window): { top: number; bottom: number } | undefined {
  for (let el = m.parentElement, depth = 0; el && depth < 8; el = el.parentElement, depth++) {
    const cs = view.getComputedStyle(el);
    if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
    const top = el.getBoundingClientRect().top + el.clientTop - el.scrollTop;
    return { top, bottom: top + Math.max(el.scrollHeight, el.clientHeight) };
  }
  return undefined;
}

/** 限定词：其后的 -ing/-ed 词再接一个实词时是定语形容词（a compelling scenario） */
const ADJ_DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'its', 'his', 'her', 'their', 'our', 'your', 'my', 'some', 'any', 'no', 'every', 'each', 'such']);
/** 程度副词：其后的 -ing/-ed 词只能是形容词（very promising、most striking、less compelling） */
const DEGREE_ADVERBS = new Set(['very', 'more', 'most', 'less', 'least', 'so', 'too', 'quite', 'rather', 'really', 'highly', 'extremely', 'increasingly', 'particularly', 'truly', 'pretty']);
/** 介词/连词/系动词等虚词：限定词 + -ing + 虚词多为动名词（the killing of、the meeting and） */
const FUNCTION_WORDS = new Set(['of', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'that', 'which', 'who']);

/**
 * mark（-ing/-ed 词形）是否处在形容词位置：前一个词是程度副词；或前一个词是限定词、后一个词是实词（名词前的定语）。
 * 只看紧邻的单词，不做词性标注；判不准时返回 false，沿用原有的动词义回退。
 */
function isAdjectivePosition(m: Element): boolean {
  const prev = adjacentWord(m, true);
  if (!prev) return false;
  if (DEGREE_ADVERBS.has(prev)) return true;
  if (!ADJ_DETERMINERS.has(prev)) return false;
  const next = adjacentWord(m, false);
  return !!next && !FUNCTION_WORDS.has(next);
}

/** mark 前（prev=true）或后紧邻的单词（小写）；中间出现非空白字符（标点等）或跨出父元素时返回 undefined */
function adjacentWord(m: Element, prev: boolean): string | undefined {
  let text = '';
  for (let n = prev ? m.previousSibling : m.nextSibling, i = 0; n && i < 4; n = prev ? n.previousSibling : n.nextSibling, i++) {
    const t = n.nodeType === Node.TEXT_NODE ? (n as Text).data : n.nodeName === TAG_MARK.toUpperCase() ? markSurface(n as Element) : (n.textContent ?? '');
    text = prev ? t + text : text + t;
    if (/[A-Za-z]/.test(t)) break;
  }
  const hit = prev ? /([A-Za-z]+)\s+$/.exec(text) : /^\s+([A-Za-z]+)/.exec(text);
  return hit?.[1]!.toLowerCase();
}

/**
 * 查释义用的词：页面词形（小写）→ 屈折原形 → 匹配原形，去重。
 * 派生词在词典里通常有自己的词条（committee=委员会、carelessly=粗心地），用原形（commit=犯罪、careless）会译错；
 * 页面词形是派生词的屈折变化、借词根命中词书时（projections 命中 project、consequences 命中 consequent），
 * 屈折原形（projection=预测、consequence=后果）才是正确词条，排在匹配原形之前；
 * 普通屈折变化（proposals、citing）词典没有单独词条，屈折原形即匹配原形，自然回退到原形。
 */
function translationKeys(m: Element, matcher: WordMatcher): string[] {
  const lemma = m.getAttribute(ATTR_LEMMA)!;
  const surface = markSurface(m).toLowerCase().replace(/['’]s$/, '');
  if (!surface || surface === lemma) return [lemma];
  const inflection = matcher.inflectionOf(surface);
  return inflection && inflection !== surface && inflection !== lemma ? [surface, inflection, lemma] : [surface, lemma];
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
