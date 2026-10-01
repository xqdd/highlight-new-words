import { h } from '../../card/h';
import { ATTR_BOOKS, ATTR_LEMMA, TAG_WORD } from '../../engine/dom';
import { shortenTranslation } from '../../engine/engine';
import { BASE_CSS } from '../../floatball/css';
import { bindSheetDrag, createOverlayHost, type OverlayHost } from '../../floatball/host';
import { svgIcon } from '../../floatball/icons';
import { isTouchPrimary, tokenize } from '../../floatball/model';
import { openFloatMenu } from '../../floatball/registry';
import type { SiteContext } from '../types';
import { captionWindows, getPlayer, getVideo } from './dom';
import type { PauseController } from './playback';
import { sentenceIndexAt, type CaptionHistory, type Cue, type TimedtextSource } from './track';

export const TAG_PANEL_HOST = 'hnw-yt-panel-host';

const PANEL_CSS = `
${BASE_CSS}
.panel {
  position: fixed; pointer-events: auto; display: flex; flex-direction: column; background: var(--bg); box-shadow: var(--shadow); overflow: hidden;
  border-radius: 16px; max-height: min(70vh, 520px);
  opacity: 0; transform: translateY(-6px); transition: opacity .16s, transform .16s;
}
.panel.in { opacity: 1; transform: none; }
.panel.sheet { border-radius: 18px 18px 0 0; max-height: min(62vh, 560px); transform: translateY(100%); opacity: 1; transition: transform .22s cubic-bezier(.2, .8, .2, 1); }
.panel.sheet.in { transform: none; }
.head .time { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 8px; font-variant-numeric: tabular-nums; }
.body { padding: 4px 16px 8px; }
.ctx { color: var(--muted); font-size: 14px; line-height: 1.7; margin: 0 0 8px; }
.cur { font-size: 19px; line-height: 2.4; margin: 0; word-break: normal; overflow-wrap: anywhere; }
.tok {
  display: inline-block; position: relative; vertical-align: baseline; line-height: 1.3;
  padding: 0 2px; margin: 0 -1px; border-radius: 6px;
}
.tok:hover, .tok:active { background: var(--hover); }
.tok.new .w { color: var(--accent); font-weight: 600; text-decoration: underline 2px color-mix(in srgb, var(--accent) 55%, transparent); text-underline-offset: 3px; }
/* 短释义绝对定位在单词正下方，不参与排版（行高已预留），标点与单词保持同一基线 */
.tok .g {
  position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 1px;
  font-size: 11px; line-height: 1.2; color: var(--gloss); max-width: 8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400;
}
.tok[data-hnw-active] { background: var(--accent-soft); }

.empty { padding: 18px 4px; color: var(--muted); font-size: 14px; }
.nav { flex: none; display: flex; gap: 8px; padding: 8px 12px 12px; border-top: 1px solid var(--line); }
.nav .btn { flex: 1; padding: 0 10px; }
.nav .btn.primary { flex: 1.4; }
.keys { padding: 0 16px 10px; font-size: 12px; color: var(--muted); }
.keys kbd { font: 11px/1 ui-monospace, monospace; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--line); background: var(--soft); }
.src { font-size: 11px; color: var(--muted); padding: 0 16px 8px; }
`;

export interface CaptionData {
  timedtext: TimedtextSource;
  history: CaptionHistory;
  videoId(): string;
}

/**
 * “当前字幕”面板（v9）：暂停视频，显示当前一两句字幕，每个词都可点开单词卡片，生词带短释义。
 *
 * - 触屏：底部抽屉（竖屏播放器在顶部，不遮视频）；桌面：浮在播放器顶部居中（快捷键 Alt+L 打开/关闭）
 * - 数据：优先 timedtext 字幕轨（可上一句/下一句、从此句播放）；没有时用 DOM 字幕历史（已播过的句子）；
 *   再没有时只显示屏幕上当前字幕
 * - 关闭后恢复播放，前提是暂停是我们发起的（PauseController）
 * - 全屏时宿主随全屏元素迁移（registerOverlayHost）
 */
export class CaptionPanel {
  private overlay: OverlayHost | null = null;
  private panel: HTMLElement | null = null;
  private sentences: Cue[] = [];
  private index = -1;
  /** 数据来源：track=字幕轨，history=已播放历史，screen=只有当前屏幕字幕 */
  private source: 'track' | 'history' | 'screen' = 'screen';
  private renderSeq = 0;
  private sheet = false;

  constructor(
    private readonly ctx: SiteContext,
    private readonly pause: PauseController,
    private readonly data: CaptionData,
  ) {}

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** 面板及其宿主（悬停暂停的“离开判定”把它算作热区） */
  get host(): HTMLElement | null {
    return this.overlay?.host ?? null;
  }

  toggle(): void {
    if (this.panel) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    if (this.panel) return;
    const doc = this.ctx.doc;
    this.pause.pause();
    this.overlay ??= createOverlayHost(doc, TAG_PANEL_HOST, PANEL_CSS);
    this.overlay.ensureMounted();
    this.overlay.setTheme(this.ctx.getSettings());
    this.sheet = isTouchPrimary((q) => matchMedia(q).matches);
    this.panel = h(doc, 'div', { class: `panel${this.sheet ? ' sheet' : ''}`, role: 'dialog', 'aria-label': '当前字幕' });
    this.overlay.ui.appendChild(this.panel);
    this.layout();
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.layout, { passive: true });
    getVideo(doc)?.addEventListener('timeupdate', this.onTime);
    await this.load();
    requestAnimationFrame(() => this.panel?.classList.add('in'));
  }

  /** 关闭：收起卡片（锚点在面板内），只恢复由我们发起的暂停 */
  close(opts: { resume?: boolean } = {}): void {
    const panel = this.panel;
    if (!panel) return;
    this.panel = null;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.layout);
    getVideo(this.ctx.doc)?.removeEventListener('timeupdate', this.onTime);
    const card = this.ctx.getCard();
    if (card?.isOpen && card.anchor && panel.contains(card.anchor)) card.close();
    panel.classList.remove('in');
    setTimeout(() => panel.remove(), 220);
    if (opts.resume !== false) this.pause.resume();
  }

  destroy(): void {
    this.close({ resume: false });
    this.overlay?.destroy();
    this.overlay = null;
  }

  // ---------------- 数据 ----------------

  private nowMs(): number {
    return Math.round((getVideo(this.ctx.doc)?.currentTime ?? 0) * 1000);
  }

  private async load(): Promise<void> {
    const vid = this.data.videoId();
    const track = vid ? await this.data.timedtext.get(vid) : null;
    const t = this.nowMs();
    if (track && track.sentences.length > 0) {
      this.source = 'track';
      this.sentences = track.sentences;
      this.index = sentenceIndexAt(this.sentences, t);
    } else {
      const hist = this.data.history.list(vid);
      if (hist.length > 0) {
        this.source = 'history';
        this.sentences = hist;
        this.index = sentenceIndexAt(hist, t);
      } else {
        this.source = 'screen';
        const text = captionWindows(this.ctx.doc).map((w) => w.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
        this.sentences = text ? [{ start: t, end: t, text }] : [];
        this.index = this.sentences.length ? 0 : -1;
      }
    }
    await this.render();
  }

  private readonly onTime = () => {
    // 面板打开期间用户自己点了播放：跟随播放进度更新当前句
    if (!this.panel || this.source === 'screen') return;
    const i = sentenceIndexAt(this.sentences, this.nowMs());
    if (i !== this.index) {
      this.index = i;
      void this.render();
    }
  };

  /** 切换句子：跳到该句开头（保持暂停），关闭后从这里继续 */
  private go(delta: number): void {
    const i = this.index + delta;
    if (i < 0 || i >= this.sentences.length) return;
    this.index = i;
    const v = getVideo(this.ctx.doc);
    if (v && this.source !== 'screen') v.currentTime = this.sentences[i]!.start / 1000 + 0.01;
    void this.render();
  }

  /** 从当前句开头播放（用户主动播放，关闭面板并播放，不论暂停是谁发起的） */
  private playFromHere(): void {
    const v = getVideo(this.ctx.doc);
    const cue = this.sentences[this.index];
    if (v && cue && this.source !== 'screen') v.currentTime = cue.start / 1000 + 0.01;
    this.close({ resume: false });
    this.pause.release();
    void v?.play()?.catch?.(() => {});
  }

  // ---------------- 渲染 ----------------

  private readonly layout = () => {
    const p = this.panel;
    if (!p) return;
    if (this.sheet) {
      Object.assign(p.style, { left: '0', right: '0', bottom: '0', top: '', width: '100%', maxWidth: '560px', margin: '0 auto' });
      return;
    }
    // 桌面：浮在播放器顶部居中（不遮住底部的字幕与进度条）
    const r = getPlayer(this.ctx.doc)?.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const width = Math.min(680, (r?.width ?? vw) - 24, vw - 16);
    const left = r ? r.left + (r.width - width) / 2 : (vw - width) / 2;
    const top = r ? Math.max(8, r.top + 12) : 16;
    Object.assign(p.style, { left: `${Math.max(8, left)}px`, top: `${top}px`, width: `${width}px`, maxHeight: r ? `${Math.max(220, r.height - 96)}px` : '' });
  };

  private async render(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const seq = ++this.renderSeq;
    const doc = this.ctx.doc;
    const cur = this.sentences[this.index];
    // 当前句较短时带上前一句作为上下文（“一两句”）
    const prev = cur && cur.text.length < 70 ? this.sentences[this.index - 1] : undefined;
    const words = [...(prev ? tokenize(prev.text) : []), ...(cur ? tokenize(cur.text) : [])].filter((t) => t.word).map((t) => t.text);
    const info = await this.analyze(words);
    if (seq !== this.renderSeq || this.panel !== panel) return;

    const head = h(
      doc,
      'div',
      { class: 'head' },
      h(doc, 'div', { class: 'title' }, '当前字幕', h(doc, 'span', { class: 'time' }, cur && this.source !== 'screen' ? formatTime(cur.start) : '')),
      this.sheet &&
        h(doc, 'button', { type: 'button', class: 'icon-btn', title: '生词高亮菜单', 'aria-label': '生词高亮菜单', onclick: () => {
          this.close();
          openFloatMenu();
        } }, svgIcon(doc, 'menu')),
      h(doc, 'button', { type: 'button', class: 'icon-btn', title: '关闭并继续播放', 'aria-label': '关闭并继续播放', onclick: () => this.close() }, svgIcon(doc, 'close')),
    );
    const body = h(doc, 'div', { class: 'body' });
    if (!cur) {
      body.appendChild(h(doc, 'div', { class: 'empty' }, '当前没有字幕。请先在播放器中打开字幕（CC），播放到有字幕的地方再打开。'));
    } else {
      if (prev) body.appendChild(h(doc, 'p', { class: 'ctx' }, this.renderTokens(prev.text, info, false)));
      body.appendChild(h(doc, 'p', { class: 'cur' }, this.renderTokens(cur.text, info, true)));
    }
    const canNav = this.source !== 'screen' && this.sentences.length > 0;
    const nav =
      canNav &&
      h(
        doc,
        'div',
        { class: 'nav' },
        h(doc, 'button', { type: 'button', class: 'btn', disabled: this.index <= 0, onclick: () => this.go(-1) }, svgIcon(doc, 'prev', 18), '上一句'),
        h(doc, 'button', { type: 'button', class: 'btn primary', onclick: () => this.playFromHere() }, svgIcon(doc, 'play', 16), '从此句播放'),
        h(doc, 'button', { type: 'button', class: 'btn', disabled: this.index >= this.sentences.length - 1, onclick: () => this.go(1) }, '下一句', svgIcon(doc, 'next', 18)),
      );
    const note =
      this.source === 'history' ? h(doc, 'div', { class: 'src' }, '未取得完整字幕，只能浏览已播放过的句子') : null;
    const keys =
      !this.sheet &&
      h(doc, 'div', { class: 'keys' }, h(doc, 'kbd', {}, 'Alt+L'), ' 打开/关闭　', h(doc, 'kbd', {}, '←'), ' ', h(doc, 'kbd', {}, '→'), ' 切换句子　', h(doc, 'kbd', {}, 'Esc'), ' 关闭');
    const grab = this.sheet ? h(doc, 'div', { class: 'grab', 'aria-hidden': 'true' }) : null;
    panel.replaceChildren(...([grab, head, body, note, nav, keys] as Array<HTMLElement | false | null>).filter((x): x is HTMLElement => !!x));
    if (grab) bindSheetDrag(panel, grab, () => this.close());
  }

  /** 句中单词：是否生词（词条、词书）与短释义；非生词取第一个查得到释义的词形还原候选作卡片词条 */
  private async analyze(words: string[]): Promise<Map<string, { lemma: string; books: string[]; gloss: string; isNew: boolean }>> {
    const matcher = this.ctx.createMatcher();
    const out = new Map<string, { lemma: string; books: string[]; gloss: string; isNew: boolean }>();
    const keys = new Set<string>();
    const plan = new Map<string, { match: ReturnType<typeof matcher.match>; candidates: string[] }>();
    for (const w of new Set(words)) {
      const match = this.ctx.isActive() ? matcher.match(w) : null;
      const candidates = this.ctx.lemmaCandidates(w);
      plan.set(w, { match, candidates });
      candidates.forEach((c) => keys.add(c));
      if (match) keys.add(match.lemma);
    }
    const found = keys.size ? await this.ctx.lookupMany(keys) : new Map();
    for (const [w, { match, candidates }] of plan) {
      if (match) {
        // 释义口径与行内译文一致：先页面词形自己的词条，再原形
        const short = found.get(w.toLowerCase())?.short ?? found.get(match.lemma)?.short;
        out.set(w, { lemma: match.lemma, books: match.bookIds, gloss: short ? shortenTranslation(short, 6) : '', isNew: true });
      } else {
        out.set(w, { lemma: candidates.find((c) => found.has(c)) ?? candidates[0] ?? w.toLowerCase(), books: [], gloss: '', isNew: false });
      }
    }
    return out;
  }

  private renderTokens(text: string, info: Map<string, { lemma: string; books: string[]; gloss: string; isNew: boolean }>, gloss: boolean): Array<Node> {
    const doc = this.ctx.doc;
    return tokenize(text).map((t) => {
      if (!t.word) return doc.createTextNode(t.text);
      const it = info.get(t.text);
      const btn = h(
        doc,
        'button',
        { type: 'button', class: `tok${it?.isNew ? ' new' : ''}`, [ATTR_LEMMA]: it?.lemma ?? t.text.toLowerCase(), [ATTR_BOOKS]: (it?.books ?? []).join(' ') },
        // 单词放在 hnw-w 中：卡片用 markSurface 取页面原词（只取 hnw-w 的文本），不会把下方的短释义也当成原词
        h(doc, TAG_WORD as 'span', { class: 'w' }, t.text),
        gloss && it?.isNew && it.gloss ? h(doc, 'span', { class: 'g' }, it.gloss) : null,
      );
      btn.addEventListener('click', () => this.ctx.openCard(btn));
      return btn;
    });
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.panel || e.altKey || e.ctrlKey || e.metaKey) return;
    const card = this.ctx.getCard();
    if (e.key === 'Escape') {
      // 卡片打开时先由卡片处理 Esc
      if (card?.isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && this.source !== 'screen' && !isEditableTarget(e)) {
      // 否则 YouTube 会把方向键当成快退/快进 5 秒
      e.preventDefault();
      e.stopPropagation();
      this.go(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };
}

function isEditableTarget(e: Event): boolean {
  const t = e.composedPath()[0];
  return t instanceof Element && (!!t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') || (t as HTMLElement).isContentEditable);
}

/** ms -> m:ss / h:mm:ss */
export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
