import { h } from '../card/h';
import { ATTR_ACTIVE, ATTR_BOOKS, ATTR_LEMMA, TAG_CARD_HOST, TAG_MARK } from '../engine/dom';
import type { SiteContext } from '../sites/types';
import { wordAt } from './model';

/** 选区稳定判定（ms） */
const LONG_PRESS_SETTLE_MS = 280;
/** 选区须出现在最近一次触摸后这段时间内才算长按选词（ms） */
const LONG_PRESS_WINDOW_MS = 2500;
/** 恰好一个英文单词（含内部撇号/连字符） */
const SINGLE_WORD_RE = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;

/**
 * 取词模式：开启后点按页面上任意英文单词即查词弹卡片（手机上长按选词难、未高亮的词也想查）。
 *
 * - 监听 document 捕获阶段的 click：点在高亮词上交给通用卡片触发逻辑；点在普通文字上用 caretRangeFromPoint
 *   找到点按位置的文本与偏移，取出单词，在悬浮球的 Shadow DOM 中放一个与单词同位置的固定定位“取词框”作为卡片锚点
 *   （带 data-lemma/data-books，与 SiteContext.openCard 的锚点约定一致），不改页面 DOM
 * - 取词模式下点按一律阻止默认行为（不跳链接、不触发页面按钮），可编辑区除外（照常输入）
 * - 取词框随页面滚动跟随单词；卡片关闭（锚点的 data-hnw-active 被移除）后隐藏
 * - 退出：再次点悬浮球、顶部提示条的“退出”按钮、Esc
 */
export class PickMode {
  private on = false;
  private bar: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private range: Range | null = null;
  private boxObserver: MutationObserver | null = null;

  constructor(
    private readonly ctx: SiteContext,
    private readonly ui: HTMLElement,
    /** 本模块自己的宿主（点在宿主内的事件不处理） */
    private readonly ownHost: Element,
    private readonly onChange: (on: boolean) => void,
  ) {}

  get active(): boolean {
    return this.on;
  }

  enter(): void {
    if (this.on) return;
    this.on = true;
    const doc = this.ctx.doc;
    doc.addEventListener('click', this.onClick, true);
    doc.addEventListener('keydown', this.onKey, true);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.bar = h(
      doc,
      'div',
      { class: 'pickbar', role: 'status' },
      h(doc, 'span', {}, '取词模式 · 点按任意单词'),
      h(doc, 'button', { type: 'button', onclick: () => this.exit() }, '退出'),
    );
    this.ui.appendChild(this.bar);
    this.onChange(true);
  }

  exit(): void {
    if (!this.on) return;
    this.on = false;
    const doc = this.ctx.doc;
    doc.removeEventListener('click', this.onClick, true);
    doc.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.onScroll, true);
    this.bar?.remove();
    this.bar = null;
    // 取词框是卡片锚点：卡片仍打开时保留（关闭卡片时自动隐藏）
    if (!this.box?.hasAttribute(ATTR_ACTIVE)) this.clearBox();
    this.onChange(false);
  }

  destroy(): void {
    this.exit();
    this.disableLongPress();
    this.clearBox();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !this.ctx.getCard()?.isOpen) this.exit();
  };

  private readonly onScroll = () => {
    if (this.box && this.range) this.placeBox(this.range.getBoundingClientRect());
  };

  private readonly onClick = (e: MouseEvent) => {
    const path = e.composedPath();
    // 悬浮球自身、卡片内的点按不处理
    if (path.includes(this.ownHost) || path.some((n) => n instanceof Element && n.tagName === TAG_CARD_HOST.toUpperCase())) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && isEditable(target)) return;
    e.preventDefault();
    e.stopPropagation();
    const mark = target?.closest<HTMLElement>(TAG_MARK);
    if (mark) {
      // 高亮词：通用触发逻辑（同在 document 捕获阶段、先注册）已为触屏点按打开卡片；鼠标等其他情况这里补开
      if (this.ctx.getCard()?.anchor !== mark) this.ctx.openCard(mark);
      return;
    }
    void this.pickAt(e.clientX, e.clientY);
  };

  /** 点按位置取词并打开卡片；不在单词上时不做事（卡片已被通用逻辑关闭） */
  async pickAt(x: number, y: number): Promise<boolean> {
    const hit = caretAt(this.ctx.doc, x, y);
    if (!hit) return false;
    const found = wordAt(hit.node.data, hit.offset);
    if (!found) return false;
    const range = this.ctx.doc.createRange();
    range.setStart(hit.node, found.start);
    range.setEnd(hit.node, found.end);
    const hitRect = range.getBoundingClientRect();
    // caretRangeFromPoint 在空白处也会返回最近的字符：点按位置必须真的落在单词框内（留 6px 容差）
    const tol = 6;
    if (x < hitRect.left - tol || x > hitRect.right + tol || y < hitRect.top - tol || y > hitRect.bottom + tol) return false;
    await this.openForRange(range, found.word);
    return true;
  }

  /** 以页面上的一个单词范围为锚点打开卡片（取词框放在单词位置，不改页面 DOM） */
  private async openForRange(range: Range, word: string): Promise<void> {
    const rect = range.getBoundingClientRect();
    const { lemma, books } = await this.resolveLemma(word);
    this.range = range;
    const box = this.ensureBox();
    box.textContent = word;
    box.setAttribute(ATTR_LEMMA, lemma);
    box.setAttribute(ATTR_BOOKS, books.join(' '));
    box.hidden = false;
    this.placeBox(rect);
    this.ctx.openCard(box);
  }

  // ---------------- 长按选词查词（触屏，常开） ----------------

  private longPressOn = false;
  private lastTouchAt = 0;
  private selTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 长按选词直接查词：手机上长按单词，浏览器会选中这个词并弹出系统的复制/分享菜单；选区恰好是一个英文单词时直接打开卡片，
   * 不必先开取词模式（查一个非高亮词从“点球 → 取词模式 → 点词”三步变成一步）。
   * - 只认触屏手势产生的选区（最近一次触摸后 2.5 秒内），桌面拖选、程序设置的选区不处理
   * - 选中的是高亮词时用该 hnw-mark 作锚点（与点按高亮词相同）；可编辑区域内的选区不处理（用户在编辑文字）
   * - 选区继续拖大成短语时，关闭由长按打开的卡片，不妨碍复制
   * 不清除选区：系统菜单照常可用。
   */
  enableLongPress(): void {
    if (this.longPressOn) return;
    this.longPressOn = true;
    this.ctx.doc.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true });
    this.ctx.doc.addEventListener('selectionchange', this.onSelectionChange);
  }

  private disableLongPress(): void {
    if (!this.longPressOn) return;
    this.longPressOn = false;
    clearTimeout(this.selTimer);
    this.ctx.doc.removeEventListener('touchstart', this.onTouchStart, true);
    this.ctx.doc.removeEventListener('selectionchange', this.onSelectionChange);
  }

  private readonly onTouchStart = () => {
    this.lastTouchAt = performance.now();
  };

  private readonly onSelectionChange = () => {
    clearTimeout(this.selTimer);
    // 选区稳定后再判断（拖动选区手柄时 selectionchange 连续触发）
    this.selTimer = setTimeout(() => this.checkSelection(), LONG_PRESS_SETTLE_MS);
  };

  private checkSelection(): void {
    if (this.on || performance.now() - this.lastTouchAt > LONG_PRESS_WINDOW_MS) return;
    const sel = this.ctx.doc.getSelection();
    const card = this.ctx.getCard();
    const text = sel && !sel.isCollapsed && sel.rangeCount === 1 ? sel.toString().trim() : '';
    if (!SINGLE_WORD_RE.test(text)) {
      // 选区拖大成短语 / 取消选择：收起长按打开的卡片
      if (text && card?.isOpen && card.anchor === this.box) card.close();
      return;
    }
    const range = sel!.getRangeAt(0);
    const start = range.startContainer;
    const el = start instanceof Element ? start : start.parentElement;
    if (!el || isEditable(el)) return;
    const mark = el.closest<HTMLElement>(TAG_MARK);
    if (mark) {
      if (card?.anchor !== mark || !card.isOpen) this.ctx.openCard(mark);
      return;
    }
    if (card?.isOpen && card.anchor === this.box && this.box?.textContent === text) return;
    void this.openForRange(range.cloneRange(), text);
  }

  /** 选卡片词条：是生词时用匹配到的词条与词书；否则取第一个查得到释义的词形还原候选 */
  private async resolveLemma(word: string): Promise<{ lemma: string; books: string[] }> {
    const match = this.ctx.createMatcher().match(word);
    if (match) return { lemma: match.lemma, books: match.bookIds };
    const candidates = this.ctx.lemmaCandidates(word);
    const found = await this.ctx.lookupMany(candidates);
    return { lemma: candidates.find((c) => found.has(c)) ?? candidates[0] ?? word.toLowerCase(), books: [] };
  }

  private ensureBox(): HTMLElement {
    if (this.box) return this.box;
    const box = h(this.ctx.doc, 'span', { class: 'pickbox', 'aria-hidden': 'true' });
    this.ui.appendChild(box);
    // 卡片关闭时（移除激活标记）隐藏取词框
    this.boxObserver = new MutationObserver(() => {
      if (!box.hasAttribute(ATTR_ACTIVE)) {
        box.hidden = true;
        if (!this.on) this.clearBox();
      }
    });
    this.boxObserver.observe(box, { attributes: true, attributeFilter: [ATTR_ACTIVE] });
    this.box = box;
    return box;
  }

  private placeBox(r: DOMRect): void {
    const b = this.box!;
    const pad = 2;
    b.style.left = `${r.left - pad}px`;
    b.style.top = `${r.top - pad}px`;
    b.style.width = `${r.width + pad * 2}px`;
    b.style.height = `${r.height + pad * 2}px`;
  }

  private clearBox(): void {
    this.boxObserver?.disconnect();
    this.boxObserver = null;
    this.box?.remove();
    this.box = null;
    this.range = null;
  }
}

function isEditable(el: Element): boolean {
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || (el as HTMLElement).isContentEditable;
}

/** 点按位置对应的文本节点与偏移（Chromium caretRangeFromPoint / Firefox caretPositionFromPoint） */
export function caretAt(doc: Document, x: number, y: number): { node: Text; offset: number } | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y);
    node = p?.offsetNode ?? null;
    offset = p?.offset ?? 0;
  } else if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y);
    node = r?.startContainer ?? null;
    offset = r?.startOffset ?? 0;
  }
  return node && node.nodeType === Node.TEXT_NODE ? { node: node as Text, offset } : null;
}
