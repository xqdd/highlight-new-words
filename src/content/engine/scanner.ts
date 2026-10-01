import { CODE_COMMENT_STRING_SELECTOR, CODE_ROOT_SELECTOR, shouldSkipElement, type ScanOptions } from './dom';

const HAS_LETTER = /[A-Za-z]{2}/;

/**
 * 创建遍历 root 下待处理文本节点的 TreeWalker（SHOW_ELEMENT|SHOW_TEXT）：
 * 遇到需跳过的元素返回 FILTER_REJECT，整棵子树不再遍历，开销最小。
 * engine 逐个 nextNode() 取节点、边取边处理，大页面也能严格按时间预算切片（不必一次性收集全部节点）。
 * 处理过程中原文本节点留在原位（见 highlighter 的不变式），walker 可以安全地继续向后遍历。
 * @param skip 额外跳过的文本节点（engine 用来排除已处理过的节点）
 * @param opts 扫描选项：代码块开关打开时放行 pre/code，并按范围过滤代码中的文本
 */
export function createTextWalker(root: Node, skip?: (t: Text) => boolean, opts?: ScanOptions): TreeWalker {
  const doc = root.ownerDocument ?? (root as Document);
  return doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return shouldSkipElement(node as Element, opts) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      const t = node as Text;
      if (!HAS_LETTER.test(t.data) || skip?.(t)) return NodeFilter.FILTER_SKIP;
      if (opts?.codeEnabled && !codeTextAllowed(t, opts)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

/** 单独的文本节点是否值得处理（增量处理新插入/改写的文本节点时，需要检查其所在上下文） */
export function isTextCandidate(t: Text, opts?: ScanOptions): boolean {
  const parent = t.parentElement;
  if (!parent || !HAS_LETTER.test(t.data) || closestSkipped(parent, opts)) return false;
  return !opts?.codeEnabled || codeTextAllowed(t, opts);
}

/** 增量处理的根元素是否位于需跳过的上下文中（自身或祖先） */
export function isRootSkipped(el: Element, opts?: ScanOptions): boolean {
  return closestSkipped(el, opts);
}

/**
 * 节点（文本或元素）所在的代码根元素：pre、code 或常见语法高亮容器（见 CODE_ROOT_SELECTOR），取最外层；
 * 不在代码中返回 null。取最外层是为了让同一代码块（如 GitHub 整个文件视图）共用一个根，浮动小标注按整块重排。
 */
export function codeRootOf(node: Node): Element | null {
  let root = node.nodeType === Node.ELEMENT_NODE ? (node as Element).closest(CODE_ROOT_SELECTOR) : node.parentElement?.closest(CODE_ROOT_SELECTOR);
  if (!root) return null;
  for (let up = root.parentElement?.closest(CODE_ROOT_SELECTOR); up; up = up.parentElement?.closest(CODE_ROOT_SELECTOR)) root = up;
  return root;
}

/**
 * 代码中的文本是否在处理范围内：
 * - all：全部代码文本
 * - comments：只处理语法高亮标出的注释与字符串（见 CODE_COMMENT_STRING_SELECTOR）；
 *   没有高亮类名的代码（含行内 code）识别不了，不处理
 * 不在代码中的文本总是允许。
 */
function codeTextAllowed(t: Text, opts: ScanOptions): boolean {
  const root = codeRootOf(t);
  if (!root) return true;
  if (opts.codeScope === 'all') return true;
  const hit = t.parentElement!.closest(CODE_COMMENT_STRING_SELECTOR);
  return !!hit && root.contains(hit);
}

/** 收集 root 下待处理的文本节点（一次性版本，测试与小范围处理使用） */
export function collectTextNodes(root: Node, skip?: (t: Text) => boolean, opts?: ScanOptions): Text[] {
  if (root.nodeType === Node.TEXT_NODE) {
    const t = root as Text;
    return isTextCandidate(t, opts) && !skip?.(t) ? [t] : [];
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return [];
  }
  if (root.nodeType === Node.ELEMENT_NODE && closestSkipped(root as Element, opts)) return [];
  const out: Text[] = [];
  const walker = createTextWalker(root, skip, opts);
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

/** 元素自身或祖先是否需跳过 */
function closestSkipped(el: Element, opts?: ScanOptions): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (shouldSkipElement(cur, opts)) return true;
  }
  return false;
}
