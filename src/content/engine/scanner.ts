import { shouldSkipElement } from './dom';

const HAS_LETTER = /[A-Za-z]{2}/;

/**
 * 创建遍历 root 下待处理文本节点的 TreeWalker（SHOW_ELEMENT|SHOW_TEXT）：
 * 遇到需跳过的元素返回 FILTER_REJECT，整棵子树不再遍历，开销最小。
 * engine 逐个 nextNode() 取节点、边取边处理，大页面也能严格按时间预算切片（不必一次性收集全部节点）。
 * 处理过程中原文本节点留在原位（见 highlighter 的不变式），walker 可以安全地继续向后遍历。
 * @param skip 额外跳过的文本节点（engine 用来排除已处理过的节点）
 */
export function createTextWalker(root: Node, skip?: (t: Text) => boolean): TreeWalker {
  const doc = root.ownerDocument ?? (root as Document);
  return doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return shouldSkipElement(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      const t = node as Text;
      if (!HAS_LETTER.test(t.data) || skip?.(t)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

/** 单独的文本节点是否值得处理（增量处理新插入/改写的文本节点时，需要检查其所在上下文） */
export function isTextCandidate(t: Text): boolean {
  const parent = t.parentElement;
  return !!parent && HAS_LETTER.test(t.data) && !closestSkipped(parent);
}

/** 增量处理的根元素是否位于需跳过的上下文中（自身或祖先） */
export function isRootSkipped(el: Element): boolean {
  return closestSkipped(el);
}

/** 收集 root 下待处理的文本节点（一次性版本，测试与小范围处理使用） */
export function collectTextNodes(root: Node, skip?: (t: Text) => boolean): Text[] {
  if (root.nodeType === Node.TEXT_NODE) {
    const t = root as Text;
    return isTextCandidate(t) && !skip?.(t) ? [t] : [];
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return [];
  }
  if (root.nodeType === Node.ELEMENT_NODE && closestSkipped(root as Element)) return [];
  const out: Text[] = [];
  const walker = createTextWalker(root, skip);
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

/** 元素自身或祖先是否需跳过 */
function closestSkipped(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (shouldSkipElement(cur)) return true;
  }
  return false;
}
