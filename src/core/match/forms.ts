import type { Lemmatizer } from '../lemma/types';
import { createSetWordBook } from '../wordbook/registry';
import { WordMatcher } from './matcher';

/**
 * 在一组用户词条（小写原词，可能是变形词）中找出“高亮意义上”归到 lemma 的所有词形。
 *
 * 复用 WordMatcher 的判定：以只含 lemma 的临时词书匹配每个词条，命中即为同一原形，
 * 因此结果与页面高亮的还原规则一致，**包含派生词**（runner→run、careless→care）。
 * 注意：不要用它决定删除哪些词——远端删除不可恢复，删除/移除一律用 background/forms.ts 的 findInflectedForms（只含屈折变化）。
 */
export function findWordFormsOfLemma(lemma: string, words: Iterable<string>, lemmatizer: Lemmatizer): string[] {
  const target = lemma.toLowerCase();
  const book = createSetWordBook(
    { id: '__lemma__', kind: 'builtin', name: '', nameEn: '', short: '', category: 'other', level: 0, size: 0 },
    [target],
  );
  const matcher = new WordMatcher({ lemmatizer, books: [book], known: new Set() });
  const out: string[] = [];
  for (const w of words) {
    if (w === target || matcher.match(w)?.lemma === target) out.push(w);
  }
  return out;
}
