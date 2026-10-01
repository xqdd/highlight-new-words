import type { CardStyle } from '@/core/theme/themes';
import type { BookMeta } from '@/core/wordbook/types';
import { TAG_CARD_HOST } from '../engine/dom';
import { ACTIVE_MARK_CSS, CARD_CSS } from './card-css';
import type { CardActions, CardData, CardView } from './types';
import { describeForm, dictLinks, formatPhonetic, parseDefinitions } from './word-info';

const ICON_SPEAK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_BOOKMARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h12v17l-6-4.2-6 4.2z"/></svg>`;
const ICON_REMOVE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>`;

/** 视口宽度不超过该值（或设备无悬停能力）时使用底部卡片布局 */
const SHEET_MAX_VIEWPORT = 600;
/** 下滑超过该距离松手即关闭底部卡片 */
const SHEET_DISMISS_DRAG = 64;
/** 释义默认展示的行数，超出时折叠并显示“展开” */
const DEF_CLAMP_LINES = 3;
const TOAST_MS = 5000;
const DELETE_CONFIRM_MS = 3000;
const ACTIVE_ATTR = 'data-hnw-active';
const ACTIVE_STYLE_ID = 'hnw-card-active-style';

/** 暗色页面上使用的卡片配色（亮色主题卡片自动切换为它，保留主题强调色） */
const DARK_CARD = { background: '#1f2329', color: '#e8eaed' };

/**
 * 单词卡片（Shadow DOM 宿主 + 原生 DOM 渲染，不依赖框架）。
 *
 * - 桌面（有悬停能力且视口较宽）：贴词浮层，优先在单词下方，空间不足翻到上方；页面滚动时跟随单词，单词滚出视口则关闭
 * - 手机（无悬停能力或视口 ≤ 600px）：底部卡片，近全宽，可下滑/关闭按钮/点外部关闭；单词会被滚动到卡片上方可见处
 * - 亮暗：打开时检测单词所在区域的背景亮度，暗色页面上把亮色卡片换成暗色版本
 * - 熟词：点“认识”即时移除高亮并关闭卡片，弹出可撤销的 toast
 */
export class ShadowCardView implements CardView {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly card: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private data: CardData | null = null;
  private _anchor: HTMLElement | null = null;
  private style: CardStyle = { background: '#ffffff', color: '#1f2328', accent: '#2563eb' };
  private sheet = false;
  /** 释义是否展开全部（切换单词时复位） */
  private expanded = false;
  private deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private rafId = 0;
  private dragStartY: number | null = null;
  /**
   * 释义是否仍在加载：入口先以 entry=undefined 打开，查询完成后（无论是否查到）调用 update，
   * 因此 open 时无 entry 视为加载中（骨架屏），update 后视为已完成（无 entry 显示“暂无释义”）。
   */
  private awaitingEntry = false;

  constructor(private readonly doc: Document, private readonly actions: CardActions) {
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
    this.card = doc.createElement('div');
    this.card.className = 'card';
    this.card.hidden = true;
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'false');
    this.toast = doc.createElement('div');
    this.toast.className = 'toast';
    this.toast.hidden = true;
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    this.root.append(style, this.card, this.toast);
    this.card.addEventListener('click', (e) => void this.onClick(e));
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
    if (!sameWord) this.expanded = false;
    this.sheet = this.shouldUseSheet();
    this.applyColors(anchor);
    this.awaitingEntry = !data.entry;
    this.render(data);
    const wasOpen = this.isOpen;
    // 新卡片打开时收起上一条 toast，避免与底部卡片重叠
    this.hideToast();
    this.card.hidden = false;
    this.layout();
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
    this.setActiveAnchor(null);
    this.data = null;
    clearTimeout(this.deleteConfirmTimer);
  }

  contains(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  setStyle(style: CardStyle): void {
    this.style = style;
    if (this.isOpen && this._anchor) this.applyColors(this._anchor);
  }

  destroy(): void {
    window.removeEventListener('scroll', this.onViewportChange, { capture: true });
    window.removeEventListener('resize', this.onViewportChange);
    cancelAnimationFrame(this.rafId);
    this.setActiveAnchor(null);
    this.doc.getElementById(ACTIVE_STYLE_ID)?.remove();
    this.host.remove();
  }

  // ---------------- 渲染 ----------------

  private render(data: CardData): void {
    this.data = data;
    const e = data.entry;
    const loading = !e && this.awaitingEntry;
    const phon = formatPhonetic(e?.phonetic);
    const form = describeForm(data.surface, data.lemma);
    const defs = parseDefinitions(e?.short, e?.full);
    const clamp = !this.expanded && defs.length > DEF_CLAMP_LINES;
    const collectable = data.collected !== undefined && !!this.actions.setCollected;

    const defsHtml = defs.length
      ? `<ul class="defs${clamp ? ' clamp' : ''}">${defs
          .map((d) => `<li>${d.pos ? `<span class="pos">${esc(d.pos)}</span>` : ''}${esc(d.text)}</li>`)
          .join('')}</ul>${clamp ? `<button class="more" data-act="expand">展开全部 ${defs.length} 条释义</button>` : ''}`
      : loading
        ? '<span class="loading"></span><span class="loading s"></span>'
        : '<div class="empty">暂无释义，可在下方词典中查询</div>';

    this.card.setAttribute('aria-label', `单词 ${data.lemma}`);
    this.card.className = `card${this.sheet ? ' sheet' : ' popover'}${this.card.classList.contains('dark') ? ' dark' : ''}${this.card.classList.contains('in') ? ' in' : ''}`;
    this.card.innerHTML = `
      <div class="grab" aria-hidden="true"><i></i></div>
      <div class="head">
        <div class="row1">
          <div class="title">
            <span class="word" lang="en">${esc(data.lemma)}</span>
            <button class="phon" data-act="speak" aria-label="发音" title="发音">${ICON_SPEAK}${phon ? `<span lang="en">${esc(phon)}</span>` : '<span>发音</span>'}</button>
          </div>
          ${
            collectable
              ? `<button class="icon${data.collected ? ' on' : ''}" data-act="collect" aria-pressed="${data.collected ? 'true' : 'false'}" aria-label="${data.collected ? '移出生词本' : '加入生词本'}" title="${data.collected ? '移出生词本' : '加入生词本'}">${ICON_BOOKMARK}</button>`
              : ''
          }
          <button class="icon" data-act="close" aria-label="关闭" title="关闭 (Esc)">${ICON_CLOSE}</button>
        </div>
      </div>
      <div class="body">
        ${
          form
            ? `<div class="form"><b lang="en">${esc(data.surface)}</b><span class="rel">${esc(form)}</span><span>原形 <b lang="en">${esc(data.lemma)}</b></span></div>`
            : ''
        }
        ${defsHtml}
        ${data.books.length ? `<div class="tags">${data.books.map(bookTag).join('')}</div>` : ''}
      </div>
      <div class="foot">
        <div class="actions">
          <button class="btn primary" data-act="known" title="标为熟词：全站不再高亮，可撤销">${ICON_CHECK}<span>认识，不再高亮</span></button>
          ${
            data.deletableBooks.length
              ? `<button class="btn ghost danger" data-act="delete" title="从${esc(data.deletableBooks.map((b) => b.name).join('、'))}删除">${ICON_REMOVE}<span>移出生词本</span></button>`
              : ''
          }
        </div>
        <div class="links"><span>词典</span>${dictLinks(data.lemma)
          .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-dict="${l.id}">${esc(l.name)}</a>`)
          .join('')}</div>
      </div>`;
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
      return;
    }
    this.positionPopover();
  }

  /** 浮层定位：优先在单词下方，空间不足放上方；水平以单词为中心并限制在视口内 */
  private positionPopover(): void {
    const anchor = this._anchor;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = this.doc.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const cw = this.card.offsetWidth;
    const ch = this.card.offsetHeight;
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
      if (!anchor.isConnected) {
        this.close();
        return;
      }
      const wantSheet = this.shouldUseSheet();
      if (wantSheet !== this.sheet && this.data) {
        // 旋转屏幕/调整窗口跨过阈值时切换布局
        this.sheet = wantSheet;
        this.render(this.data);
      }
      if (this.sheet) return;
      const r = anchor.getBoundingClientRect();
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

  /** 按主题色 + 页面亮暗设置卡片颜色；激活单词的叠加色取强调色 */
  private applyColors(anchor: HTMLElement): void {
    const pageDark = isDarkBackground(anchor);
    const cardIsLight = luminance(this.style.background) > 0.5;
    const useDark = pageDark && cardIsLight;
    const bg = useDark ? DARK_CARD.background : this.style.background;
    const fg = useDark ? DARK_CARD.color : this.style.color;
    // 暗色卡片上把强调色提亮，保证按钮/标签文字对比度
    const accent = useDark ? `color-mix(in srgb, ${this.style.accent} 70%, #ffffff)` : this.style.accent;
    this.card.style.setProperty('--bg', bg);
    this.card.style.setProperty('--fg', fg);
    this.card.style.setProperty('--accent', accent);
    this.card.classList.toggle('dark', useDark || luminance(this.style.background) < 0.35);
    this.doc.documentElement.style.setProperty('--hnw-active', `color-mix(in srgb, ${this.style.accent} ${pageDark ? 34 : 18}%, transparent)`);
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

  private async onClick(e: MouseEvent): Promise<void> {
    const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
    const data = this.data;
    if (!btn || !data) return;
    switch (btn.dataset.act) {
      case 'speak':
        this.actions.speak(data.lemma);
        break;
      case 'close':
        this.close();
        break;
      case 'expand':
        this.expanded = true;
        this.render(data);
        this.layout();
        break;
      case 'known':
        await this.markKnown(data, btn);
        break;
      case 'delete':
        await this.deleteFromSources(data, btn);
        break;
      case 'collect':
        await this.toggleCollect(data, btn);
        break;
    }
  }

  /** 认识：入口会先乐观移除页面高亮；卡片立即关闭并给出可撤销的 toast */
  private async markKnown(data: CardData, btn: HTMLElement): Promise<void> {
    btn.setAttribute('disabled', '');
    const pending = this.actions.markKnown(data.lemma, data.surface);
    this.close();
    try {
      const res = await pending;
      const extra = res.deleted.length && res.message ? `；${res.message}` : '';
      this.showToast(`已认识「${res.lemma || data.lemma}」，不再高亮${extra}`, '撤销', async () => {
        await this.actions.unmarkKnown(data.lemma);
        this.showToast(`已撤销，「${data.lemma}」恢复高亮`);
      });
    } catch (err) {
      this.showToast(`标记失败：${errorText(err)}`);
    }
  }

  /** 从来源生词本删除：第一次点击进入确认态（3 秒内再点确认），避免误触 */
  private async deleteFromSources(data: CardData, btn: HTMLElement): Promise<void> {
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      btn.querySelector('span')!.textContent = '确认移出？';
      clearTimeout(this.deleteConfirmTimer);
      this.deleteConfirmTimer = setTimeout(() => {
        btn.classList.remove('confirm');
        const label = btn.querySelector('span');
        if (label) label.textContent = '移出生词本';
      }, DELETE_CONFIRM_MS);
      return;
    }
    clearTimeout(this.deleteConfirmTimer);
    btn.setAttribute('disabled', '');
    btn.querySelector('span')!.textContent = '正在移出…';
    try {
      const res = await this.actions.deleteFromSources(data.lemma, data.deletableBooks.map((b) => b.id));
      this.close();
      this.showToast(res.message || (res.ok ? `已从生词本移出「${data.lemma}」` : '移出失败'));
    } catch (err) {
      btn.removeAttribute('disabled');
      btn.classList.remove('confirm');
      btn.querySelector('span')!.textContent = '移出生词本';
      this.showToast(`移出失败：${errorText(err)}`);
    }
  }

  /** 收藏切换：先乐观切换按钮状态，失败回滚 */
  private async toggleCollect(data: CardData, btn: HTMLElement): Promise<void> {
    const next = !data.collected;
    const apply = (on: boolean) => {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', on ? '移出生词本' : '加入生词本');
      btn.title = on ? '移出生词本' : '加入生词本';
    };
    apply(next);
    try {
      const res = await this.actions.setCollected!(data.lemma, data.surface, next);
      if (!res.ok) throw new Error(res.message || '操作失败');
      if (this.data === data) this.data = { ...data, collected: next };
      this.showToast(res.message || (next ? `已加入生词本「${data.lemma}」` : `已移出生词本「${data.lemma}」`));
    } catch (err) {
      apply(!next);
      this.showToast(errorText(err));
    }
  }

  private showToast(message: string, actionLabel?: string, action?: () => Promise<void>): void {
    if (!this.host.isConnected) this.doc.documentElement.appendChild(this.host);
    clearTimeout(this.toastTimer);
    this.toast.innerHTML = `<span class="msg">${esc(message)}</span>${actionLabel ? `<button data-act="toast">${esc(actionLabel)}</button>` : ''}`;
    const btn = this.toast.querySelector('button');
    if (btn && action) {
      btn.addEventListener('click', async () => {
        btn.setAttribute('disabled', '');
        try {
          await action();
        } catch (err) {
          this.showToast(`操作失败：${errorText(err)}`);
        }
      });
    }
    this.toast.hidden = false;
    void this.toast.offsetWidth;
    this.toast.classList.add('in');
    this.toastTimer = setTimeout(() => this.hideToast(), TOAST_MS);
  }

  private hideToast(): void {
    if (this.toast.hidden) return;
    clearTimeout(this.toastTimer);
    this.toast.classList.remove('in');
    this.toastTimer = setTimeout(() => (this.toast.hidden = true), 200);
  }
}

function bookTag(b: BookMeta): string {
  const user = b.kind !== 'builtin';
  const label = user ? b.name : b.short || b.name;
  return `<span class="tag${user ? ' user' : ''}" title="${esc(b.name)}">${esc(label)}</span>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 解析 #rgb/#rrggbb(aa)/rgb()/rgba() 为相对亮度 0~1；无法解析时按亮色处理 */
export function luminance(color: string): number {
  const rgba = parseColor(color);
  if (!rgba) return 1;
  const [r, g, b] = rgba.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseColor(color: string): [number, number, number, number] | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((h) => h + h).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/**
 * 单词所在区域是否为暗色背景：从单词向上找第一个不透明背景色；都透明时看根元素 color-scheme 与系统偏好。
 */
export function isDarkBackground(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const rgba = parseColor(view.getComputedStyle(node).backgroundColor);
    if (rgba && rgba[3] > 0.5) return luminance(view.getComputedStyle(node).backgroundColor) < 0.18;
  }
  const scheme = view.getComputedStyle(el.ownerDocument.documentElement).colorScheme || '';
  return scheme.includes('dark') && typeof view.matchMedia === 'function' && view.matchMedia('(prefers-color-scheme: dark)').matches;
}
