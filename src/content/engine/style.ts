import type { MarkStyle, Settings } from '@/core/settings/schema';
import { markStyleToCss, resolveMarkStyle } from '@/core/theme/resolve';
import { DARK_PAGE_BG, LIGHT_PAGE_BG, ensureContrast, isOpaque } from './color';
import {
  ATTR_BOOK,
  ATTR_ON_DARK,
  ATTR_TR_MODE,
  ATTR_TR_TEXT,
  STYLE_ELEMENT_ID,
  TAG_MARK,
  TAG_TRANSLATION,
  TAG_WORD,
} from './dom';

const M = TAG_MARK;
const W = TAG_WORD;
const TR = TAG_TRANSLATION;

/**
 * 生成注入页面的高亮样式（mark 与行内释义在页面文档流中，无法放进 Shadow DOM）。
 * 选择器都基于自定义标签名，页面自身样式基本无法命中。
 *
 * 设计要点：
 * - 主题样式只作用于 hnw-w（单词本身），释义 hnw-tr 不会被染上背景/下划线，颜色跟随页面正文并弱化
 * - 不改字号、行高、字重（font:inherit），不加 padding，不影响页面排版与断行
 * - 只设置文字色的主题，在深色上下文（mark 带 data-hnw-dark）自动提亮、在浅色页面对比度过低时压暗，
 *   保证亮/暗页面都清晰；实心背景主题自带前景色，不做调整
 * - 悬停（仅有鼠标的设备）叠加一层随文字色变化的淡底色；卡片激活态（data-hnw-active）样式由 card 分片负责
 */
export function buildPageCss(settings: Settings): string {
  const rules: string[] = [];
  rules.push(
    `${M}{display:inline;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}`,
    `${W}{display:inline;font:inherit;border-radius:.22em;box-decoration-break:clone;-webkit-box-decoration-break:clone;transition:background-color .15s ease}`,
  );
  // 全局主题：:where 降低特异性，保证按词书的规则总能覆盖
  rules.push(...styleRules(`${M}`, `${M}:where([${ATTR_ON_DARK}])`, resolveMarkStyle(settings)));
  for (const bookId of settings.books.enabled) {
    const sel = `${M}[${ATTR_BOOK}="${cssEscape(bookId)}"]`;
    rules.push(...styleRules(sel, `${sel}:where([${ATTR_ON_DARK}])`, resolveMarkStyle(settings, bookId)));
  }
  // 悬停：在主题背景之上叠一层文字色的淡色（background-image 不覆盖主题 background-color）
  const tint = 'background-image:linear-gradient(color-mix(in srgb,currentColor 16%,transparent),color-mix(in srgb,currentColor 16%,transparent))';
  rules.push(`@media (hover:hover){${M}:hover>${W}{${tint}}}`);

  // 行内释义：默认隐藏，按 <html data-hnw-tr> 模式展示；文字来自属性，不进入页面文本
  rules.push(
    `${TR}{display:none;font-style:normal;font-weight:400;text-decoration:none;letter-spacing:normal;text-transform:none;text-indent:0;` +
      `user-select:none;-webkit-user-select:none;pointer-events:none;background:none}`,
    `${TR}::before{content:attr(${ATTR_TR_TEXT})}`,
  );
  // 词后括注：灰度弱化（继承页面正文色 + 透明度），inline-block 保证释义整体不被断行、不继承链接下划线
  rules.push(
    `html[${ATTR_TR_MODE}="after"] ${TR}{display:inline-block;margin-inline-start:.1em;font-size:.88em;line-height:1;opacity:.58;white-space:nowrap;vertical-align:baseline}`,
    `html[${ATTR_TR_MODE}="after"] ${TR}::before{content:"(" attr(${ATTR_TR_TEXT}) ")"}`,
  );
  // 词上注音：原生 CSS ruby（Chromium 121+ display:ruby），注解居中不拉伸字距；
  // 行内有注解时浏览器只在需要处增加行高，注解永远不会与上一行文字重叠
  rules.push(
    `html[${ATTR_TR_MODE}="ruby"] ${M}{display:ruby}`,
    `html[${ATTR_TR_MODE}="ruby"] ${W}{display:ruby-base}`,
    `html[${ATTR_TR_MODE}="ruby"] ${TR}{display:ruby-text;ruby-align:center;text-align:center;font-size:max(.55em,10px);line-height:1.2;opacity:.7;white-space:nowrap}`,
  );
  return rules.join('\n');
}

/**
 * 一种 MarkStyle 的规则：常规 + 深色上下文。
 * 只有“文字色/下划线色 + 非实心背景”的样式需要按页面明暗调整对比度。
 */
function styleRules(sel: string, darkSel: string, style: MarkStyle): string[] {
  const out = [`${sel}>${W}{${markStyleToCss(style)}}`];
  if (isOpaque(style.background)) return out;
  const light: string[] = [];
  const dark: string[] = [];
  if (style.color) {
    // 浅色页面只修正明显过浅的颜色（目标 3:1，尽量尊重用户所选颜色）；深色上下文按正文标准 4.5:1 提亮
    const l = ensureContrast(style.color, LIGHT_PAGE_BG, 3);
    if (l) light.push(`color:${l}`);
    const d = ensureContrast(style.color, DARK_PAGE_BG, 4.5);
    if (d) dark.push(`color:${d}`);
  }
  if (style.underline !== 'none' && style.underlineColor) {
    const d = ensureContrast(style.underlineColor, DARK_PAGE_BG, 3);
    if (d) dark.push(`text-decoration-color:${d}`);
  }
  if (light.length > 0) out.push(`${sel}:not([${ATTR_ON_DARK}])>${W}{${light.join(';')}}`);
  if (dark.length > 0) out.push(`${darkSel}>${W}{${dark.join(';')}}`);
  return out;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** 注入或更新页面样式元素；挂在 documentElement 下，避免 SPA 替换 head 时丢失 */
export function applyPageStyle(doc: Document, settings: Settings): void {
  let el = doc.getElementById(STYLE_ELEMENT_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    doc.documentElement.appendChild(el);
  }
  const css = buildPageCss(settings);
  if (el.textContent !== css) el.textContent = css;
  doc.documentElement.setAttribute(ATTR_TR_MODE, settings.inlineTranslation.mode);
}

export function removePageStyle(doc: Document): void {
  doc.getElementById(STYLE_ELEMENT_ID)?.remove();
  doc.documentElement.removeAttribute(ATTR_TR_MODE);
}
