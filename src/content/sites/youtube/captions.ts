import { TAG_MARK, TAG_TRANSLATION, TAG_WORD, ATTR_LEMMA } from '../../engine/dom';
import { shortenTranslation } from '../../engine/engine';
import { markSurface } from '../../engine/highlighter';
import { TRANSLATION_BRACKETS } from '@/core/theme/themes';
import { resolveCaptionStyle, type CaptionGlossStyle, type ResolvedCaptionGlossStyle } from '@/core/theme/caption-style';
import { parseColor } from '../../engine/color';
import type { SiteContext } from '../types';
import {
  ATTR_YT_GLOSS,
  ATTR_YT_GM,
  ATTR_YT_HINT,
  CAPTION_CONTAINER_CLASS,
  CAPTION_SEGMENT_CLASS,
  PLAYER_ID,
  ROLLUP_CLASS,
  YT_STYLE_ID,
  isAutoCaptionHint,
} from './dom';

/** 旧字幕窗口/字幕行保留多久以供同文重建沿用（ms）：重建的移除与插入通常在同一任务内，留一点余量 */
const CARRY_OVER_MS = 500;
/** 窗口标记：after 放不下已退回 above */
const ATTR_FIT_FALLBACK = 'data-hnw-yt-fit';
const CAP = `#${PLAYER_ID}>.${CAPTION_CONTAINER_CLASS}`;
const MARK_IN_CAP = `${CAP} ${TAG_MARK}`;

/**
 * 注解外观声明（颜色、底色、字重、斜体、描边），上方/下方/词后三种模式共用；字号、定位由各模式规则负责。
 * 描边：深色底只要轻微描边；无底色时加重黑色描边，保证亮画面上可读；浅色实底（如黄底黑字）不描边。
 * @param baseWeight 不加粗时的字重（上方/下方注解 500、词后 400）
 * 选项页的字幕样式预览也用它，与页面渲染一致
 */
export function glossLook(s: ResolvedCaptionGlossStyle, baseWeight: number): string {
  const bg = s.background ? parseColor(s.background) : null;
  const lightBg = !!bg && bg.a > 0.5 && (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255 > 0.55;
  const shadow = !s.background ? '0 0 2px #000,0 0 3px #000,1px 1px 2px #000' : lightBg ? 'none' : '0 0 1px #000,0 0 2px #000';
  return (
    `background:${s.background || 'transparent'};color:${s.color || 'inherit'};font-weight:${s.bold ? 700 : baseWeight};font-style:${s.italic ? 'italic' : 'normal'};` +
    `text-shadow:${shadow}`
  );
}

/**
 * 字幕专用样式（注入一次，与 engine 的页面样式相互独立）：
 * - 字幕内一律不显示 engine 的行内译文（hnw-tr），mark 强制回到普通行内，保持 YouTube 的折行结果；
 *   字幕内译文由本模块按窗口模式（ATTR_YT_GM）用 mark::after 渲染，文本放在属性里，不进入 textContent
 * - above：有注解的生词改为 inline-block 并加 padding-top（= 注解高度），注解绝对定位在这段留白里（宽度限制在单词附近，过长省略）。
 *   留白跟着单词所在的那一行走：字幕段折成两行时，第二行的生词只撑高第二行，注解不会压到第一行文字上（逐行定位）；
 *   单词本身是不可拆分的，inline-block 不改变折行位置。字幕窗贴底定位，只会向上长高：不改变宽度、不折行、不裁切。
 *   注解字号随字幕字号（em）缩放，全屏时字幕变大注解也变大：缺省 0.64em（可调，≥ 字幕字号的 55%，桌面 20px 字幕约 13px），
 *   下限桌面 12px、触屏 12px（手机字幕本身只有约 15px）。
 *   对比度：缺省注解自带近乎不透明的深色底（只包住文字，宽度不超过单词附近）并加黑色描边，
 *   视频画面再亮、用户把字幕背景调成透明时，暖黄字与深底仍有 ≥ 7:1 的对比度；用户去掉底色时改用加重的黑色描边
 * - below：与 above 对称，留白加在生词下方（padding-bottom），注解贴底；字幕窗贴底定位，同样只向上长高。
 * - after：词后小字（字号、底色同上）。字幕段改为不折行（white-space:pre），字幕行改为居中的 flex，超出 YouTube 测量的窗口宽度时
 *   向两侧对称溢出（仍居中，背景随字幕段延伸）；超出播放器宽度的窗口由脚本改回 above
 * - 自动生成字幕（roll-up）窗口与自动字幕提示窗口同样显示译文，但 above/below 一律改用 after（见 CaptionDecorator#process）；
 *   窗口高度固定、overflow:hidden，after 超宽时注解可能被裁切
 * - 注解样式（颜色、底色、字号、括号、加粗、斜体）来自 settings.youtube.captionStyle（预设与解析见 core/theme/caption-style.ts），
 *   括号对三种模式都适用
 */
export function buildCaptionCss(style?: CaptionGlossStyle): string {
  // 注解样式（用户可在 设置 › 更多 › YouTube 字幕 中选预设或自定义），缺省为近黑底 + 暖黄字、字幕字号的 0.64
  const st = resolveCaptionStyle(style);
  const em = `${st.fontScale}em`;
  // 触屏字幕字号本身小（约 15px），注解比例至少 0.7
  const touchEm = `${Math.max(st.fontScale, 0.7)}em`;
  const [open, close] = TRANSLATION_BRACKETS[st.bracket];
  const content = st.bracket === 'none' ? `attr(${ATTR_YT_GLOSS})` : `"${open}" attr(${ATTR_YT_GLOSS}) "${close}"`;
  const look = glossLook(st, 500);
  const win = (mode: string) => `${CAP} .caption-window[${ATTR_YT_GM}="${mode}"]`;
  // 无释义的词写的是空注解，不占位
  const G = `${TAG_MARK}[${ATTR_YT_GLOSS}]:not([${ATTR_YT_GLOSS}=""])`;
  const glossFont = 'text-decoration:none;letter-spacing:0;pointer-events:none';
  return [
    `${MARK_IN_CAP} ${TAG_TRANSLATION}{display:none!important}`,
    `${MARK_IN_CAP},${MARK_IN_CAP}>${TAG_WORD}{display:inline!important}`,
    // above：注解字号与留白都由 --hnw-gf 推出（字号 × 1.25 行高 + 2px 间隙），触屏下限更高
    `${win('above')} ${G}{--hnw-gf:max(${em},12px);display:inline-block!important;position:relative!important;vertical-align:baseline!important;` +
      `padding-top:calc(var(--hnw-gf) * 1.25 + 3px)!important}`,
    `@media (hover:none) and (pointer:coarse){${win('above')} ${G}{--hnw-gf:max(${touchEm},12px)}}`,
    // 注解框：水平居中于单词，宽度随文字（max-content），最宽不超过“单词 + 两侧各 .45em”，超出省略
    `${win('above')} ${G}::after{content:${content};position:absolute;left:50%;top:0;transform:translateX(-50%);` +
      `box-sizing:border-box;width:max-content;max-width:calc(100% + .9em);padding:0 .25em;border-radius:3px;` +
      `display:block;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--hnw-gf);line-height:1.25;${glossFont};${look}}`,
    // below：与 above 对称，留白与注解放在生词下方
    `${win('below')} ${G}{--hnw-gf:max(${em},12px);display:inline-block!important;position:relative!important;vertical-align:baseline!important;` +
      `padding-bottom:calc(var(--hnw-gf) * 1.25 + 3px)!important}`,
    `@media (hover:none) and (pointer:coarse){${win('below')} ${G}{--hnw-gf:max(${touchEm},12px)}}`,
    `${win('below')} ${G}::after{content:${content};position:absolute;left:50%;bottom:0;transform:translateX(-50%);` +
      `box-sizing:border-box;width:max-content;max-width:calc(100% + .9em);padding:0 .25em;border-radius:3px;` +
      `display:block;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--hnw-gf);line-height:1.25;${glossFont};${look}}`,
    // after
    `${win('after')} .caption-visual-line{display:flex!important;justify-content:center!important}`,
    `${win('after')} .${CAPTION_SEGMENT_CLASS}{white-space:pre!important;flex:none!important}`,
    `${win('after')} ${G}::after{content:${content};font-size:${em};margin-left:.18em;padding:0 .2em;border-radius:3px;${glossFont};${glossLook(st, 400)}}`,
  ].join('\n');
}

/** 注入或更新字幕样式（注解样式随设置变化，内容相同时不重写） */
function ensureStyle(doc: Document, style: CaptionGlossStyle | undefined): void {
  let s = doc.getElementById(YT_STYLE_ID);
  if (!s) {
    s = doc.createElement('style');
    s.id = YT_STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(s);
  }
  const css = buildCaptionCss(style);
  if (s.textContent !== css) s.textContent = css;
}

/** 字幕注解的查词键：优先页面词形自己的词条，没有再用原形（与 engine 行内译文口径一致） */
function glossKeys(m: Element): string[] {
  const lemma = m.getAttribute(ATTR_LEMMA) ?? '';
  const surface = markSurface(m).toLowerCase().replace(/['’]s$/, '');
  return surface && surface !== lemma ? [surface, lemma] : [lemma];
}

/**
 * 字幕装饰：观察主播放器字幕容器的变化，
 * 1. 识别自动字幕提示窗口并打上 ATTR_YT_HINT（照常标注，只用于“当前字幕”取词时排除提示文字）
 * 2. 按字幕译文模式为字幕中的生词写入注解文本（所有字幕窗口一视同仁）
 * 字幕每 1–4 秒整窗重建一次，处理量只有几个词，开销可以忽略。
 */
export class CaptionDecorator {
  private observer: MutationObserver | null = null;
  private container: Element | null = null;
  private scheduled = false;
  /** 最近被 YouTube 移除的、带标注的字幕窗口或字幕行（同文重建时沿用其中的标注节点） */
  private removedCaptions: Array<{ el: HTMLElement; at: number }> = [];
  /** 短释义缓存：查词键 -> 注解（null 表示无释义） */
  private readonly glossCache = new Map<string, string | null>();

  constructor(
    private readonly ctx: SiteContext,
    /** 每次字幕变化后回调当前显示的字幕文本（不含自动字幕提示），用于没有字幕数据时的历史记录 */
    private readonly onText?: (text: string) => void,
  ) {}

  /** 绑定（或换绑）字幕容器；容器不变时不做事 */
  attach(container: Element | null): void {
    if (container === this.container) return;
    this.observer?.disconnect();
    this.container = container;
    if (!container) return;
    ensureStyle(this.ctx.doc, this.ctx.getSettings().youtube.captionStyle);
    this.observer = new MutationObserver((records) => {
      this.carryOver(records);
      this.schedule();
    });
    this.observer.observe(container, { childList: true, subtree: true, characterData: true });
    this.schedule();
  }

  /**
   * 同文重建沿用标注：YouTube 会把**同一行**字幕连同节点一起重建，新节点要等 engine 的空闲处理（最长 200ms，手机上播放时空闲更少）
   * 才重新标注，这期间字幕没有高亮和注解。两种重建：
   * - 人工字幕（pop-on）：尺寸变化、进出全屏、控件显隐等时机整窗重建同一条字幕（实测手机全屏后截图时也会触发，评审截到的“全屏字幕丢失标注”）
   * - 自动生成字幕（roll-up，桌面与 m.youtube.com 同一套播放器脚本）：窗口不重建，但每次换行上滚时把窗口内所有 caption-visual-line
   *   移除再逐词重新插入（2026-10 m.youtube.com 实测：一次 mutation 批次里移除 3 行、插入 2 行，留下来的那一行文本不变），
   *   留在屏幕上的那一行的高亮被清掉再补回，每次换行生词都闪一下（用户在手机 Edge 上反馈的“高亮单词闪烁”）。
   * 这里在 MutationObserver 回调（早于下一帧绘制）中把刚被移除的旧字幕段里 engine 生成的节点（原文本节点 + 高亮片段）
   * 整体移到文本相同的新字幕段中（整窗重建时并带上窗口的译文模式），新字幕段第一帧就有标注。
   * 移动的是 engine 自己的节点，切分记录（WeakMap）随节点保留，之后标熟词还原、重新高亮都照常工作；engine 随后扫描新字幕段时，
   * 这些节点已处理过，不会重复标注。roll-up 之后逐词追加的文本节点追加在字幕段末尾，由 engine 照常增量处理。
   */
  private carryOver(records: MutationRecord[]): void {
    const now = performance.now();
    this.removedCaptions = this.removedCaptions.filter((r) => now - r.at < CARRY_OVER_MS);
    const addedSegments: HTMLElement[] = [];
    for (const r of records) {
      // 被移除的整窗（pop-on）或整行（roll-up 换行），只留带标注的
      for (const n of r.removedNodes) {
        if (n instanceof HTMLElement && n.querySelector(TAG_MARK)) this.removedCaptions.push({ el: n, at: now });
      }
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.classList.contains(CAPTION_SEGMENT_CLASS)) addedSegments.push(n);
        else addedSegments.push(...n.querySelectorAll<HTMLElement>(`.${CAPTION_SEGMENT_CLASS}`));
      }
    }
    if (addedSegments.length === 0 || this.removedCaptions.length === 0) return;
    for (const seg of addedSegments) {
      if (!seg.isConnected || seg.querySelector(TAG_MARK)) continue;
      const text = seg.textContent;
      for (const old of this.removedCaptions) {
        const from = [...old.el.querySelectorAll<HTMLElement>(`.${CAPTION_SEGMENT_CLASS}`)].find((o) => o.textContent === text && o.querySelector(TAG_MARK));
        if (!from) continue;
        seg.replaceChildren(...from.childNodes);
        // 整窗重建（pop-on）时沿用窗口译文模式；roll-up 换行时窗口本身没有重建，模式还在
        const win = seg.closest<HTMLElement>('.caption-window');
        if (win && old.el.classList.contains('caption-window')) {
          for (const a of [ATTR_YT_GM, ATTR_FIT_FALLBACK]) {
            const v = old.el.getAttribute(a);
            if (v !== null && !win.hasAttribute(a)) win.setAttribute(a, v);
          }
        }
        break;
      }
    }
  }

  /** 设置变化：更新注解样式、重新计算各窗口的译文模式，并补写注解 */
  refresh(): void {
    if (this.container) ensureStyle(this.ctx.doc, this.ctx.getSettings().youtube.captionStyle);
    this.schedule();
  }

  /** 当前设置下字幕内译文模式（off = 只高亮） */
  private mode(): 'off' | 'above' | 'below' | 'after' {
    const s = this.ctx.getSettings();
    return this.ctx.isActive() && s.youtube.captions ? s.youtube.captionTranslation : 'off';
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.process();
    });
  }

  /** 立即处理一次（测试用；正常由 MutationObserver 驱动） */
  process(): void {
    const c = this.container;
    if (!c) return;
    const mode = this.mode();
    const texts: string[] = [];
    for (const w of c.querySelectorAll<HTMLElement>('.caption-window')) {
      const text = w.textContent ?? '';
      const hint = isAutoCaptionHint(text);
      if (hint !== w.hasAttribute(ATTR_YT_HINT)) w.toggleAttribute(ATTR_YT_HINT, hint);
      if (!hint) texts.push(text);
      // 所有字幕窗口（含自动生成字幕、提示窗口）都按设置显示字幕内译文；after 已因放不下改成 above 的窗口保持 above（窗口每条字幕重建，不会一直沿用）。
      // 自动生成字幕（roll-up）窗口的 above/below 改用 after：播放器每追加一个词就重写一次窗口高度，时而按它自己的固定行高、时而按实测内容高度，
      // 注解把行撑高后两者不一致，整窗上下跳动（全屏最明显，2026-10 m.youtube.com 实测）；after 不改行高，没有这个问题
      const rollup = w.classList.contains(ROLLUP_CLASS);
      const want = mode === 'off' ? null : rollup ? 'after' : mode;
      const cur = w.getAttribute(ATTR_YT_GM);
      if (want === null) {
        if (cur !== null) w.removeAttribute(ATTR_YT_GM);
      } else if (cur !== want && !(want === 'after' && cur === 'above' && w.hasAttribute(ATTR_FIT_FALLBACK))) {
        w.setAttribute(ATTR_YT_GM, want);
      }
    }
    this.onText?.(texts.join(' '));
    if (mode === 'off') return;
    const marks = [...c.querySelectorAll<HTMLElement>(`.caption-window[${ATTR_YT_GM}] ${TAG_MARK}:not([${ATTR_YT_GLOSS}])`)];
    if (marks.length > 0) void this.fillGloss(marks);
  }

  /**
   * after 模式的放不下检查：字幕段超出播放器左右边界（被裁切）时，该窗口改用 above。
   * 只在写入注解后检查一次（读布局，放在 rAF 中与 YouTube 的样式写入错开）。
   */
  private checkFit(windows: Set<HTMLElement>): void {
    const player = this.container?.parentElement;
    if (!player) return;
    requestAnimationFrame(() => {
      const pr = player.getBoundingClientRect();
      for (const w of windows) {
        // roll-up 窗口不退回 above（会重新引起整窗跳动，见 process），超宽时由窗口自身的 overflow:hidden 裁切两侧
        if (!w.isConnected || w.getAttribute(ATTR_YT_GM) !== 'after' || w.classList.contains(ROLLUP_CLASS)) continue;
        const overflow = [...w.querySelectorAll(`.${CAPTION_SEGMENT_CLASS}`)].some((seg) => {
          const r = seg.getBoundingClientRect();
          return r.left < pr.left + 2 || r.right > pr.right - 2;
        });
        if (overflow) {
          w.setAttribute(ATTR_FIT_FALLBACK, '');
          w.setAttribute(ATTR_YT_GM, 'above');
        }
      }
    });
  }

  private async fillGloss(marks: HTMLElement[]): Promise<void> {
    const missing = new Set<string>();
    for (const m of marks) for (const k of glossKeys(m)) if (!this.glossCache.has(k)) missing.add(k);
    if (missing.size > 0) {
      const found = await this.ctx.lookupMany(missing);
      for (const k of missing) {
        const short = found.get(k)?.short;
        this.glossCache.set(k, short ? shortenTranslation(short, 6) || null : null);
      }
    }
    for (const m of marks) {
      if (!m.isConnected) continue;
      const gloss = glossKeys(m).map((k) => this.glossCache.get(k)).find((g) => !!g);
      // 无释义也写空值，避免下一次变化时重复查询
      m.setAttribute(ATTR_YT_GLOSS, gloss ?? '');
    }
    const afterWindows = new Set(marks.map((m) => m.closest<HTMLElement>(`.caption-window[${ATTR_YT_GM}="after"]`)).filter((w): w is HTMLElement => !!w));
    if (afterWindows.size > 0) this.checkFit(afterWindows);
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.removedCaptions = [];
    this.container?.querySelectorAll(`[${ATTR_YT_GM}]`).forEach((w) => w.removeAttribute(ATTR_YT_GM));
    this.container = null;
    this.ctx.doc.getElementById(YT_STYLE_ID)?.remove();
  }
}
