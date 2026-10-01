import { TAG_MARK, TAG_TRANSLATION, TAG_WORD, ATTR_LEMMA } from '../../engine/dom';
import { shortenTranslation } from '../../engine/engine';
import { markSurface } from '../../engine/highlighter';
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

/** 窗口标记：after 放不下已退回 above */
const ATTR_FIT_FALLBACK = 'data-hnw-yt-fit';
const CAP = `#${PLAYER_ID}>.${CAPTION_CONTAINER_CLASS}`;
const MARK_IN_CAP = `${CAP} ${TAG_MARK}`;
/** 注解颜色：字幕底色固定为近黑半透明，用暖黄与白字区分（≥ 7:1） */
const GLOSS_COLOR = '#ffe08a';

/**
 * 字幕专用样式（注入一次，与 engine 的页面样式相互独立）：
 * - 字幕内一律不显示 engine 的行内译文（hnw-tr），mark 强制回到普通行内，保持 YouTube 的折行结果；
 *   字幕内译文由本模块按窗口模式（ATTR_YT_GM）用 mark::after 渲染，文本放在属性里，不进入 textContent
 * - 自动字幕提示窗口里若已有标注（engine 先于我们处理的极端时序），去掉高亮外观
 * - above：有注解的生词改为 inline-block 并加 padding-top（= 注解高度），注解绝对定位在这段留白里（宽度限制在单词附近，过长省略）。
 *   留白跟着单词所在的那一行走：字幕段折成两行时，第二行的生词只撑高第二行，注解不会压到第一行文字上（逐行定位）；
 *   单词本身是不可拆分的，inline-block 不改变折行位置。字幕窗贴底定位，只会向上长高：不改变宽度、不折行、不裁切。
 *   注解字号随字幕字号（em）缩放，全屏时字幕变大注解也变大；下限桌面 10px、触屏 12px（手机字幕本身只有约 15px）。
 *   注解加深色描边：留白区域在字幕段背景内，但用户把字幕背景调成透明时仍要看得清
 * - after：词后小字（0.62em）。字幕段改为不折行（white-space:pre），字幕行改为居中的 flex，超出 YouTube 测量的窗口宽度时
 *   向两侧对称溢出（仍居中，背景随字幕段延伸）；超出播放器宽度的窗口由脚本改回 above
 * - 自动生成字幕（roll-up）窗口高度固定、逐词追加，不设置模式（只高亮）
 */
export function buildCaptionCss(): string {
  const win = (mode: string) => `${CAP} .caption-window[${ATTR_YT_GM}="${mode}"]`;
  // 无释义的词写的是空注解，不占位
  const G = `${TAG_MARK}[${ATTR_YT_GLOSS}]:not([${ATTR_YT_GLOSS}=""])`;
  const glossFont = 'font-weight:400;font-style:normal;text-decoration:none;letter-spacing:0;text-shadow:none;pointer-events:none';
  return [
    `${MARK_IN_CAP} ${TAG_TRANSLATION}{display:none!important}`,
    `${MARK_IN_CAP},${MARK_IN_CAP}>${TAG_WORD}{display:inline!important}`,
    `${CAP} [${ATTR_YT_HINT}] ${TAG_WORD}{background:none!important;color:inherit!important;text-decoration:none!important;border:0!important;box-shadow:none!important;font-weight:inherit!important}`,
    // above：注解字号与留白都由 --hnw-gf 推出（字号 × 1.25 行高 + 2px 间隙），触屏下限更高
    `${win('above')} ${G}{--hnw-gf:max(.56em,10px);display:inline-block!important;position:relative!important;vertical-align:baseline!important;` +
      `padding-top:calc(var(--hnw-gf) * 1.25 + 2px)!important}`,
    `@media (hover:none) and (pointer:coarse){${win('above')} ${G}{--hnw-gf:max(.62em,12px)}}`,
    `${win('above')} ${G}::after{content:attr(${ATTR_YT_GLOSS});position:absolute;left:-.45em;right:-.45em;top:0;` +
      `display:block;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:var(--hnw-gf);line-height:1.25;color:${GLOSS_COLOR};${glossFont};` +
      `text-shadow:0 0 2px #000,0 0 3px rgba(0,0,0,.8)}`,
    // after
    `${win('after')} .caption-visual-line{display:flex!important;justify-content:center!important}`,
    `${win('after')} .${CAPTION_SEGMENT_CLASS}{white-space:pre!important;flex:none!important}`,
    `${win('after')} ${G}::after{content:attr(${ATTR_YT_GLOSS});font-size:.62em;margin-left:.18em;color:${GLOSS_COLOR};${glossFont}}`,
  ].join('\n');
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(YT_STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = YT_STYLE_ID;
  s.textContent = buildCaptionCss();
  (doc.head ?? doc.documentElement).appendChild(s);
}

/** 字幕注解的查词键：优先页面词形自己的词条，没有再用原形（与 engine 行内译文口径一致） */
function glossKeys(m: Element): string[] {
  const lemma = m.getAttribute(ATTR_LEMMA) ?? '';
  const surface = markSurface(m).toLowerCase().replace(/['’]s$/, '');
  return surface && surface !== lemma ? [surface, lemma] : [lemma];
}

/**
 * 字幕装饰：观察主播放器字幕容器的变化，
 * 1. 识别自动字幕提示窗口并打上 ATTR_YT_HINT（engine 的跳过规则据此不标注；MutationObserver 回调早于 engine 的空闲处理）
 * 2. above 模式下为字幕中的生词写入上方注解文本（自动生成字幕除外）
 * 字幕每 1–4 秒整窗重建一次，处理量只有几个词，开销可以忽略。
 */
export class CaptionDecorator {
  private observer: MutationObserver | null = null;
  private container: Element | null = null;
  private scheduled = false;
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
    ensureStyle(this.ctx.doc);
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(container, { childList: true, subtree: true, characterData: true });
    this.schedule();
  }

  /** 设置变化：重新计算各窗口的译文模式，并补写注解 */
  refresh(): void {
    this.schedule();
  }

  /** 当前设置下字幕内译文模式（off = 只高亮） */
  private mode(): 'off' | 'above' | 'after' {
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
      // 窗口模式：自动生成字幕、提示窗口只高亮；after 已因放不下改成 above 的窗口保持 above（窗口每条字幕重建，不会一直沿用）
      const want = mode === 'off' || hint || w.classList.contains(ROLLUP_CLASS) ? null : mode;
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
        if (!w.isConnected || w.getAttribute(ATTR_YT_GM) !== 'after') continue;
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
    this.container?.querySelectorAll(`[${ATTR_YT_GM}]`).forEach((w) => w.removeAttribute(ATTR_YT_GM));
    this.container = null;
    this.ctx.doc.getElementById(YT_STYLE_ID)?.remove();
  }
}
