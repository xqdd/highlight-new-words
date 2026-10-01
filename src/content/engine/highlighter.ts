import type { MatchResult } from '@/core/match/matcher';
import { tokenize } from '@/core/text/tokenize';
import { ATTR_BOOK, ATTR_BOOKS, ATTR_LEMMA, ATTR_TR_TEXT, TAG_MARK, TAG_TRANSLATION, TAG_WORD } from './dom';

export type MatchFn = (word: string) => MatchResult | null;

/**
 * “切分组”：一个页面原始文本节点被高亮后，切出来的后续节点（mark 与剩余文本片段），按文档顺序排列。
 *
 * 不变式：**页面原始文本节点永远留在原位置**，只保留第一个命中词之前的文字（可能为空串），
 * 其余内容都在紧随其后的“片段”里。这样页面框架（React/Vue 等）持有的文本节点引用始终有效：
 * - 框架 removeChild(原节点) 不会因为节点被移进 mark 而抛错；engine 收到删除记录后把片段一并移除
 * - 框架改写原节点 nodeValue 时，engine 丢弃旧片段并重新处理，避免新旧文字重复
 */
const fragmentsOf = new WeakMap<Text, Node[]>();
/** mark/剩余片段 -> 所属原始文本节点 */
const ownerOf = new WeakMap<Node, Text>();

/**
 * 高亮单个文本节点：把命中的单词包裹成 `<hnw-mark><hnw-w>词</hnw-w></hnw-mark>`。
 *
 * 用 splitText 从后往前切分，原文本节点保留在原位置（见上方不变式）；首个命中词位于开头时，
 * 原节点被切成空串而不是整体移进 mark。
 *
 * @param onLeftover 切分产生的剩余文本片段（不含单词）回调，engine 用来标记为已处理，避免重复扫描
 * @returns 新建的 mark 元素（文档顺序）
 */
export function highlightTextNode(node: Text, match: MatchFn, onLeftover?: (t: Text) => void): HTMLElement[] {
  const tokens = tokenize(node.data);
  const hits: { start: number; end: number; m: MatchResult }[] = [];
  for (const tk of tokens) {
    const m = match(tk.word);
    if (m) hits.push({ start: tk.start, end: tk.end, m });
  }
  if (hits.length === 0) return [];
  const doc = node.ownerDocument;
  const marks: HTMLElement[] = [];
  const fragments: Node[] = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const { start, end, m } = hits[i]!;
    if (end < node.data.length) {
      // 注意不能写成 onLeftover?.(node.splitText(end))：可选调用在回调缺省时不会求值参数，切分会被跳过
      const rest = node.splitText(end);
      onLeftover?.(rest);
      fragments.push(rest);
    }
    // start 为 0 时也切分（原节点变为空串），保证原节点不离开原位置
    const wordNode = node.splitText(start);
    const mark = createMark(doc, m);
    const word = doc.createElement(TAG_WORD);
    wordNode.parentNode!.insertBefore(mark, wordNode);
    word.appendChild(wordNode);
    mark.appendChild(word);
    marks.push(mark);
    fragments.push(mark);
  }
  fragments.reverse();
  // 原节点若已有旧片段（调用方应先 restore/drop），这里覆盖登记
  fragmentsOf.set(node, fragments);
  for (const f of fragments) ownerOf.set(f, node);
  return marks.reverse();
}

function createMark(doc: Document, m: MatchResult): HTMLElement {
  const mark = doc.createElement(TAG_MARK);
  mark.setAttribute(ATTR_LEMMA, m.lemma);
  mark.setAttribute(ATTR_BOOK, m.bookIds[0]!);
  mark.setAttribute(ATTR_BOOKS, m.bookIds.join(' '));
  return mark;
}

/** mark/片段所属的原始文本节点（非切分组成员返回 undefined） */
export function ownerTextOf(node: Node): Text | undefined {
  return ownerOf.get(node);
}

/** 原始文本节点是否有切分片段 */
export function hasFragments(t: Text): boolean {
  return fragmentsOf.has(t);
}

/**
 * 还原切分组：把片段文字按顺序拼回原文本节点并移除片段，DOM 恢复为高亮前的样子。
 * 原节点已被页面移走/移动时同样适用：片段从旧位置移除，原节点带着完整文字（若被重新插入，engine 会再处理）。
 */
export function restoreGroup(original: Text): void {
  const fragments = fragmentsOf.get(original);
  if (!fragments) return;
  fragmentsOf.delete(original);
  let text = '';
  for (const f of fragments) {
    ownerOf.delete(f);
    text += f.nodeType === Node.TEXT_NODE ? (f as Text).data : markSurface(f as Element);
    (f as ChildNode).remove();
  }
  if (text) original.data += text;
}

/** 丢弃切分组的片段但不拼回文字（页面已改写原节点内容时使用，旧片段已过时） */
export function dropGroup(original: Text): void {
  const fragments = fragmentsOf.get(original);
  if (!fragments) return;
  fragmentsOf.delete(original);
  for (const f of fragments) {
    ownerOf.delete(f);
    (f as ChildNode).remove();
  }
}

/**
 * 为 mark 设置/更新行内翻译（translation 为空则移除翻译元素）。
 * 释义写在属性上由 CSS 伪元素渲染（见 dom.ts 的 ATTR_TR_TEXT）。
 */
export function setMarkTranslation(mark: Element, translation: string | undefined): void {
  let tr = mark.querySelector(TAG_TRANSLATION);
  if (!translation) {
    tr?.remove();
    return;
  }
  if (!tr) {
    tr = mark.ownerDocument.createElement(TAG_TRANSLATION);
    // 释义是装饰性内容：不参与读屏
    tr.setAttribute('aria-hidden', 'true');
    mark.appendChild(tr);
  }
  if (tr.getAttribute(ATTR_TR_TEXT) !== translation) tr.setAttribute(ATTR_TR_TEXT, translation);
}

/** mark 中的原单词文本（不含翻译） */
export function markSurface(mark: Element): string {
  return (mark.querySelector(TAG_WORD) ?? mark).textContent ?? '';
}

/** 取消 root 下全部高亮：按切分组还原原文本节点；不属于任何切分组的 mark（异常情况）替换为纯文本 */
export function unwrapAll(root: ParentNode): void {
  const owners = new Set<Text>();
  root.querySelectorAll(TAG_MARK).forEach((mark) => {
    const owner = ownerOf.get(mark);
    if (owner) owners.add(owner);
    else mark.replaceWith(mark.ownerDocument.createTextNode(markSurface(mark)));
  });
  owners.forEach(restoreGroup);
}
