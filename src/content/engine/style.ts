import type { MarkStyle, Settings } from '@/core/settings/schema';
import { isTextOnlyStyle, markStyleParts, resolveMarkStyle, resolveTranslationStyle } from '@/core/theme/resolve';
import { DARK_PAGE_BG, LIGHT_PAGE_BG, ensureContrast, isOpaque, parseColor } from './color';
import {
  ATTR_BOOK,
  ATTR_CODE,
  ATTR_IN_LINK,
  ATTR_LOW_CONFIDENCE,
  ATTR_ON_DARK,
  ATTR_REVEALED,
  ATTR_TIGHT,
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
/** 按 <html data-hnw-tr> 模式限定的选择器前缀（options 预览会把 `html[data-hnw-tr=` 替换为容器属性选择器，务必保持此写法） */
const mode = (m: string) => `html[${ATTR_TR_MODE}="${m}"]`;
/** 深色上下文中半透明背景的最大不透明度：亮色文字压在高饱和底色上会发灰，限制后对比度 ≥ 4.5 */
const DARK_BG_MAX_ALPHA = 0.32;

/**
 * 生成注入页面的高亮样式（mark 与行内释义在页面文档流中，无法放进 Shadow DOM）。
 * 选择器都基于自定义标签名，页面自身样式基本无法命中。
 *
 * 设计要点：
 * - 生词样式（装饰线/文字/背景/边框，见 core/theme）只作用于 hnw-w，行内译文 hnw-tr 不会被染上背景/下划线
 * - 生词样式不占布局空间：不加 padding/border（边框用 outline，胶囊留白用 box-shadow），不改字号、行高
 * - 深色上下文（mark 带 data-hnw-dark）：文字色/线色提亮到可读，半透明背景降低不透明度；实心背景主题自带前景色，不调整
 * - 链接内（data-hnw-link）：只改文字色的样式会和链接色混淆，改为保留链接色 + 主题色浅底
 * - 行内译文与生词样式相互独立：词后括注 / 词上 ruby / 仅悬停浮层；受限容器、代码中退化为不占位的浮层；
 *   低置信度（大写的专有名词/界面标签）不显示行内译文；模糊自测时译文模糊、点按后清晰
 * - 悬停（仅有鼠标的设备）叠加一层随文字色变化的淡底色；卡片激活态（data-hnw-active）样式由 card 分片负责
 */
export function buildPageCss(settings: Settings): string {
  const rules: string[] = [];
  rules.push(
    `${M}{display:inline;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}`,
    `${W}{display:inline;font:inherit;border-radius:.22em;box-decoration-break:clone;-webkit-box-decoration-break:clone;transition:background-color .15s ease}`,
  );
  // 全局主题：:where 降低特异性，保证按词书的规则总能覆盖
  rules.push(...styleRules(`${M}`, (a) => `${M}:where([${a}])`, resolveMarkStyle(settings)));
  for (const bookId of settings.books.enabled) {
    const sel = `${M}[${ATTR_BOOK}="${cssEscape(bookId)}"]`;
    rules.push(...styleRules(sel, (a) => `${sel}:where([${a}])`, resolveMarkStyle(settings, bookId)));
  }
  rules.push(...translationRules(settings));
  return rules.join('\n');
}

/**
 * 一种 MarkStyle 的规则：常规、悬停、深色上下文、链接内。
 * @param attrSel 生成“带某属性的同一选择器”（用 :where 不增加特异性）
 */
function styleRules(sel: string, attrSel: (attr: string) => string, style: MarkStyle): string[] {
  const { decls, bgImage } = markStyleParts(style);
  const out = [`${sel}>${W}{${decls.join(';')}${bgImage ? `;background-image:${bgImage}` : ''}}`];
  // 悬停：在主题背景之上叠一层文字色的淡色；马克笔色带也是 background-image，需要一起写出
  const tint = 'linear-gradient(color-mix(in srgb,currentColor 16%,transparent),color-mix(in srgb,currentColor 16%,transparent))';
  out.push(`@media (hover:hover){${sel}:hover>${W}{background-image:${tint}${bgImage ? `,${bgImage}` : ''}}}`);

  const darkSel = attrSel(ATTR_ON_DARK);
  if (!isOpaque(style.background)) {
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
    if (style.border && style.border !== 'none' && style.borderColor) {
      const d = ensureContrast(style.borderColor, DARK_PAGE_BG, 3);
      if (d) dark.push(`outline-color:${d}`);
    }
    // 半透明背景在深色页上压暗：浅色文字压在高不透明度的亮色底上对比度不足
    const bg = dimmedBackground(style);
    if (bg) {
      if ((style.backgroundKind ?? 'block') === 'marker') {
        dark.push(`background-image:${markStyleParts({ ...style, background: bg, backgroundOpacity: 1 }).bgImage}`);
      } else {
        dark.push(`background-color:${bg}`);
        if (style.backgroundKind === 'pill') dark.push(`box-shadow:0 0 0 .16em ${bg}`);
      }
    }
    if (light.length > 0) out.push(`${sel}:not([${ATTR_ON_DARK}])>${W}{${light.join(';')}}`);
    if (dark.length > 0) out.push(`${darkSel}>${W}{${dark.join(';')}}`);
  }
  if (isTextOnlyStyle(style)) {
    // 链接内：保留站点链接色（链接身份不丢），用主题色浅底表示生词，避免“彩色字像链接”的混淆
    const tintBg = `color-mix(in srgb,${style.color} 18%,transparent)`;
    out.push(`${attrSel(ATTR_IN_LINK)}>${W}{color:inherit;background-color:${tintBg}}`);
  }
  return out;
}

/** 深色上下文下的半透明背景色：不透明度超过上限时按比例压低；无需调整返回 null */
function dimmedBackground(style: MarkStyle): string | null {
  if (!style.background) return null;
  const c = parseColor(style.background);
  if (!c) return null;
  const alpha = c.a * (style.backgroundOpacity ?? 1);
  if (alpha <= DARK_BG_MAX_ALPHA) return null;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${DARK_BG_MAX_ALPHA})`;
}

/** 行内译文的规则（全部基于 html[data-hnw-tr] 模式 + mark 上的上下文标记） */
function translationRules(settings: Settings): string[] {
  const t = resolveTranslationStyle(settings);
  const color = t.color ? `color:${t.color};` : '';
  const out: string[] = [];
  // 默认隐藏；文字来自属性（::before），不进入页面文本，复制/查找/页面脚本都读不到
  out.push(
    `${TR}{display:none;font-style:normal;font-weight:400;text-decoration:none;letter-spacing:normal;text-transform:none;text-indent:0;` +
      `user-select:none;-webkit-user-select:none;pointer-events:none;background:none}`,
    `${TR}::before{content:attr(${ATTR_TR_TEXT})}`,
  );
  // 词后括注：弱化（继承正文色 + 透明度），inline-block 保证释义整体不被断行、不继承链接下划线
  // mark 不换行：词与括注始终在同一行（否则括注会单独掉到下一行，mark 的包围盒变成两行高）
  out.push(
    `${mode('after')} ${M}{white-space:nowrap}`,
    `${mode('after')} ${TR}{display:inline-block;margin-inline-start:.1em;font-size:${t.fontScale}em;line-height:1;opacity:${t.opacity};${color}white-space:nowrap;vertical-align:baseline}`,
    `${mode('after')} ${TR}::before{content:"(" attr(${ATTR_TR_TEXT}) ")"}`,
  );
  // 词上注音：原生 CSS ruby（Chromium 121+ display:ruby），注解居中不拉伸字距；
  // 行内有注解时浏览器只在需要处增加行高，注解永远不会与上一行文字重叠。
  // 预留行高：engine 在创建 mark 的同一帧插入无释义的占位注解（没有 data-tr 属性，显示一个不换行空格），
  // 这一行的行高一次到位，之后释义到达时只换文字、行高不再跳变
  out.push(
    `${mode('ruby')} ${M}{display:ruby}`,
    `${mode('ruby')} ${W}{display:ruby-base}`,
    `${mode('ruby')} ${TR}{display:ruby-text;ruby-align:center;text-align:center;font-size:max(${t.fontScale}em,10px);line-height:1.2;opacity:${t.opacity};${color}white-space:nowrap}`,
    `${mode('ruby')} ${TR}:not([${ATTR_TR_TEXT}])::before{content:"\\a0"}`,
  );
  // 不占位的浮层：仅悬停模式、受限容器、代码中的浮动标注共用。绝对定位在单词上方，不参与布局
  const float =
    `display:block;position:absolute;left:50%;bottom:100%;transform:translate(-50%,-3px);z-index:2147483000;` +
    `padding:1px 6px;border-radius:6px;background:#1f2328;color:#f6f8fa;opacity:1;font-size:max(.75em,11px);line-height:1.45;` +
    `white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)`;
  const hoverable = `${M}:hover>${TR}`;
  out.push(
    `${mode('hover')} ${M},${mode('after')} ${M}[${ATTR_TIGHT}],${mode('ruby')} ${M}[${ATTR_TIGHT}],${M}[${ATTR_CODE}]{position:relative}`,
    // 受限容器中的 ruby 退回普通行内，避免撑高单行
    `${mode('ruby')} ${M}[${ATTR_TIGHT}],${mode('ruby')} ${M}[${ATTR_CODE}]{display:inline}`,
    `${mode('ruby')} ${M}[${ATTR_TIGHT}]>${W},${mode('ruby')} ${M}[${ATTR_CODE}]>${W}{display:inline}`,
    `${mode('after')} ${M}[${ATTR_TIGHT}]>${TR},${mode('ruby')} ${M}[${ATTR_TIGHT}]>${TR},${mode('hover')} ${TR}{display:none}`,
    `@media (hover:hover){${mode('hover')} ${hoverable},${mode('after')} ${M}[${ATTR_TIGHT}]:hover>${TR},${mode('ruby')} ${M}[${ATTR_TIGHT}]:hover>${TR}{${float}}}`,
    `${mode('after')} ${M}[${ATTR_TIGHT}]>${TR}::before,${mode('ruby')} ${M}[${ATTR_TIGHT}]>${TR}::before,${mode('hover')} ${TR}::before{content:attr(${ATTR_TR_TEXT})}`,
  );
  // 代码：永远不显示占位译文；浮动小标注模式下常显（不占位，复制代码不会带出）
  out.push(`${M}[${ATTR_CODE}]>${TR}{display:none!important}`);
  if (settings.code?.enabled && settings.code.display === 'float') {
    out.push(
      `${M}[${ATTR_CODE}]>${TR}{${float.replace('display:block', 'display:block!important')};font-size:10px;line-height:1.3;padding:0 4px;opacity:.88;font-family:system-ui,sans-serif}`,
      `${M}[${ATTR_CODE}]>${TR}::before{content:attr(${ATTR_TR_TEXT})}`,
    );
  }
  // 低置信度（专有名词/界面标签）：不显示占位译文，悬停模式仍可看
  out.push(`${mode('after')} ${M}[${ATTR_LOW_CONFIDENCE}]>${TR},${mode('ruby')} ${M}[${ATTR_LOW_CONFIDENCE}]>${TR}{display:none}`);
  // 模糊自测：译文模糊且可点按（engine 拦截点按，切换 data-hnw-revealed，不触发卡片/链接）
  if (t.blur) {
    const quiz = [mode('after'), mode('ruby')].map((p) => `${p} ${M}:not([${ATTR_TIGHT}]):not([${ATTR_CODE}])>${TR}:not([${ATTR_REVEALED}])`).join(',');
    out.push(`${quiz}{filter:blur(.28em);pointer-events:auto;cursor:pointer;transition:filter .15s ease}`);
    const revealed = [mode('after'), mode('ruby')].map((p) => `${p} ${TR}[${ATTR_REVEALED}]`).join(',');
    out.push(`${revealed}{pointer-events:auto;cursor:pointer}`);
  }
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
