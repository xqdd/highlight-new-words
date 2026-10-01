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
/** hnw-mark 上的标记：位于链接内（文字色类样式改为“保留链接色 + 同色浅底”，避免与链接色混淆） */
export const ATTR_IN_LINK = 'data-hnw-link';
/**
 * hnw-mark 上的标记：位于受限容器（单行 nowrap / ellipsis / line-clamp / overflow:hidden 的单行盒 / 按钮类控件）。
 * 行内译文在这里退化为不占位的悬停浮层，不撑破容器、不改变布局。
 */
export const ATTR_TIGHT = 'data-hnw-tight';
/** hnw-mark 上的标记：位于代码（pre/code/语法高亮容器）中，永远不插入占位译文 */
export const ATTR_CODE = 'data-hnw-code';
/**
 * hnw-mark 上的标记：低置信度（首字母大写却不在句首，或单独成段的大写词，多为专有名词/界面标签，如导航里的 “Premium”）。
 * 仍然高亮，但不显示行内译文（卡片照常可看完整释义）。
 */
export const ATTR_LOW_CONFIDENCE = 'data-hnw-lowconf';
/**
 * hnw-mark 上的标记：行内译文密度控制省略了这个词的括注（同段重复出现的词条、窄屏上每段超出密度上限的较常见词）。
 * 仍然高亮，悬停/卡片照常可看释义。
 */
export const ATTR_NO_GLOSS = 'data-hnw-nogloss';
/**
 * hnw-mark 上的标记：代码“浮动小标注”的摆放（engine 按实际排版计算，见 planCodeFloats）。
 * 缺省=单词上方；below=单词下方（代码块首行上方会被滚动容器裁掉、或与同一行左侧标注重叠时）；none=上下都放不下，只在悬停时显示。
 */
export const ATTR_CODE_FLOAT = 'data-hnw-float';
/** hnw-tr 上的标记：模糊自测模式下已点开 */
export const ATTR_REVEALED = 'data-hnw-revealed';
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
export function shouldSkipElement(el: Element, opts?: ScanOptions): boolean {
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) {
    // 代码开关打开时放行 pre/code（编辑器仍在下面跳过）
    if (!(opts?.codeEnabled && CODE_TAGS.has(tag))) return true;
  }
  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
  const cls = el.classList;
  if (cls && cls.length > 0) {
    // 在线代码编辑器（虚拟渲染的行，不是 contenteditable，但改动其 DOM 会破坏编辑器）始终跳过
    for (const c of EDITOR_CLASSES) if (cls.contains(c)) return true;
    // 不用 pre/code 的语法高亮容器（如 GitHub 新代码视图的 div 行）：与 pre/code 一样受代码开关控制
    if (!opts?.codeEnabled) for (const c of CODE_CONTAINER_CLASSES) if (cls.contains(c)) return true;
  }
  // 站点适配层注册的额外规则（如 YouTube 播放器控件），未注册时为空数组
  for (const rule of siteSkipRules) if (rule(el)) return true;
  return false;
}

/**
 * 站点适配层（src/content/sites）注册的额外跳过规则：返回 true 时该元素整棵子树不标注。
 * 规则在扫描每个元素与增量处理时逐个祖先调用，必须是 O(1) 的轻量判断（不要用 closest/:has 之类的子树查询）。
 */
const siteSkipRules: Array<(el: Element) => boolean> = [];

/** 注册站点跳过规则，返回注销函数（youtube 模块新增，见 architecture.md“站点适配层”） */
export function registerSiteSkipRule(rule: (el: Element) => boolean): () => void {
  siteSkipRules.push(rule);
  return () => {
    const i = siteSkipRules.indexOf(rule);
    if (i >= 0) siteSkipRules.splice(i, 1);
  };
}

/** 扫描选项（代码块开关等），由 engine 按设置传入 */
export interface ScanOptions {
  /** 代码块中标注生词：放行 pre/code 与语法高亮容器（v8） */
  codeEnabled?: boolean;
  /** 代码范围：comments=只处理注释与字符串 */
  codeScope?: 'comments' | 'all';
}

/** 代码开关打开时可以进入的标签 */
export const CODE_TAGS = new Set(['CODE', 'PRE']);

/**
 * 不以 pre/code 为根的常见语法高亮/代码视图容器类名（只读渲染，不是编辑器）：
 * - GitHub 新代码视图（React 渲染的 div 行）：react-code-lines、react-code-text、react-file-line
 * - GitHub 旧代码视图 / Gist / diff：blob-code、blob-code-inner、diff-text-inner
 * - highlight.js、Prism React Renderer、Shiki、SyntaxHighlighter（div/table 结构）的根类名
 * 只收录专用于代码的类名；`highlight` 这类通用词不收录（正文强调也常用），其内部一般有 pre 兜底。
 */
const CODE_CONTAINER_CLASSES = [
  'react-code-lines', 'react-code-text', 'react-file-line',
  'blob-code', 'blob-code-inner', 'diff-text-inner',
  'hljs', 'prism-code', 'shiki', 'syntaxhighlighter',
];

/** 代码根选择器：pre、code 与上面的语法高亮容器（scanner#codeRootOf 用来定位文本所在的代码块） */
export const CODE_ROOT_SELECTOR = ['pre', 'code', ...CODE_CONTAINER_CLASSES.map((c) => `.${c}`)].join(',');

/** 在线编辑器根元素类名：Monaco、CodeMirror 5/6、Ace */
const EDITOR_CLASSES = ['monaco-editor', 'CodeMirror', 'cm-editor', 'ace_editor'];

/**
 * 语法高亮库中“注释与字符串”的类名选择器：GitHub（pl-c/pl-s）、highlight.js、Prism、Pygments/Rouge（GitLab、Jekyll 等）。
 * Shiki 只输出内联颜色，无法识别注释，属于“识别不了 → 不处理”。
 */
export const CODE_COMMENT_STRING_SELECTOR = [
  '.pl-c', '.pl-s', '.pl-pds',
  '.hljs-comment', '.hljs-string', '.hljs-quote', '.hljs-doctag',
  '.token.comment', '.token.string', '.token.docstring', '.token.template-string', '.token.prolog',
  '.c', '.c1', '.cm', '.cs', '.ch', '.cd', '.sd', '.s', '.s1', '.s2', '.sb', '.sc', '.sh', '.sx',
].join(',');

/** 节点是否位于我们自己注入的元素内部（mark / 翻译 / 卡片宿主） */
export function isInsideOwnNode(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !!el?.closest(`${TAG_MARK},${TAG_CARD_HOST}`);
}
