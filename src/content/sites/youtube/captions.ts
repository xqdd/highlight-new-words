import { TAG_MARK, TAG_TRANSLATION, TAG_WORD, ATTR_LEMMA } from '../../engine/dom';
import { shortenTranslation } from '../../engine/engine';
import { markSurface } from '../../engine/highlighter';
import type { SiteContext } from '../types';
import {
  ATTR_YT_GLOSS,
  ATTR_YT_HINT,
  ATTR_YT_TR,
  CAPTION_CONTAINER_CLASS,
  CAPTION_SEGMENT_CLASS,
  PLAYER_ID,
  ROLLUP_CLASS,
  YT_STYLE_ID,
  isAutoCaptionHint,
} from './dom';

const CAP = `#${PLAYER_ID}>.${CAPTION_CONTAINER_CLASS}`;
const MARK_IN_CAP = `${CAP} ${TAG_MARK}`;

/**
 * 字幕专用样式（注入一次，与 engine 的页面样式相互独立）：
 * - 字幕内一律不显示 engine 的行内译文（词后括注会撑破 YouTube 按像素计算的字幕宽度；ruby 会撑高 roll-up 固定高度的窗口），
 *   mark 也强制回到普通行内，保持 YouTube 的折行结果
 * - 自动字幕提示窗口里若已有标注（engine 先于我们处理的极端时序），去掉高亮外观
 * - above 模式：单词上方注解用 mark::after 绝对定位，宽度限制在单词宽度附近（不与相邻注解重叠，过长省略），
 *   所在字幕段加 padding-top 留出注解高度：字幕窗贴底定位，只会向上长高，不改变宽度、不折行、不裁切；
 *   roll-up（自动生成字幕）窗口高度固定，不加注解
 */
export function buildCaptionCss(): string {
  const gloss = `html[${ATTR_YT_TR}="above"] ${CAP} .caption-window:not(.${ROLLUP_CLASS})`;
  // 无释义的词写的是空注解，不占位
  const G = `${TAG_MARK}[${ATTR_YT_GLOSS}]:not([${ATTR_YT_GLOSS}=""])`;
  return [
    `${MARK_IN_CAP} ${TAG_TRANSLATION}{display:none!important}`,
    `${MARK_IN_CAP},${MARK_IN_CAP}>${TAG_WORD}{display:inline!important}`,
    `${CAP} [${ATTR_YT_HINT}] ${TAG_WORD}{background:none!important;color:inherit!important;text-decoration:none!important;border:0!important;box-shadow:none!important;font-weight:inherit!important}`,
    `${gloss} .${CAPTION_SEGMENT_CLASS}:has(${G}){padding-top:calc(max(.56em,10px) * 1.25 + 2px)!important}`,
    `${gloss} ${G}{position:relative!important}`,
    `${gloss} ${G}::after{content:attr(${ATTR_YT_GLOSS});position:absolute;left:-.35em;right:-.35em;bottom:100%;margin-bottom:1px;` +
      `display:block;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:max(.56em,10px);line-height:1.25;` +
      `font-weight:400;font-style:normal;text-decoration:none;letter-spacing:0;color:#ffe08a;pointer-events:none}`,
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

  constructor(private readonly ctx: SiteContext) {}

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

  /** 设置变化：同步 <html> 上的注解模式，并补写注解 */
  refresh(): void {
    this.syncMode();
    this.schedule();
  }

  private syncMode(): void {
    const s = this.ctx.getSettings();
    const on = this.ctx.isActive() && s.youtube.captions && s.youtube.captionTranslation === 'above';
    const root = this.ctx.doc.documentElement;
    if (on) root.setAttribute(ATTR_YT_TR, 'above');
    else root.removeAttribute(ATTR_YT_TR);
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
    for (const w of c.querySelectorAll('.caption-window')) {
      const hint = isAutoCaptionHint(w.textContent ?? '');
      if (hint !== w.hasAttribute(ATTR_YT_HINT)) w.toggleAttribute(ATTR_YT_HINT, hint);
    }
    this.syncMode();
    if (this.ctx.doc.documentElement.getAttribute(ATTR_YT_TR) !== 'above') return;
    const marks = [...c.querySelectorAll<HTMLElement>(`.caption-window:not(.${ROLLUP_CLASS}):not([${ATTR_YT_HINT}]) ${TAG_MARK}:not([${ATTR_YT_GLOSS}])`)];
    if (marks.length > 0) void this.fillGloss(marks);
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
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.container = null;
    this.ctx.doc.documentElement.removeAttribute(ATTR_YT_TR);
    this.ctx.doc.getElementById(YT_STYLE_ID)?.remove();
  }
}
