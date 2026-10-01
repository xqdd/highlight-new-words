import type { DictEntry, Dictionary } from '../dict/types';
import { getOwn, hasOwnKey } from '../storage/own-record';
import type { BookMeta, UserWord, UserWordMap, WordBook } from './types';

/** 用户词书（来源/本地导入）包装为 WordBook（key 为小写单词，可能是变形词，匹配时候选首项即原词） */
export function createUserWordBook(meta: BookMeta, words: UserWordMap | undefined): WordBook {
  const map = words ?? {};
  const keys = Object.keys(map);
  return {
    meta: { ...meta, size: keys.length },
    has: (w) => hasOwnKey(map, w),
    size: keys.length,
    words: () => keys,
    entry: (w) => (getOwn(map, w)),
  };
}

/** 用户词条释义清洗：去除 HTML 标签，取首行作为简短释义 */
export function userWordToEntry(key: string, w: Pick<UserWord, 'phonetic' | 'trans'>): DictEntry {
  const full = (w.trans ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
  const short = full.split(/\n|;(?=\s*[a-z]+\.)/)[0]?.trim();
  return { word: key, phonetic: w.phonetic || undefined, short: short || undefined, full: full || undefined };
}

/**
 * 用户词书自带的音标/释义作为词典来源（优先级高于打包词典，保留用户自定义释义）。
 * books 按启用优先级排列，同一词取第一本有释义的书。
 */
export class UserBooksDictionary implements Dictionary {
  constructor(private readonly books: WordBook[]) {}

  async lookup(word: string): Promise<DictEntry | undefined> {
    const key = word.toLowerCase();
    for (const b of this.books) {
      const w = b.entry?.(key);
      if (w && (w.trans || w.phonetic)) return userWordToEntry(key, w);
    }
    return undefined;
  }

  async lookupMany(words: Iterable<string>): Promise<Map<string, DictEntry>> {
    const out = new Map<string, DictEntry>();
    for (const word of words) {
      const e = await this.lookup(word);
      if (e) out.set(e.word, e);
    }
    return out;
  }
}
