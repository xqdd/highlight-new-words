/**
 * 内容脚本注入到页面 DOM 中的自定义元素与属性约定（engine / card / 样式共同遵守）。
 * 使用自定义标签名而非 span+class：页面样式（如 `span {…}`）不会误伤，且易于识别“自己的节点”。
 */
export const TAG_MARK = 'hnw-mark';
/**
 * mark 内包裹原单词的元素：高亮样式（颜色/背景/下划线）只作用于它，
 * 行内释义（hnw-tr）作为其兄弟节点，不会被染上高亮背景/下划线。
 */
export const TAG_WORD = 'hnw-w';
export const TAG_TRANSLATION = 'hnw-tr';
export const TAG_CARD_HOST = 'hnw-card-host';
export const STYLE_ELEMENT_ID = 'hnw-style';

/** hnw-mark 上的属性 */
export const ATTR_LEMMA = 'data-lemma';
/** 决定样式的主词书 id */
export const ATTR_BOOK = 'data-book';
/** 命中的全部词书 id，空格分隔 */
export const ATTR_BOOKS = 'data-books';
/** <html> 上的行内翻译模式属性：off | after | ruby */
export const ATTR_TR_MODE = 'data-hnw-tr';
/**
 * hnw-tr 上的释义文本属性。释义通过 CSS `::before{content:attr(data-tr)}` 渲染，不进入 DOM 文本：
 * 不污染复制/查找/页面脚本读取的 textContent，也不会被页面框架当成自己的文本节点。
 */
export const ATTR_TR_TEXT = 'data-tr';
/** hnw-mark 上的标记：所在上下文为深色背景（按父元素文字颜色亮度判断），样式据此换用提亮后的颜色 */
export const ATTR_ON_DARK = 'data-hnw-dark';
/** hnw-mark 上的标记：卡片当前锚定的单词（激活态，由 card 分片设置并提供样式） */
export const ATTR_ACTIVE = 'data-hnw-active';

/** 整个子树都跳过的元素 */
export const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'SVG',
  'MATH',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'HEAD',
  'TITLE',
  TAG_MARK.toUpperCase(),
  TAG_WORD.toUpperCase(),
  TAG_TRANSLATION.toUpperCase(),
  TAG_CARD_HOST.toUpperCase(),
]);

/**
 * DOM 结构：`<hnw-mark data-lemma data-book data-books [data-hnw-dark]><hnw-w>原词</hnw-w><hnw-tr data-tr="译"></hnw-tr></hnw-mark>`
 * （hnw-tr 仅在开启行内翻译且有释义时存在）。
 */

/**
 * 元素（及其子树）是否应跳过：黑名单标签、可编辑区域。
 * 注意不要按 translate="no" 跳过：不少站点在 <html> 上声明它来禁用浏览器翻译。
 */
export function shouldSkipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
  return false;
}

/** 节点是否位于我们自己注入的元素内部（mark / 翻译 / 卡片宿主） */
export function isInsideOwnNode(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !!el?.closest(`${TAG_MARK},${TAG_CARD_HOST}`);
}
