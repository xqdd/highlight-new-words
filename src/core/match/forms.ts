import type { Lemmatizer } from '../lemma/types';
import { createSetWordBook } from '../wordbook/registry';
import { WordMatcher } from './matcher';

/**
 * 在一组用户词条（小写原词，可能是变形词）中找出与 lemma 原形相同的所有词形。
 * 用于“标记熟词时同步删除来源生词本”：标记 run 时，生词本里的 running / ran / runs 都应删除。
 *
 * 复用 WordMatcher 的判定：以只含 lemma 的临时词书匹配每个词条，命中即为同一原形，
 * 因此结果与页面高亮的还原规则一致（lemma 分片升级 Lemmatizer 后自动生效）。
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
