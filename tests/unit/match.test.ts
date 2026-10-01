import { describe, expect, it } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { BookMeta } from '@/core/wordbook/types';
import { tokenize } from '@/core/text/tokenize';

const meta = (id: string): BookMeta => ({ id, name: id, nameEn: id, short: id, kind: 'builtin', category: 'exam', level: 1, size: 0 });

describe('WordMatcher', () => {
  const cet4 = createSetWordBook(meta('cet4'), ['abandon', 'study', 'run']);
  const gre = createSetWordBook(meta('gre'), ['abandon', 'scrutinize']);
  const make = (known: string[] = []) =>
    new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [cet4, gre], known: new Set(known) });

  it('原形与变形命中，bookIds 按优先级', () => {
    const m = make();
    expect(m.match('Abandoned')).toEqual({ surface: 'Abandoned', lemma: 'abandon', bookIds: ['cet4', 'gre'] });
    expect(m.match('studies')?.lemma).toBe('study');
    expect(m.match('scrutinized')?.bookIds).toEqual(['gre']);
    expect(m.match('hello')).toBeNull();
  });

  it('熟词优先（known wins）', () => {
    const m = make(['abandon']);
    expect(m.match('abandoned')).toBeNull();
    expect(m.match('study')).not.toBeNull();
  });
});

describe('tokenize', () => {
  it('切分单词、保留撇号、拆分连字符', () => {
    expect(tokenize("It's a well-known fact, isn't it? mp3").map((t) => t.word)).toEqual([
      "It's", 'a', 'well', 'known', 'fact', "isn't", 'it', 'mp',
    ]);
  });
});
