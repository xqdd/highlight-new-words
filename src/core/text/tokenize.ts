/** 文本中的一个英文单词片段 */
export interface Token {
  word: string;
  start: number;
  end: number;
}

/**
 * 英文单词切分：字母序列，允许内部撇号（don't、John's），连字符词拆成多个单词（well-known -> well, known）。
 * 不匹配数字与字母混合（如 mp3 中的 mp 仍会被切出，匹配阶段因词书不收录而忽略）。
 */
const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}
