import type { MatchResult } from '@/core/match/matcher';
import { tokenize, type Token } from '@/core/text/tokenize';
import { isCodeKnownWord } from '@/core/dict/code-words';
import { isHyphenPrefix } from '@/core/dict/hyphen';
import { tokenizeCode } from './code';
import { ATTR_BOOK, ATTR_BOOKS, ATTR_CODE, ATTR_LEMMA, ATTR_LOW_CONFIDENCE, ATTR_TR_TEXT, TAG_MARK, TAG_TRANSLATION, TAG_WORD } from './dom';

export type MatchFn = (word: string) => MatchResult | null;

/** 高亮选项（engine 按文本所在上下文传入；options 预览不传，按正文处理） */
export interface HighlightOptions {
  /**
   * 代码文本（v8）：identifier=代码本体（拆分标识符、跳过编程熟词）；prose=代码中的注释与字符串（拆分标识符，不跳过熟词）。
   * 生成的 mark 带 data-hnw-code，不判断大小写置信度。
   */
  code?: 'identifier' | 'prose';
}

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
export function highlightTextNode(node: Text, match: MatchFn, onLeftover?: (t: Text) => void, opts?: HighlightOptions): HTMLElement[] {
  const code = opts?.code;
  const tokens = code ? tokenizeCode(node.data) : tokenize(node.data);
  const hits: { start: number; end: number; m: MatchResult; lowConf: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    // 分词只认 ASCII 字母：与非 ASCII 字母/数字相连的片段（Tomás 的 Tom、naïve 的 na、COVID19）不是完整英文词，整体跳过
    if (!code && touchesForeignChar(node.data, tk.start, tk.end)) continue;
    // 代码本体中的编程熟词（关键字、内置类型、常见缩写，清单见 core/dict/code-words）不高亮；注释和字符串照常
    if (code === 'identifier' && isCodeKnownWord(tk.word)) continue;
    // 连字符复合词的构词前缀（auto-generated 的 auto、vice-president 的 vice）不单独高亮，否则会按独立词误译（汽车、恶习）
    if (!code && node.data[tk.end] === '-' && /[A-Za-z]/.test(node.data[tk.end + 1] ?? '') && isHyphenPrefix(tk.word)) continue;
    const m = match(tk.word);
    // 代码本体中编程熟词的屈折形式（defaults、modules）同样跳过
    if (m && code === 'identifier' && isCodeKnownWord(m.lemma)) continue;
    if (m) hits.push({ start: tk.start, end: tk.end, m, lowConf: !code && isLowConfidence(node, tokens, i) });
  }
  if (hits.length === 0) return [];
  const doc = node.ownerDocument;
  const marks: HTMLElement[] = [];
  const fragments: Node[] = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const { start, end, m, lowConf } = hits[i]!;
    if (end < node.data.length) {
      // 注意不能写成 onLeftover?.(node.splitText(end))：可选调用在回调缺省时不会求值参数，切分会被跳过
      const rest = node.splitText(end);
      onLeftover?.(rest);
      fragments.push(rest);
    }
    // start 为 0 时也切分（原节点变为空串），保证原节点不离开原位置
    const wordNode = node.splitText(start);
    const mark = createMark(doc, m);
    if (code) mark.setAttribute(ATTR_CODE, code);
    if (lowConf) mark.setAttribute(ATTR_LOW_CONFIDENCE, '');
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

/** 词内字符：任意语言的字母、组合附加符号（e + ◌́）、数字 */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/** ASCII 分词得到的片段前后是否紧贴其他词内字符（说明它只是更长单词的一部分） */
function touchesForeignChar(text: string, start: number, end: number): boolean {
  return (start > 0 && WORD_CHAR.test(text[start - 1]!)) || (end < text.length && WORD_CHAR.test(text[end]!));
}

/** 句子结束/开始标记：其后的大写词视为句首 */
const SENTENCE_BREAK = /[.!?:;"“”'‘’()\[\]{}<>|•·…—–\-]/;
/** 行内元素：向前找句首时可以跨越的边界（遇到块级元素即视为段首） */
const INLINE_TAGS = new Set(['A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'LABEL', 'ABBR', 'CITE', 'Q', 'SUB', 'SUP', 'MARK', 'FONT', 'TIME', 'DFN', 'BDI', 'BDO', 'INS', 'DEL', 'HNW-MARK', 'HNW-W']);

/**
 * 大小写置信度（预研要求）：首字母大写却不在句首的词多为专有名词或界面标签（“Premium”“Apple”“Bill”），
 * 短释义很可能不对。以下情况判为低置信度：
 * - 首字母大写（含全大写），且前面最近的非空白字符不是句末/引号/括号等分隔符；
 * - 整个文本节点只有这一个大写词（导航、按钮、标签等单独成段的词）。
 * 句首的普通大写词（The 后面的句子开头）不受影响。
 */
function isLowConfidence(node: Text, tokens: Token[], index: number): boolean {
  const tk = tokens[index]!;
  const c = tk.word.charCodeAt(0);
  if (c < 65 || c > 90) return false;
  if (tokens.length === 1 && node.data.trim().length === tk.word.length) return true;
  const prev = precedingChar(node, tk.start);
  return prev !== '' && !SENTENCE_BREAK.test(prev);
}

/** 位置 offset 之前最近的非空白字符；跨越行内元素向前找，遇到块级边界返回 ''（视为段首） */
function precedingChar(node: Text, offset: number): string {
  const own = node.data.slice(0, offset).trimEnd();
  if (own) return own[own.length - 1]!;
  let cur: Node = node;
  for (let depth = 0; depth < 6; depth++) {
    let sib = cur.previousSibling;
    while (sib) {
      // 前面是块级元素（或其他非行内元素）：视为段首，也避免读取大块元素的 textContent
      if (sib.nodeType === Node.ELEMENT_NODE && !INLINE_TAGS.has((sib as Element).tagName.toUpperCase())) return '';
      const text = (sib.textContent ?? '').trimEnd();
      if (text) return text[text.length - 1]!;
      sib = sib.previousSibling;
    }
    const parent: Element | null = cur.parentElement;
    if (!parent || !INLINE_TAGS.has(parent.tagName.toUpperCase())) return '';
    cur = parent;
  }
  return '';
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

/**
 * ruby 模式预留行高：插入一个还没有释义的注解元素（无 data-tr 属性，样式显示一个不换行空格占住注解行高），
 * 与 mark 在同一帧出现；之后 setMarkTranslation 只填文字，行高不再跳变。已有注解时不动。
 */
export function reserveTranslationSlot(mark: Element): void {
  if (mark.querySelector(TAG_TRANSLATION)) return;
  const tr = mark.ownerDocument.createElement(TAG_TRANSLATION);
  tr.setAttribute('aria-hidden', 'true');
  mark.appendChild(tr);
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
