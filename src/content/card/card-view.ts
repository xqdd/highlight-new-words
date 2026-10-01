import type { DictEntry } from '@/core/dict/types';
import type { WordActionPreview } from '@/core/messaging/protocol';
import type { BookId } from '@/core/settings/schema';
import type { CardStyle } from '@/core/theme/themes';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';
import { ATTR_LEMMA, TAG_CARD_HOST, TAG_MARK, TAG_WORD } from '../engine/dom';
import { ACTIVE_MARK_CSS, CARD_CSS } from './card-css';
import { append, h, icon, type Child } from './h';
import type { CardActions, CardData, CardView } from './types';
import {
  addNotice,
  createCardBackend,
  describePreview,
  knownNotice,
  messageParts,
  removeNotice,
  undoKnownNotice,
  type AddTargetOption,
  type CardBackend,
  type HintSegment,
  type Notice,
} from './word-actions';
import { describeForm, dictLinks, formatPhonetic, parseDefinitions, surfaceOwnSenses } from './word-info';

/** 视口宽度不超过该值（或设备无悬停能力）时使用底部卡片布局 */
const SHEET_MAX_VIEWPORT = 600;
/** 下滑超过该距离松手即关闭底部卡片 */
const SHEET_DISMISS_DRAG = 64;
/** 释义默认展示的行数，超出时折叠并显示“展开” */
const DEF_CLAMP_LINES = 3;
const TOAST_MS = 5000;
/** 带“撤销”按钮的 toast 停留更久（鼠标悬停/聚焦时暂停计时） */
const TOAST_ACTION_MS = 9000;
const DELETE_CONFIRM_MS = 3000;
const ACTIVE_ATTR = 'data-hnw-active';
const ACTIVE_STYLE_ID = 'hnw-card-active-style';

/** 暗色页面上使用的卡片配色（亮色主题卡片自动切换为它，保留主题强调色） */
const DARK_CARD = { background: '#1f2329', color: '#e8eaed' };

/** 卡片内联面板：加入目标选择 / 认识前确认（不可撤销的远端删除、同形异义词） */
type Panel = 'none' | 'targets' | 'confirm-known';

/** 当前单词的操作上下文（打开卡片后异步加载，切换单词时清空） */
interface WordContext {
  collected?: boolean;
  collectedIn?: BookId[];
  addPreview?: WordActionPreview;
  knownPreview?: WordActionPreview;
  /** deletableBooks 中各来源词书的状态（判断是否真的能删） */
  deleteStates?: Record<BookId, SourceBookState | undefined>;
  /** 打包词典的完整释义（不受用户生词本释义覆盖） */
  dict?: DictEntry;
  /** 页面词形自己的打包词典词条（advanced 之于 advance），用于展示分词作形容词等独立义项，见 surfaceOwnSenses */
  surfaceDict?: DictEntry;
}

/** toast 上的操作按钮（撤销） */
interface ToastAction {
  label: string;
  run: () => Promise<void>;
}

/** 锚点被 engine 重建（如加入生词本后全量重扫）时，在该距离内找同一原形的新 mark 作为锚点 */
const REANCHOR_MAX_DISTANCE = 240;

/**
 * 单词卡片（Shadow DOM 宿主 + 原生 DOM 渲染，不依赖框架，不使用 innerHTML）。
 *
 * - 桌面（有悬停能力且视口较宽）：贴词浮层，优先在单词下方，空间不足翻到上方；页面滚动时跟随单词，单词滚出视口则关闭
 * - 手机（无悬停能力或视口 ≤ 600px）：底部卡片，近全宽，可下滑/关闭按钮/点外部关闭；单词会被滚动到卡片上方可见处
 * - 亮暗：打开时检测单词所在区域的背景亮度，暗色页面上把亮色卡片换成暗色版本；强调色取自该单词实际的高亮样式（跟随主题与按词书样式）
 * - 认识：按 wordActions 写熟词本并从生词本移除；含不可撤销的远端删除或同形异义词时先在卡片内确认；完成后关闭卡片并给出可撤销的 toast
 * - 加入生词本：默认写入设置中的目标，可在卡片上临时改选（本页有效）；结果 toast 写明加到了哪里，可撤销；不支持的目标置灰并说明原因
 */
/** 浮层定位结果（视口坐标）；above 表示卡片在锚点上方（影响箭头/动画方向的 class） */
export interface CardPlacement {
  top: number;
  left: number;
  above: boolean;
}

/**
 * 站点浮层定位钩子：站点适配层可以为特定锚点接管 PC 浮层的位置（如 YouTube 字幕生词：卡片整块避让字幕，不盖住正在读的行）。
 * 返回 null 表示不处理，交给下一个钩子或默认定位；底部卡片（手机/触屏）不经过钩子。
 */
export type CardPlacer = (anchor: HTMLElement, card: { width: number; height: number }, viewport: { width: number; height: number }) => CardPlacement | null;

const cardPlacers = new Set<CardPlacer>();

/** 注册浮层定位钩子，返回注销函数 */
export function registerCardPlacer(placer: CardPlacer): () => void {
  cardPlacers.add(placer);
  return () => cardPlacers.delete(placer);
}

export class ShadowCardView implements CardView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly card: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private readonly backend: CardBackend;
  private data: CardData | null = null;
  private _anchor: HTMLElement | null = null;
  private style: CardStyle = { background: '#ffffff', color: '#1f2328', accent: '#2563eb' };
  private sheet = false;
  /** 释义是否展开全部（切换单词时复位） */
  private expanded = false;
  private panel: Panel = 'none';
  private ctx: WordContext = {};
  /** 上下文加载序号：切换单词后丢弃旧请求的结果 */
  private ctxSeq = 0;
  /** “加入生词本”的候选目标（每次打开卡片刷新） */
  private addTargets: AddTargetOption[] | undefined;
  /** 卡片上临时选择的加入目标（本页有效；null = 用设置中的默认目标） */
  private tempAddTargets: BookId[] | null = null;
  /** 目标面板中正在编辑的勾选 */
  private draftTargets = new Set<BookId>();
  /** 认识确认面板：是否同时删除同形异义词形 */
  private confirmHomographs = false;
  /** 说明行是否展开详情（默认只显示一行去向摘要） */
  private hintsOpen = false;
  /** 底部卡片的“词典”下拉是否展开 */
  private linksOpen = false;
  /** 锚点最近一次的位置（锚点被重建后据此找回同一位置的新 mark） */
  private anchorRect: DOMRect | null = null;
  /** 卡片打开期间监听锚点是否被移出文档 */
  private anchorObserver: MutationObserver | null = null;
  private busy: 'add' | 'known' | 'delete' | null = null;
  private deleteConfirm = false;
  private deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private rafId = 0;
  private dragStartY: number | null = null;
  /**
   * 释义是否仍在加载：入口先以 entry=undefined 打开，查询完成后（无论是否查到）调用 update，
   * 因此 open 时无 entry 视为加载中（骨架屏），update 后视为已完成（无 entry 显示“暂无释义”）。
   */
  private awaitingEntry = false;
  /** 一次性提示（v11：PC 端首次出现时说明当前触发方式），切换单词、关闭或点“知道了”后清除 */
  private onceHint: string | null = null;

  constructor(
    private readonly doc: Document,
    private readonly actions: CardActions,
    backend?: CardBackend,
  ) {
    this.backend = backend ?? createCardBackend();
    this.host = doc.createElement(TAG_CARD_HOST);
    // 宿主本身也可能被页面通配样式影响（如 `html > * {display:none}`），用内联 !important 固定为不占位的透明层
    this.host.setAttribute(
      'style',
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; display: block !important; z-index: 2147483647 !important; pointer-events: auto !important;',
    );
    // open 模式：便于 Playwright 等测试工具穿透 Shadow DOM
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = CARD_CSS;
    this.card = h(doc, 'div', { class: 'card', role: 'dialog', 'aria-modal': 'false' });
    this.card.hidden = true;
    this.toast = h(doc, 'div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    this.toast.hidden = true;
    this.root.append(style, this.card, this.toast);
    this.card.addEventListener('click', (e) => void this.onClick(e));
    this.card.addEventListener('change', (e) => this.onChange(e));
    // 悬停/聚焦 toast 时暂停自动消失，便于点“撤销”
    this.toast.addEventListener('pointerenter', () => clearTimeout(this.toastTimer));
    this.toast.addEventListener('pointerleave', () => this.scheduleToastHide(TOAST_MS));
    this.bindSheetDrag();
    doc.documentElement.appendChild(this.host);
    window.addEventListener('scroll', this.onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', this.onViewportChange, { passive: true });
  }

  get isOpen(): boolean {
    return !this.card.hidden;
  }

  get anchor(): HTMLElement | null {
    return this._anchor;
  }

  open(anchor: HTMLElement, data: CardData): void {
    const sameWord = this.isOpen && this.data?.lemma === data.lemma;
    this.setActiveAnchor(anchor);
    // SPA 可能清理 documentElement 下的未知节点，打开前确保宿主仍在文档中
    if (!this.host.isConnected) this.doc.documentElement.appendChild(this.host);
    if (!sameWord) {
      this.onceHint = null;
      this.expanded = false;
      this.hintsOpen = false;
      this.linksOpen = false;
      this.panel = 'none';
      this.busy = null;
      this.resetDeleteConfirm();
      this.ctx = data.collected === undefined ? {} : { collected: data.collected };
      this.loadWordContext(data);
    }
    this.sheet = this.shouldUseSheet();
    this.applyColors(anchor);
    this.awaitingEntry = !data.entry;
    this.render(data);
    const wasOpen = this.isOpen;
    // 新卡片打开时收起上一条 toast，避免与底部卡片重叠
    this.hideToast();
    this.card.hidden = false;
    this.layout();
    this.watchAnchor();
    if (!wasOpen) {
      this.card.classList.remove('in');
      // 下一帧再加 .in 触发过渡；同步读一次布局保证起始状态生效
      void this.card.offsetWidth;
      this.card.classList.add('in');
    }
    if (this.sheet) this.revealAnchorAboveSheet();
  }

  update(data: CardData): void {
    if (!this.isOpen) return;
    this.awaitingEntry = false;
    this.render(data);
    this.layout();
  }

  close(): void {
    if (!this.isOpen && !this._anchor) return;
    this.card.hidden = true;
    this.card.classList.remove('in', 'dragging');
    this.card.style.removeProperty('--drag');
    this.unwatchAnchor();
    this.setActiveAnchor(null);
    this.anchorRect = null;
    this.data = null;
    this.onceHint = null;
    this.panel = 'none';
    this.ctxSeq++;
    this.resetDeleteConfirm();
    // 卡片关闭后 toast 回到视口底部
    this.placeToast();
  }

  contains(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  showHint(text: string): void {
    if (!this.isOpen) return;
    this.onceHint = text;
    this.rerender();
  }

  showMessage(message: string, ok: boolean, lemma?: string): void {
    const [first = ok ? '已完成' : '操作失败', ...details] = messageParts(message);
    const title = lemma ? `「${lemma}」${ok ? '' : '：'}${first}` : first;
    this.showNotice({ level: ok ? 'ok' : 'err', title, details });
  }

  setStyle(style: CardStyle): void {
    this.style = style;
    // 入口在存储变化（如加入生词本触发重扫）后调用；锚点可能刚被重建，先找回新锚点再取色
    if (this.isOpen && this._anchor && !this._anchor.isConnected) this.reanchor();
    if (this.isOpen && this._anchor) this.applyColors(this._anchor);
  }

  destroy(): void {
    window.removeEventListener('scroll', this.onViewportChange, { capture: true });
    window.removeEventListener('resize', this.onViewportChange);
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.toastTimer);
    clearTimeout(this.deleteConfirmTimer);
    this.unwatchAnchor();
    this.setActiveAnchor(null);
    this.doc.getElementById(ACTIVE_STYLE_ID)?.remove();
    this.host.remove();
  }

  // ---------------- 单词操作上下文 ----------------

  /**
   * 打开新单词时并行加载：收藏状态、加入/认识的预览、加入候选目标、来源词书删除能力。
   * 都只读本地缓存（background 不发网络请求），任一失败不影响卡片主体，只是少显示对应提示。
   */
  private loadWordContext(data: CardData): void {
    const seq = ++this.ctxSeq;
    const apply = (patch: Partial<WordContext>) => {
      if (seq !== this.ctxSeq || this.data?.lemma !== data.lemma) return;
      this.ctx = { ...this.ctx, ...patch };
      this.rerender();
    };
    const ignore = () => {};
    this.backend.getWordState(data.lemma).then((s) => apply({ collected: s.collected, collectedIn: s.collectedIn }), ignore);
    this.backend.preview('add', data.surface, data.lemma).then((p) => apply({ addPreview: p }), ignore);
    this.backend.preview('known', data.surface, data.lemma).then((p) => apply({ knownPreview: p }), ignore);
    this.backend.listAddTargets().then((t) => {
      this.addTargets = t;
      apply({});
    }, ignore);
    this.backend.lookupDict?.(data.lemma).then((dict) => dict && apply({ dict }), ignore);
    // 页面词形与命中原形不同时也查词形自己的词条：advanced 是常用形容词“先进的”，原形 advance 的释义里没有
    const surfaceWord = data.surface.toLowerCase();
    if (surfaceWord !== data.lemma.toLowerCase()) {
      this.backend.lookupDict?.(surfaceWord).then((surfaceDict) => surfaceDict && apply({ surfaceDict }), ignore);
    }
    if (data.deletableBooks.length) {
      this.backend.sourceStates(data.deletableBooks.map((b) => b.id)).then((s) => apply({ deleteStates: s }), ignore);
    }
  }

  /** 加入/移出生词本后，“认识”要移除的生词本随之变化，重新取预览 */
  private refreshKnownPreview(data: CardData): void {
    const seq = this.ctxSeq;
    this.backend.preview('known', data.surface, data.lemma).then(
      (p) => {
        if (seq !== this.ctxSeq || this.data?.lemma !== data.lemma) return;
        this.ctx = { ...this.ctx, knownPreview: p };
        this.rerender();
      },
      () => {},
    );
  }

  /** 实际生效的加入目标：临时选择 > 设置默认（候选未加载时为 undefined） */
  private effectiveAddTargets(): AddTargetOption[] | undefined {
    const all = this.addTargets;
    if (!all) return undefined;
    if (this.tempAddTargets) return all.filter((t) => this.tempAddTargets!.includes(t.id));
    return all.filter((t) => t.isDefault);
  }

  /** 来源删除：data.deletableBooks 中真正可删的书 + 不可删的原因 */
  private deletable(data: CardData): { books: BookMeta[]; reason?: string } {
    const states = this.ctx.deleteStates;
    if (!states) return { books: data.deletableBooks };
    const books = data.deletableBooks.filter((b) => {
      const s = states[b.id];
      return !s || (!s.orphaned && s.canDelete !== false);
    });
    if (books.length) return { books };
    const s = states[data.deletableBooks[0]?.id ?? ''];
    return { books, reason: s?.orphaned ? '远端已没有该生词本' : (s?.readOnlyReason ?? '该生词本不支持删除') };
  }

  // ---------------- 渲染 ----------------

  private rerender(): void {
    if (!this.isOpen || !this.data) return;
    this.render(this.data);
    this.layout();
  }

  private render(data: CardData): void {
    this.data = data;
    const d = this.doc;
    const e = data.entry;
    const dict = this.ctx.dict;
    // 释义始终以打包词典的完整义项为主：入口的组合词典在单词进入用户生词本后会用生词本里的一行释义覆盖它，
    // 生词本释义与词典不同时作为附加信息单独显示
    const main = dict?.full || dict?.short ? dict : e;
    const userTrans = main !== e ? extraUserTrans(e, dict) : undefined;
    const loading = !main && this.awaitingEntry;
    const phon = formatPhonetic(e?.phonetic ?? dict?.phonetic);
    const form = describeForm(data.surface, data.lemma);
    const defs = parseDefinitions(main?.short, main?.full);
    const surfaceSenses = surfaceOwnSenses(data.surface, data.lemma, this.ctx.surfaceDict);
    const clamp = !this.expanded && defs.length > DEF_CLAMP_LINES;

    let defsNode: Child[];
    if (defs.length) {
      defsNode = [
        h(d, 'ul', { class: `defs${clamp ? ' clamp' : ''}` }, ...defs.map((x) => h(d, 'li', {}, x.pos && h(d, 'span', { class: 'pos' }, x.pos), x.text))),
        clamp && h(d, 'button', { class: 'more', 'data-act': 'expand' }, `展开全部 ${defs.length} 条释义`),
      ];
    } else if (loading) {
      defsNode = [h(d, 'span', { class: 'loading' }), h(d, 'span', { class: 'loading s' })];
    } else {
      defsNode = [h(d, 'div', { class: 'empty' }, '暂无释义，可在下方词典中查询')];
    }

    this.card.setAttribute('aria-label', `单词 ${data.lemma}`);
    const keep = ['dark', 'in', 'above', 'dragging'].filter((c) => this.card.classList.contains(c));
    // paneled：内联面板打开；手机底部卡片上面板占满卡片（隐藏释义与底栏），操作按钮不被遮挡
    this.card.className = ['card', this.sheet ? 'sheet' : 'popover', ...(this.panel !== 'none' ? ['paneled'] : []), ...keep].join(' ');

    const head = h(
      d,
      'div',
      { class: 'head' },
      h(
        d,
        'div',
        { class: 'row1' },
        h(
          d,
          'div',
          { class: 'title' },
          h(d, 'span', { class: 'word', lang: 'en' }, data.lemma),
          h(d, 'button', { class: 'phon', 'data-act': 'speak', 'aria-label': '发音', title: '发音' }, icon(d, 'speak'), phon ? h(d, 'span', { lang: 'en' }, phon) : h(d, 'span', {}, '发音')),
        ),
        h(d, 'button', { class: 'icon', 'data-act': 'close', 'aria-label': '关闭', title: '关闭 (Esc)' }, icon(d, 'close')),
      ),
    );

    const body = h(
      d,
      'div',
      { class: 'body' },
      form &&
        h(d, 'div', { class: 'form' }, h(d, 'b', { lang: 'en' }, data.surface), h(d, 'span', { class: 'rel' }, form), h(d, 'span', {}, '原形 ', h(d, 'b', { lang: 'en' }, data.lemma))),
      // 页面词形自己的义项（advanced adj. 先进的）排在原形释义前，与行内注解一致
      surfaceSenses.length > 0 &&
        h(
          d,
          'div',
          { class: 'surface-defs' },
          h(d, 'div', { class: 'ut-label' }, '本页词形 ', h(d, 'b', { lang: 'en' }, data.surface.toLowerCase())),
          h(d, 'ul', { class: 'defs' }, ...surfaceSenses.map((x) => h(d, 'li', {}, h(d, 'span', { class: 'pos' }, x.pos), x.text))),
          h(d, 'div', { class: 'ut-label' }, '原形 ', h(d, 'b', { lang: 'en' }, data.lemma)),
        ),
      ...defsNode,
      userTrans && h(d, 'div', { class: 'user-trans' }, h(d, 'span', { class: 'ut-label' }, '生词本释义'), h(d, 'span', {}, userTrans)),
      data.books.length > 0 && h(d, 'div', { class: 'tags' }, ...data.books.map((b) => bookTag(d, b))),
    );

    // 一次性提示放在单词标题下方：首次出现时先看到“卡片是怎么打开的”，点“知道了”收起
    const onceHint =
      this.onceHint &&
      this.panel === 'none' &&
      h(
        d,
        'div',
        { class: 'once-hint', role: 'note', lang: 'zh-CN' },
        icon(d, 'info'),
        h(d, 'span', {}, this.onceHint),
        h(d, 'button', { class: 'once-ok', 'data-act': 'hint-ok' }, '知道了'),
      );

    this.card.replaceChildren(
      ...[h(d, 'div', { class: 'grab', 'aria-hidden': 'true' }, h(d, 'i')), head, onceHint || null, body, this.renderPanel(data), this.renderFoot(data)].filter(
        (n): n is HTMLElement => !!n,
      ),
    );
  }

  /** 底栏：认识 / 加入生词本（含目标下拉）/ 从来源删除；下方一行说明操作去向与不支持的原因；词典链接 */
  private renderFoot(data: CardData): HTMLElement {
    const d = this.doc;
    const ctx = this.ctx;

    // ---- 认识 ----
    const knownBtn = h(
      d,
      'button',
      { class: 'btn primary', 'data-act': 'known', disabled: this.busy === 'known', title: '标为熟词：全站不再高亮，可撤销' },
      icon(d, 'check'),
      h(d, 'span', {}, '认识'),
    );

    // ---- 加入生词本（主按钮 + 目标下拉） ----
    const eff = this.effectiveAddTargets();
    const usable = eff?.filter((t) => !t.disabledReason);
    const addBlocked = !ctx.collected && !!eff && !usable!.length;
    const addReason = addBlocked ? blockedText(eff!) : undefined;
    const collected = !!ctx.collected;
    const addLabel = this.busy === 'add' ? (collected ? '正在移出…' : '正在加入…') : collected ? '已在生词本' : '加入生词本';
    const addTitle = collected
      ? `已在生词本，点按移出${ctx.collectedIn?.length ? `（${this.targetNames(ctx.collectedIn)}）` : ''}`
      : addReason
        ? `无法加入：${addReason}`
        : `加入到 ${usable?.map((t) => t.name).join('、') || '我的生词本'}`;
    const split = h(
      d,
      'div',
      { class: `split${collected ? ' on' : ''}${addBlocked ? ' off' : ''}${this.panel === 'targets' ? ' open' : ''}` },
      h(
        d,
        'button',
        {
          class: 'btn ghost main',
          'data-act': 'add',
          'aria-pressed': collected ? 'true' : 'false',
          'aria-disabled': addBlocked ? 'true' : undefined,
          disabled: this.busy === 'add',
          title: addTitle,
        },
        icon(d, collected ? 'bookmark' : 'bookmarkAdd'),
        h(d, 'span', {}, addLabel),
        this.tempAddTargets && !collected && h(d, 'i', { class: 'dot', title: '使用临时目标' }),
      ),
      h(
        d,
        'button',
        {
          class: 'btn ghost caret',
          'data-act': 'targets',
          'aria-expanded': this.panel === 'targets' ? 'true' : 'false',
          'aria-label': '选择加入到哪本生词本',
          title: '选择加入到哪本生词本',
        },
        icon(d, 'caret'),
      ),
    );

    // ---- 从来源生词本删除（两步确认；不可删时置灰并说明） ----
    let deleteBtn: HTMLElement | false = false;
    let deleteReason: string | undefined;
    if (data.deletableBooks.length) {
      const del = this.deletable(data);
      deleteReason = del.reason;
      const label = this.busy === 'delete' ? '正在移出…' : this.deleteConfirm ? '确认移出？' : '';
      deleteBtn = h(
        d,
        'button',
        {
          class: `btn ghost danger del${this.deleteConfirm ? ' confirm' : ''}${del.reason ? ' off' : ''}`,
          'data-act': 'delete',
          'aria-disabled': del.reason ? 'true' : undefined,
          disabled: this.busy === 'delete',
          'aria-label': del.reason ? `无法从来源生词本移出：${del.reason}` : `从${del.books.map((b) => b.name).join('、')}移出`,
          title: del.reason ? `无法移出：${del.reason}` : `从${del.books.map((b) => b.name).join('、')}移出（远端同步删除）`,
        },
        icon(d, 'remove'),
        label && h(d, 'span', {}, label),
      );
    }

    // ---- 说明行：默认一行去向摘要（加入 → 哪里 · 认识 → 哪里），逐项去向与跳过/只读原因折叠在“i”详情里 ----
    const summary: { text: string; warn?: boolean }[] = [];
    const details: HTMLElement[] = [];
    let skips = 0;
    if (collected) {
      if (ctx.collectedIn?.length) summary.push({ text: `已在 ${shortNames(ctx.collectedIn.map((id) => this.targetName(id)))}` });
    } else if (eff) {
      const segs: HintSegment[] = [
        usable!.length
          ? { text: `写入 ${usable!.map((t) => t.name).join('、')}${this.tempAddTargets ? '（本页临时选择）' : ''}`, warn: false }
          : { text: '没有可写入的生词本', warn: true },
      ];
      for (const t of eff.filter((x) => x.disabledReason)) segs.push({ text: `${t.name}：${t.disabledReason}，已跳过`, warn: true });
      skips += segs.length - 1;
      summary.push(
        usable!.length
          ? { text: `加入 → ${shortNames(usable!.map((t) => t.name))}${this.tempAddTargets ? '（本页）' : ''}` }
          : { text: '加入 → 没有可写入的生词本', warn: true },
      );
      details.push(hintLine(d, '加入', segs));
    }
    if (ctx.knownPreview) {
      const segs = describePreview(ctx.knownPreview).segments;
      const okWrite = ctx.knownPreview.write.filter((w) => w.ok).map((w) => w.name);
      summary.push({ text: `认识 → ${shortNames(okWrite.length ? okWrite : ['本地熟词本'])}` });
      skips += segs.filter((x) => x.warn).length;
      details.push(hintLine(d, '认识', segs));
    }
    if (deleteReason) {
      skips++;
      details.push(hintLine(d, '移出', [{ text: `来源生词本：${deleteReason}`, warn: true }]));
    }
    const hints: HTMLElement[] = [];
    if (summary.length) {
      hints.push(
        h(
          d,
          'div',
          { class: 'hint-sum' },
          h(
            d,
            'span',
            { class: 'sum-text', title: summary.map((x) => x.text).join(' · ') },
            ...summary.map((x, i) => h(d, 'span', x.warn ? { class: 'warn' } : {}, i ? ` · ${x.text}` : x.text)),
          ),
          details.length > 0 &&
            h(
              d,
              'button',
              {
                class: `info${skips ? ' has-skip' : ''}`,
                'data-act': 'hints',
                'aria-expanded': this.hintsOpen ? 'true' : 'false',
                'aria-label': this.hintsOpen ? '收起说明' : skips ? `查看说明（${skips} 项跳过或不支持）` : '查看说明',
                title: skips ? `${skips} 项跳过或不支持，点按查看原因` : '查看详细去向',
              },
              icon(d, 'info'),
              skips > 0 && h(d, 'span', {}, String(skips)),
            ),
        ),
      );
      if (this.hintsOpen) hints.push(h(d, 'div', { class: 'hint-details' }, ...details));
    }

    const hintsEl = hints.length > 0 && h(d, 'div', { class: 'hints', lang: 'zh-CN' }, ...hints);
    const links = h(
      d,
      'div',
      { class: 'links' },
      h(d, 'span', {}, '词典'),
      ...dictLinks(data.lemma).map((l) => h(d, 'a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', 'data-dict': l.id }, l.name)),
    );
    const actions = h(d, 'div', { class: 'actions' }, knownBtn, split, deleteBtn);
    if (!this.sheet) return h(d, 'div', { class: 'foot' }, actions, hintsEl, links);
    // 底部卡片（手机）：说明摘要收进“i”（CSS 在未展开时隐藏摘要文字），词典链接收进“词典”下拉，两者共用一行，
    // 不再各占一行（评审：说明 + 词典链接占了近 1/4 屏）
    return h(
      d,
      'div',
      { class: 'foot' },
      actions,
      h(
        d,
        'div',
        { class: `foot-meta${this.hintsOpen ? ' open' : ''}` },
        h(
          d,
          'button',
          { class: 'btn ghost dicts', 'data-act': 'links', 'aria-expanded': this.linksOpen ? 'true' : 'false', title: '外部词典' },
          h(d, 'span', {}, '词典'),
          icon(d, 'caret'),
        ),
        hintsEl,
      ),
      this.linksOpen && links,
    );
  }

  /** 内联面板（不用浮动下拉：手机上更好点，也不会被视口裁掉） */
  private renderPanel(data: CardData): HTMLElement | null {
    if (this.panel === 'targets') return this.renderTargetsPanel();
    if (this.panel === 'confirm-known') return this.renderConfirmKnown(data);
    return null;
  }

  private renderTargetsPanel(): HTMLElement {
    const d = this.doc;
    const all = this.addTargets;
    const list = all
      ? all.map((t) =>
          h(
            d,
            'label',
            t.disabledReason
              ? { class: 'opt off', 'data-act': 'opt-off', 'data-name': t.name, 'data-reason': t.disabledReason }
              : { class: 'opt' },
            h(d, 'input', {
              type: 'checkbox',
              'data-target': t.id,
              checked: this.draftTargets.has(t.id) && !t.disabledReason,
              disabled: !!t.disabledReason,
            }),
            h(
              d,
              'span',
              { class: 'opt-text' },
              h(d, 'span', { class: 'opt-name' }, t.name, t.isDefault && h(d, 'em', {}, '默认'), t.remote && h(d, 'em', { class: 'remote' }, '远端')),
              (t.disabledReason || t.note) && h(d, 'span', { class: 'opt-note' }, t.disabledReason ?? t.note!),
            ),
          ),
        )
      : [h(d, 'span', { class: 'loading' })];
    const count = [...this.draftTargets].filter((id) => all?.some((t) => t.id === id && !t.disabledReason)).length;
    return h(
      d,
      'div',
      { class: 'panel', role: 'group', 'aria-label': '加入到' },
      h(d, 'div', { class: 'panel-title' }, '加入到'),
      h(d, 'div', { class: 'opts' }, ...list),
      h(d, 'p', { class: 'panel-note' }, '只对本页的“加入”生效；长期修改：扩展设置 → 生词本 → 单词操作'),
      h(
        d,
        'div',
        { class: 'panel-actions' },
        this.tempAddTargets && h(d, 'button', { class: 'btn ghost', 'data-act': 'targets-reset' }, '恢复默认'),
        h(d, 'button', { class: 'btn ghost', 'data-act': 'panel-cancel' }, '取消'),
        h(d, 'button', { class: 'btn primary', 'data-act': 'targets-apply', disabled: count === 0 }, count ? `加入所选（${count}）` : '请选择'),
      ),
    );
  }

  /** 认识前确认：列出不可撤销的远端删除；同形异义词形（lie 的 lay）默认不删，可勾选一并删除 */
  private renderConfirmKnown(data: CardData): HTMLElement {
    const d = this.doc;
    const p = this.ctx.knownPreview;
    const remote = p?.remove.filter((r) => r.ok && r.remote) ?? [];
    const homographs = [...new Set(remote.flatMap((r) => r.homographs ?? []))];
    const items = remote.map((r) => {
      const words = r.words.filter((w) => !r.homographs?.includes(w));
      return words.length ? h(d, 'li', {}, `从“${r.name}”删除 `, h(d, 'b', { lang: 'en' }, words.join('、')), r.undoable ? '' : '（撤销时无法恢复）') : null;
    });
    return h(
      d,
      'div',
      { class: 'panel warn', role: 'alertdialog', 'aria-label': '确认认识' },
      h(d, 'div', { class: 'panel-title' }, icon(d, 'info'), `认识「${data.lemma}」将同时修改远端生词本`),
      h(d, 'ul', { class: 'confirm-list' }, ...items),
      homographs.length > 0 &&
        h(
          d,
          'label',
          { class: 'opt' },
          h(d, 'input', { type: 'checkbox', 'data-homographs': '', checked: this.confirmHomographs }),
          h(
            d,
            'span',
            { class: 'opt-text' },
            h(d, 'span', { class: 'opt-name' }, '同时删除 ', h(d, 'b', { lang: 'en' }, homographs.join('、'))),
            h(d, 'span', { class: 'opt-note' }, '它们也是独立的单词，默认保留'),
          ),
        ),
      h(
        d,
        'div',
        { class: 'panel-actions' },
        h(d, 'button', { class: 'btn ghost', 'data-act': 'panel-cancel' }, '取消'),
        h(d, 'button', { class: 'btn primary', 'data-act': 'known-confirm' }, '确认认识'),
      ),
    );
  }

  private targetNames(ids: BookId[]): string {
    return ids.map((id) => this.targetName(id)).join('、');
  }

  private targetName(id: BookId): string {
    return this.addTargets?.find((t) => t.id === id)?.name ?? id;
  }

  // ---------------- 布局 ----------------

  private shouldUseSheet(): boolean {
    const vw = this.doc.documentElement.clientWidth || window.innerWidth;
    if (vw <= SHEET_MAX_VIEWPORT) return true;
    // 无悬停能力的触屏设备（平板）也用底部卡片
    return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  private layout(): void {
    if (this.sheet) {
      // 底部卡片的位置完全由 CSS 决定
      this.card.style.removeProperty('top');
      this.card.style.removeProperty('left');
      if (this._anchor?.isConnected) this.anchorRect = this._anchor.getBoundingClientRect();
    } else {
      this.positionPopover();
    }
    this.placeToast();
  }

  /**
   * 浮层定位：站点钩子（registerCardPlacer）优先；默认优先在单词下方，空间不足放上方；水平以单词为中心并限制在视口内。
   * 锚点已被移出文档（engine 重建了高亮）且找不到接替的 mark 时保持原位，不跳到视口左上角。
   */
  private positionPopover(): void {
    let anchor = this._anchor;
    if (anchor && !anchor.isConnected && this.reanchor()) anchor = this._anchor;
    if (!anchor || !anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    this.anchorRect = r;
    const vw = this.doc.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const cw = this.card.offsetWidth;
    const ch = this.card.offsetHeight;
    for (const placer of cardPlacers) {
      const p = placer(anchor, { width: cw, height: ch }, { width: vw, height: vh });
      if (!p) continue;
      this.card.classList.toggle('above', p.above);
      this.card.style.top = `${Math.round(p.top)}px`;
      this.card.style.left = `${Math.round(p.left)}px`;
      return;
    }
    const gap = 8;
    const below = r.bottom + gap;
    const above = r.top - gap - ch;
    const placeAbove = below + ch > vh - 8 && above >= 8;
    const top = placeAbove ? above : Math.min(below, Math.max(8, vh - ch - 8));
    const left = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), Math.max(8, vw - cw - 8));
    this.card.classList.toggle('above', placeAbove);
    this.card.style.top = `${Math.round(top)}px`;
    this.card.style.left = `${Math.round(left)}px`;
  }

  /** 卡片打开期间监听 DOM：锚点被 engine 重建（加入生词本后重扫、SPA 局部刷新）时换到新的 mark */
  private watchAnchor(): void {
    if (this.anchorObserver || typeof MutationObserver === 'undefined') return;
    this.anchorObserver = new MutationObserver(() => {
      const a = this._anchor;
      // 只在锚点脱离文档时处理；回调里只做 isConnected 判断，大页面上开销可忽略
      if (!this.isOpen || !a || a.isConnected) return;
      if (this.reanchor() && this.isOpen && this._anchor) this.applyColors(this._anchor);
    });
    this.anchorObserver.observe(this.doc.body ?? this.doc.documentElement, { childList: true, subtree: true });
  }

  private unwatchAnchor(): void {
    this.anchorObserver?.disconnect();
    this.anchorObserver = null;
  }

  /**
   * 锚点被移出文档后：找同一原形、离原位置最近（≤ REANCHOR_MAX_DISTANCE）的新 mark 接替锚点并重新定位。
   * 找不到时返回 false，卡片保持原位与原配色（调用方决定是否关闭）。
   */
  private reanchor(): boolean {
    const lemma = this.data?.lemma;
    const last = this.anchorRect;
    if (!lemma || !last) return false;
    let best: HTMLElement | null = null;
    let bestDistance = REANCHOR_MAX_DISTANCE;
    for (const m of this.doc.querySelectorAll<HTMLElement>(TAG_MARK)) {
      if (m.getAttribute(ATTR_LEMMA) !== lemma) continue;
      const r = m.getBoundingClientRect();
      const distance = Math.hypot(r.left - last.left, r.top - last.top);
      if (distance <= bestDistance) {
        best = m;
        bestDistance = distance;
      }
    }
    if (!best) return false;
    this.setActiveAnchor(best);
    this.anchorRect = best.getBoundingClientRect();
    if (!this.sheet) this.positionPopover();
    return true;
  }

  /** 底部卡片打开时，若单词会被卡片挡住，把页面滚动到单词位于卡片上方 */
  private revealAnchorAboveSheet(): void {
    const anchor = this._anchor;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const sheetTop = this.card.getBoundingClientRect().top;
    const margin = 16;
    if (r.bottom + margin <= sheetTop && r.top >= 0) return;
    const delta = r.bottom + margin - sheetTop;
    window.scrollBy({ top: r.top < 0 ? r.top - 64 : delta, behavior: 'smooth' });
  }

  /** 页面滚动/尺寸变化：浮层跟随单词（rAF 节流），单词离开视口则关闭；底部卡片保持不动 */
  private readonly onViewportChange = (e: Event): void => {
    if (!this.isOpen || this.contains(e)) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      const anchor = this._anchor;
      if (!this.isOpen || !anchor) return;
      if (!anchor.isConnected && !this.reanchor()) {
        this.close();
        return;
      }
      const wantSheet = this.shouldUseSheet();
      if (wantSheet !== this.sheet && this.data) {
        // 旋转屏幕/调整窗口跨过阈值时切换布局
        this.sheet = wantSheet;
        this.render(this.data);
        this.layout();
      }
      if (this.sheet) return;
      const r = this._anchor!.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        this.close();
        return;
      }
      this.positionPopover();
    });
  };

  /** 底部卡片下滑关闭：在把手/头部区域拖动，超过阈值松手关闭，否则回弹 */
  private bindSheetDrag(): void {
    const isDragZone = (e: Event) =>
      this.sheet && e.composedPath().some((n) => n instanceof Element && (n.classList.contains('grab') || n.classList.contains('head')));
    this.card.addEventListener('pointerdown', (e) => {
      if (!isDragZone(e) || (e.target as Element).closest('button')) return;
      this.dragStartY = e.clientY;
      this.card.classList.add('dragging');
    });
    this.card.addEventListener('pointermove', (e) => {
      if (this.dragStartY === null) return;
      const dy = Math.max(0, e.clientY - this.dragStartY);
      this.card.style.setProperty('--drag', `${dy}px`);
    });
    const end = (e: PointerEvent) => {
      if (this.dragStartY === null) return;
      const dy = e.clientY - this.dragStartY;
      this.dragStartY = null;
      this.card.classList.remove('dragging');
      this.card.style.removeProperty('--drag');
      if (dy > SHEET_DISMISS_DRAG) this.close();
    };
    this.card.addEventListener('pointerup', end);
    this.card.addEventListener('pointercancel', end);
  }

  // ---------------- 主题 ----------------

  /**
   * 卡片配色：底色/文字色来自主题 CardStyle（暗色页面换暗色卡片）；强调色优先取该单词实际渲染的高亮颜色
   * （下划线色 / 马克笔或底色 / 文字色，跟随全局主题与按词书样式），再调整明度保证在卡片底色上可读，
   * 单词没有可用颜色（如“无样式”只显示括号译文）时用主题的 accent。
   */
  private applyColors(anchor: HTMLElement): void {
    // 脱离文档的锚点取不到计算样式（会被误判为亮色页面），保持当前配色
    if (!anchor.isConnected) return;
    const pageDark = isDarkBackground(anchor);
    const cardIsLight = luminance(this.style.background) > 0.5;
    const useDark = pageDark && cardIsLight;
    const bg = useDark ? DARK_CARD.background : this.style.background;
    const fg = useDark ? DARK_CARD.color : this.style.color;
    const themeAccent = parseColor(this.style.accent);
    const fromMark = markAccent(anchor);
    // 单词颜色与主题强调色同一色系时用主题调好的强调色（如琥珀主题的 #b45309 比机械调暗的黄色更好看）；
    // 不同色系（按词书另设颜色、v5 自定义样式）时跟随单词颜色
    const base = fromMark && !(themeAccent && hueDistance(fromMark, themeAccent) < 40) ? fromMark : (themeAccent ?? fromMark);
    const bgRgb = parseColor(bg) ?? [255, 255, 255, 1];
    const accentRgb = base ? fitContrast(base, bgRgb, 4.5) : null;
    const accent = accentRgb ? rgbText(accentRgb) : this.style.accent;
    // 主按钮文字：白/近黑中对比度更高者
    const accentFg = accentRgb && contrast(accentRgb, [255, 255, 255, 1]) >= contrast(accentRgb, [17, 17, 17, 1]) ? '#fff' : '#111';
    this.card.style.setProperty('--bg', bg);
    this.card.style.setProperty('--fg', fg);
    this.card.style.setProperty('--accent', accent);
    this.card.style.setProperty('--accent-fg', accentFg);
    const dark = useDark || luminance(this.style.background) < 0.35;
    this.card.classList.toggle('dark', dark);
    this.toast.style.setProperty('--accent', accent);
    this.doc.documentElement.style.setProperty('--hnw-active', `color-mix(in srgb, ${accent} ${pageDark ? 34 : 18}%, transparent)`);
  }

  private setActiveAnchor(anchor: HTMLElement | null): void {
    if (this._anchor && this._anchor !== anchor) this._anchor.removeAttribute(ACTIVE_ATTR);
    this._anchor = anchor;
    if (!anchor) return;
    if (!this.doc.getElementById(ACTIVE_STYLE_ID)) {
      const s = this.doc.createElement('style');
      s.id = ACTIVE_STYLE_ID;
      s.textContent = ACTIVE_MARK_CSS;
      (this.doc.head ?? this.doc.documentElement).appendChild(s);
    }
    anchor.setAttribute(ACTIVE_ATTR, '');
  }

  // ---------------- 交互 ----------------

  private onChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.dataset.target) {
      if (input.checked) this.draftTargets.add(input.dataset.target);
      else this.draftTargets.delete(input.dataset.target);
      // 只更新“加入所选（n）”按钮，不整卡重绘（保留焦点）
      const apply = this.card.querySelector<HTMLButtonElement>('[data-act="targets-apply"]');
      const n = [...this.draftTargets].filter((id) => this.addTargets?.some((t) => t.id === id && !t.disabledReason)).length;
      if (apply) {
        apply.disabled = n === 0;
        apply.textContent = n ? `加入所选（${n}）` : '请选择';
      }
    } else if (input.hasAttribute('data-homographs')) {
      this.confirmHomographs = input.checked;
    }
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
    const data = this.data;
    if (!btn || !data || btn.hasAttribute('disabled')) return;
    switch (btn.dataset.act) {
      case 'speak':
        this.actions.speak(data.lemma);
        break;
      case 'close':
        this.close();
        break;
      case 'hint-ok':
        this.onceHint = null;
        this.rerender();
        break;
      case 'expand':
        this.expanded = true;
        this.rerender();
        break;
      case 'hints':
        this.hintsOpen = !this.hintsOpen;
        this.rerender();
        break;
      case 'links':
        this.linksOpen = !this.linksOpen;
        this.rerender();
        break;
      case 'opt-off':
        // 置灰的目标（只读分组等）：触屏没有 tooltip，点按时用 toast 说明原因
        this.showNotice({ level: 'warn', title: `${btn.dataset.name ?? '该生词本'}不能加词：${btn.dataset.reason ?? '不支持'}`, details: [] });
        break;
      case 'known':
        await this.onKnown(data);
        break;
      case 'known-confirm':
        await this.markKnown(data, this.confirmHomographs);
        break;
      case 'add':
        await this.onAdd(data);
        break;
      case 'targets':
        this.togglePanel('targets');
        break;
      case 'targets-apply':
        await this.applyTempTargets(data);
        break;
      case 'targets-reset':
        this.tempAddTargets = null;
        this.draftTargets = new Set(this.addTargets?.filter((t) => t.isDefault).map((t) => t.id));
        this.rerender();
        this.showToast('已恢复为设置中的默认生词本');
        break;
      case 'panel-cancel':
        this.togglePanel('none');
        break;
      case 'delete':
        await this.deleteFromSources(data);
        break;
    }
  }

  private togglePanel(panel: Panel): void {
    this.panel = this.panel === panel ? 'none' : panel;
    if (this.panel === 'targets') {
      const current = this.effectiveAddTargets() ?? [];
      this.draftTargets = new Set(current.map((t) => t.id));
    }
    if (this.panel === 'confirm-known') this.confirmHomographs = false;
    this.rerender();
  }

  /**
   * 点“认识”：预览中含不可撤销的远端删除或同形异义词形时，先在卡片内确认；否则直接执行。
   * 预览尚未返回时等它（只读本地缓存，通常几毫秒），失败则直接执行（background 自身也会扣下同形异义词）。
   */
  private async onKnown(data: CardData): Promise<void> {
    let p = this.ctx.knownPreview;
    if (!p) {
      p = await this.backend.preview('known', data.surface, data.lemma).catch(() => undefined);
      if (this.data !== data) return;
      if (p) this.ctx = { ...this.ctx, knownPreview: p };
    }
    const risky = p?.remove.some((r) => r.ok && r.remote && (!r.undoable || r.homographs?.length));
    if (risky) {
      this.togglePanel('confirm-known');
      return;
    }
    await this.markKnown(data, false);
  }

  /** 认识：入口会先乐观移除页面高亮；卡片立即关闭，结果 toast 写明记入哪里、移除了什么，并可撤销 */
  private async markKnown(data: CardData, withHomographs: boolean): Promise<void> {
    this.busy = 'known';
    const pending = this.actions.markKnown(data.lemma, data.surface);
    this.close();
    try {
      let res = await pending;
      // 用户勾选了同形异义词：background 第一次调用扣下了它们（withheld），带 confirmed 再调一次（幂等）
      if (withHomographs && res.withheld?.length) res = await this.backend.confirmKnown(data.surface, data.lemma);
      const known = res;
      // 来源删除报告只有 bookId：用打开卡片时的预览/候选目标换成显示名
      const nameOf = (id: BookId) =>
        this.ctx.knownPreview?.remove.find((r) => r.bookId === id)?.name ?? this.addTargets?.find((t) => t.id === id)?.name ?? id;
      this.showNotice(knownNotice(known, data.lemma), {
        label: '撤销',
        run: async () => {
          // 直接调 background 拿到“已加回/无法加回”，提示与原操作对称（逐本说明还原结果）
          const undo = await this.backend.unmarkKnown(data.lemma);
          this.showNotice(undoKnownNotice(known, undo, data.lemma, nameOf));
        },
      });
    } catch (err) {
      this.showToast(`标记失败：${errorText(err)}`, undefined, true);
    } finally {
      this.busy = null;
    }
  }

  /** 加入生词本主按钮：未收藏 -> 加入当前目标；已收藏 -> 移出；没有可写目标 -> 说明原因并打开目标选择 */
  private async onAdd(data: CardData): Promise<void> {
    if (this.ctx.collected) {
      await this.removeCollected(data);
      return;
    }
    const eff = this.effectiveAddTargets();
    if (eff && !eff.some((t) => !t.disabledReason)) {
      this.showToast(`无法加入：${blockedText(eff)}。请选择其他生词本`, undefined, true);
      if (this.panel !== 'targets') this.togglePanel('targets');
      return;
    }
    await this.addWord(data, this.tempAddTargets ?? undefined);
  }

  private async applyTempTargets(data: CardData): Promise<void> {
    const valid = [...this.draftTargets].filter((id) => this.addTargets?.some((t) => t.id === id && !t.disabledReason));
    if (!valid.length) return;
    const defaults = this.addTargets?.filter((t) => t.isDefault && !t.disabledReason).map((t) => t.id) ?? [];
    // 选择与默认目标完全一致时不算临时目标
    const same = valid.length === defaults.length && valid.every((id) => defaults.includes(id));
    this.tempAddTargets = same ? null : valid;
    this.panel = 'none';
    if (this.ctx.collected) {
      this.rerender();
      return;
    }
    await this.addWord(data, this.tempAddTargets ?? undefined);
  }

  private async addWord(data: CardData, targets: BookId[] | undefined): Promise<void> {
    this.busy = 'add';
    this.rerender();
    try {
      const res = await this.backend.addWord({
        word: data.surface,
        lemma: data.lemma,
        ...(data.entry?.short ? { trans: data.entry.short } : {}),
        ...(data.entry?.phonetic ? { phonetic: data.entry.phonetic } : {}),
        ...(targets ? { targets } : {}),
      });
      const addedIds = res.added.filter((a) => a.ok).map((a) => a.bookId);
      if (res.ok && this.data?.lemma === data.lemma) this.ctx = { ...this.ctx, collected: true, collectedIn: addedIds };
      this.refreshKnownPreview(data);
      // 请求了临时目标时，后台按 targets 写入（完全取代默认目标）；结果按实际写入逐项说明
      const restoredKnown = res.removedKnown.filter((r) => r.ok && r.words.length);
      this.showNotice(
        addNotice(res, data.lemma),
        res.ok
          ? {
              label: '撤销',
              run: async () => {
                const undo = await this.backend.removeWord(data.lemma, addedIds);
                if (this.data?.lemma === data.lemma && undo.ok) this.ctx = { ...this.ctx, collected: false, collectedIn: [] };
                this.refreshKnownPreview(data);
                this.rerender();
                const n = removeNotice(undo, data.lemma, '已撤销加入：');
                // 加入时从熟词本移除的词，撤销加入时 background 会加回（10 分钟内）
                for (const r of restoredKnown) n.details.push(`已重新记入“${r.name}”：${r.words.join(', ')}`);
                this.showNotice(n);
              },
            }
          : undefined,
      );
    } catch (err) {
      this.showToast(`加入失败：${errorText(err)}`, undefined, true);
    } finally {
      this.busy = null;
      this.rerender();
    }
  }

  /** 取消收藏：从已收藏的生词本移出（只处理该原形本身），可撤销（加回同样的生词本） */
  private async removeCollected(data: CardData): Promise<void> {
    const ids = this.ctx.collectedIn?.length ? this.ctx.collectedIn : undefined;
    this.busy = 'add';
    this.rerender();
    try {
      const res = await this.backend.removeWord(data.lemma, ids);
      if (this.data?.lemma === data.lemma && res.ok) this.ctx = { ...this.ctx, collected: false, collectedIn: [] };
      this.refreshKnownPreview(data);
      const removedIds = res.removed.filter((r) => r.ok && r.words.length).map((r) => r.bookId);
      this.showNotice(
        removeNotice(res, data.lemma),
        res.ok && removedIds.length
          ? {
              label: '撤销',
              run: async () => {
                // 只加回刚移出的那几本（targets 完全取代默认目标）
                const again = await this.backend.addWord({ word: data.surface, lemma: data.lemma, targets: removedIds });
                if (this.data?.lemma === data.lemma && again.ok) this.ctx = { ...this.ctx, collected: true, collectedIn: again.added.filter((a) => a.ok).map((a) => a.bookId) };
                this.refreshKnownPreview(data);
                this.rerender();
                this.showNotice(addNotice(again, data.lemma, '已撤销移出：'));
              },
            }
          : undefined,
      );
    } catch (err) {
      this.showToast(`移出失败：${errorText(err)}`, undefined, true);
    } finally {
      this.busy = null;
      this.rerender();
    }
  }

  /** 从来源生词本删除：第一次点击进入确认态（3 秒内再点确认），避免误触；不可删时只说明原因 */
  private async deleteFromSources(data: CardData): Promise<void> {
    const del = this.deletable(data);
    if (del.reason) {
      this.showToast(`无法从来源生词本移出：${del.reason}`, undefined, true);
      return;
    }
    if (!this.deleteConfirm) {
      this.deleteConfirm = true;
      this.rerender();
      clearTimeout(this.deleteConfirmTimer);
      this.deleteConfirmTimer = setTimeout(() => {
        this.deleteConfirm = false;
        this.rerender();
      }, DELETE_CONFIRM_MS);
      return;
    }
    this.resetDeleteConfirm();
    this.busy = 'delete';
    this.rerender();
    try {
      const res = await this.actions.deleteFromSources(data.lemma, del.books.map((b) => b.id));
      this.busy = null;
      this.close();
      this.showToast(res.message || (res.ok ? `已从生词本移出「${data.lemma}」` : '移出失败'), undefined, !res.ok);
    } catch (err) {
      this.busy = null;
      this.rerender();
      this.showToast(`移出失败：${errorText(err)}`, undefined, true);
    }
  }

  private resetDeleteConfirm(): void {
    clearTimeout(this.deleteConfirmTimer);
    this.deleteConfirm = false;
  }

  // ---------------- toast ----------------

  /** 简单提示（无详情）：error=true 时用失败样式 */
  private showToast(message: string, action?: ToastAction, error = false): void {
    this.showNotice({ level: error ? 'err' : 'ok', title: message, details: [] }, action);
  }

  /**
   * 结果提示：一行主结论 + 可选“撤销” + 可展开的“详情”（逐项去向、跳过原因）。
   * 成功为深色条；部分失败（warn，黄色图标）与失败（err，红色底）用独立的警示样式。
   * 位置：始终在视口底部；手机底部卡片打开时放在卡片正上方，不遮挡卡片。
   */
  private showNotice(notice: Notice, action?: ToastAction): void {
    const d = this.doc;
    if (!this.host.isConnected) d.documentElement.appendChild(this.host);
    clearTimeout(this.toastTimer);
    const actionBtn =
      action &&
      h(
        d,
        'button',
        {
          class: 't-act',
          'data-act': 'toast',
          onclick: async () => {
            actionBtn!.setAttribute('disabled', '');
            try {
              await action.run();
            } catch (err) {
              this.showToast(`操作失败：${errorText(err)}`, undefined, true);
            }
          },
        },
        action.label,
      );
    const details = notice.details.length
      ? h(d, 'ul', { class: 't-details', hidden: true }, ...notice.details.map((x) => h(d, 'li', {}, x)))
      : null;
    const detailBtn: HTMLButtonElement | null =
      details &&
      h(
        d,
        'button',
        {
          class: 't-more',
          'data-act': 'toast-details',
          'aria-expanded': 'false',
          onclick: () => {
            const open = details.hidden;
            details.hidden = !open;
            detailBtn!.setAttribute('aria-expanded', String(open));
            detailBtn!.textContent = open ? '收起' : '详情';
            // 展开详情时暂停自动消失，收起后重新计时
            if (open) clearTimeout(this.toastTimer);
            else this.scheduleToastHide(action ? TOAST_ACTION_MS : TOAST_MS);
            this.placeToast();
          },
        },
        '详情',
      );
    const iconName = notice.level === 'ok' ? 'check' : notice.level === 'warn' ? 'alert' : 'error';
    this.toast.replaceChildren();
    append(this.toast, [
      h(
        d,
        'div',
        { class: 't-row' },
        h(d, 'span', { class: 't-icon' }, icon(d, iconName)),
        h(d, 'span', { class: 'msg', title: notice.title }, notice.title),
        detailBtn,
        actionBtn,
      ),
      details,
    ]);
    this.toast.classList.remove('ok', 'warn', 'err');
    this.toast.classList.add(notice.level);
    // 失败提示用 alert 角色，读屏立即播报
    this.toast.setAttribute('role', notice.level === 'ok' ? 'status' : 'alert');
    this.toast.hidden = false;
    this.placeToast();
    void this.toast.offsetWidth;
    this.toast.classList.add('in');
    // 失败与带“撤销”的提示停留更久
    this.scheduleToastHide(action || notice.level !== 'ok' ? TOAST_ACTION_MS : TOAST_MS);
  }

  /** toast 位置：默认视口底部；手机底部卡片打开时紧贴卡片上沿（统一在底部区域，不挡卡片） */
  private placeToast(): void {
    if (this.isOpen && this.sheet) {
      const top = this.card.getBoundingClientRect().top;
      const gap = window.innerHeight - top + 8;
      if (top > 0 && gap > 0) {
        this.toast.style.setProperty('bottom', `${Math.round(gap)}px`);
        return;
      }
    }
    this.toast.style.removeProperty('bottom');
  }

  private scheduleToastHide(ms: number): void {
    clearTimeout(this.toastTimer);
    if (this.toast.hidden) return;
    this.toastTimer = setTimeout(() => this.hideToast(), ms);
  }

  private hideToast(): void {
    if (this.toast.hidden) return;
    clearTimeout(this.toastTimer);
    this.toast.classList.remove('in');
    this.toastTimer = setTimeout(() => (this.toast.hidden = true), 200);
  }
}

function bookTag(d: Document, b: BookMeta): HTMLElement {
  const user = b.kind !== 'builtin';
  return h(d, 'span', { class: `tag${user ? ' user' : ''}`, title: b.name }, user ? b.name : b.short || b.name);
}

/** 说明行：标签 + 若干段（警示段用警示色），段间用分号分隔 */
function hintLine(d: Document, label: string, segments: HintSegment[]): HTMLElement {
  const full = segments.map((x) => x.text).join('；');
  return h(
    d,
    'p',
    { class: `hint${segments.some((x) => x.warn) ? ' has-warn' : ''}`, title: full },
    h(d, 'b', {}, label),
    ...segments.map((x, i) => h(d, 'span', x.warn ? { class: 'warn' } : {}, i ? `；${x.text}` : x.text)),
  );
}

/** 入口词条（可能来自用户生词本）中与词典不同的释义；已包含在词典释义里时不重复显示 */
function extraUserTrans(entry: DictEntry | undefined, dict: DictEntry | undefined): string | undefined {
  const user = entry?.full?.trim();
  if (!user) return undefined;
  const squash = (x: string | undefined) => (x ?? '').replace(/\s+/g, '');
  const dictText = squash(dict?.full) + squash(dict?.short);
  return dictText.includes(squash(user)) ? undefined : user.replace(/\s*\n\s*/g, '；');
}

/** 摘要里的名称：一本直接显示，多本显示“第一本 等 n 本” */
function shortNames(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list[0]} 等 ${list.length} 本`;
}

/** 目标都不可用时的原因汇总 */
function blockedText(targets: AddTargetOption[]): string {
  if (!targets.length) return '没有选择生词本';
  return targets.map((t) => `${t.name}${t.disabledReason ? `（${t.disabledReason}）` : ''}`).join('、');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------- 颜色工具 ----------------

type Rgba = [number, number, number, number];

/** 解析 #rgb/#rrggbb(aa)/rgb()/rgba() 为相对亮度 0~1；无法解析时按亮色处理 */
export function luminance(color: string | Rgba): number {
  const rgba = typeof color === 'string' ? parseColor(color) : color;
  if (!rgba) return 1;
  const [r, g, b] = rgba.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseColor(color: string): Rgba | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((x) => x + x).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbText(c: Rgba): string {
  return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

/**
 * 在保持色相/饱和度的前提下调整明度，使颜色在背景上达到对比度 min（亮底变暗、暗底变亮）。
 * 马克笔黄这类浅色直接当文字色不可读，调暗后仍是同一色系。
 */
export function fitContrast(color: Rgba, bg: Rgba, min: number): Rgba {
  const opaque: Rgba = [color[0], color[1], color[2], 1];
  if (contrast(opaque, bg) >= min) return opaque;
  const [hue0, sat, light] = rgbToHsl(opaque);
  const darken = luminance(bg) > 0.4;
  // 黄色（约 40°~70°）直接调暗会发灰发绿，调暗时同时往橙色偏一点
  const hue = darken && hue0 > 40 / 360 && hue0 < 70 / 360 ? hue0 - 12 / 360 : hue0;
  let best = opaque;
  for (let i = 1; i <= 20; i++) {
    const l = darken ? light * (1 - i / 20) : light + (1 - light) * (i / 20);
    best = hslToRgb(hue, sat, l);
    if (contrast(best, bg) >= min) break;
  }
  return best;
}

/** 两个颜色的色相差（度，0~180）；任一接近灰色时视为不同色系 */
function hueDistance(a: Rgba, b: Rgba): number {
  const [ha, sa] = rgbToHsl(a);
  const [hb, sb] = rgbToHsl(b);
  if (sa < 0.15 || sb < 0.15) return 180;
  const diff = Math.abs(ha - hb) * 360;
  return Math.min(diff, 360 - diff);
}

function rgbToHsl([r, g, b]: Rgba): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const dd = max - min;
  const s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
  let hh: number;
  if (max === rr) hh = (gg - bb) / dd + (gg < bb ? 6 : 0);
  else if (max === gg) hh = (bb - rr) / dd + 2;
  else hh = (rr - gg) / dd + 4;
  return [hh / 6, s, l];
}

function hslToRgb(hh: number, s: number, l: number): Rgba {
  if (s === 0) return [l * 255, l * 255, l * 255, 1];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255, 1];
}

/**
 * 从单词实际渲染的高亮样式中取强调色（跟随 engine 的主题/按词书样式，不依赖样式数据结构）：
 * 装饰线颜色 > 背景图（马克笔渐变）中的颜色 > 背景色 > 边框色 > 与父元素不同的文字色。都没有时返回 null。
 */
export function markAccent(anchor: Element): Rgba | null {
  const view = anchor.ownerDocument.defaultView;
  if (!view) return null;
  const target = anchor.querySelector(TAG_WORD) ?? anchor;
  const cs = view.getComputedStyle(target);
  const visible = (c: Rgba | null): c is Rgba => !!c && c[3] > 0.05;
  const line = cs.textDecorationLine || '';
  if (line && line !== 'none') {
    const c = parseColor(cs.textDecorationColor || '');
    if (visible(c)) return c;
  }
  const img = cs.backgroundImage || '';
  if (img && img !== 'none') {
    const m = /rgba?\([^)]+\)/.exec(img);
    const c = m ? parseColor(m[0]) : null;
    if (visible(c)) return c;
  }
  const bgc = parseColor(cs.backgroundColor || '');
  if (visible(bgc)) return bgc;
  if (cs.borderBottomStyle && cs.borderBottomStyle !== 'none' && parseFloat(cs.borderBottomWidth) > 0) {
    const c = parseColor(cs.borderBottomColor || '');
    if (visible(c)) return c;
  }
  const parent = anchor.parentElement;
  if (parent) {
    const own = parseColor(cs.color || '');
    const inherited = parseColor(view.getComputedStyle(parent).color || '');
    if (visible(own) && (!inherited || own.slice(0, 3).join() !== inherited.slice(0, 3).join())) return own;
  }
  return null;
}

/**
 * 单词所在区域是否为暗色背景：从单词向上找第一个不透明背景色；都透明时看根元素 color-scheme 与系统偏好。
 */
export function isDarkBackground(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const rgba = parseColor(view.getComputedStyle(node).backgroundColor);
    if (rgba && rgba[3] > 0.5) return luminance(rgba) < 0.18;
  }
  const scheme = view.getComputedStyle(el.ownerDocument.documentElement).colorScheme || '';
  return scheme.includes('dark') && typeof view.matchMedia === 'function' && view.matchMedia('(prefers-color-scheme: dark)').matches;
}
