import type { Token } from '@/core/text/tokenize';

/**
 * 代码文本切词（v8）：标识符按 camelCase / PascalCase / snake_case / kebab-case / 数字分隔拆成单词，
 * 位置保留在原文中，高亮可以落在子串上（`getElementById` 中的 “Element”）。
 * - `XMLHttpRequest` -> XML, Http, Request（连续大写视为缩写，最后一个大写字母归下一个单词）
 * - `user_name2_field` -> user, name, field
 */
const IDENT_PART_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g;
const RUN_RE = /[A-Za-z]+/g;

export function tokenizeCode(text: string): Token[] {
  const out: Token[] = [];
  for (const run of text.matchAll(RUN_RE)) {
    for (const part of run[0].matchAll(IDENT_PART_RE)) {
      const start = run.index + part.index;
      out.push({ word: part[0], start, end: start + part[0].length });
    }
  }
  return out;
}
