import { describe, expect, it } from 'vitest';
import { PackagedDictionary } from '@/core/dict/packaged';
import type { DictShardFile } from '@/core/dict/types';
import { describeForm } from '@/content/card/word-info';
import { applyKnownChange, createEmptyKnown, mergeKnownWords, normalizeKnown } from '@/core/known/merge';
import { decodeKnownSegment, encodeKnownSegment } from '@/core/sync/known-codec';
import { getOwn, hasOwnKey, setOwn } from '@/core/storage/own-record';
import { mergeYoudaoItem } from '@/background/sources/youdao';
import { createUserWordBook } from '@/core/wordbook/user-book';
import { toWordMap } from '@/core/wordbook/user-store';
import type { BookMeta, UserWordMap } from '@/core/wordbook/types';

/**
 * 页面单词与 Object.prototype 属性同名（constructor/toString/valueOf/hasOwnProperty/__proto__）时，
 * 按单词索引普通对象（词典分片）不能取到原型上的函数。lemma/匹配侧的用例见 lemma.test.ts。
 */
describe('PackagedDictionary：Object.prototype 同名单词', () => {
  const PROTO_WORDS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];

  it('分片未收录时 lookup / lookupMany 返回空，不返回原型函数拼出的假词条', async () => {
    const dict = new PackagedDictionary(async () => ({}) as DictShardFile);
    const many = await dict.lookupMany(PROTO_WORDS);
    expect([...many.keys()]).toEqual([]);
    for (const w of PROTO_WORDS) expect(await dict.lookup(w), w).toBeUndefined();
  });

  it('分片收录 constructor 时正常查到（JSON 解析出的自有属性）', async () => {
    const shards: Record<string, DictShardFile> = {
      c: JSON.parse('{"constructor":{"s":"构造器","r":9000}}') as DictShardFile,
      'full/c': JSON.parse('{"constructor":{"f":"n. 建造者, 构造器"}}') as DictShardFile,
      _: JSON.parse('{"__proto__":{"s":"假"}}') as DictShardFile,
    };
    const dict = new PackagedDictionary(async (p) => shards[p] ?? {});
    expect((await dict.lookupMany(['constructor', 'toString'])).get('constructor')?.short).toBe('构造器');
    expect((await dict.lookup('constructor'))?.full).toBe('n. 建造者, 构造器');
    expect(await dict.lookup('toString')).toBeUndefined();
    // JSON.parse 出的 __proto__ 是自有属性，按普通词条处理
    expect((await dict.lookup('__proto__'))?.short).toBe('假');
  });
});

describe('describeForm：Object.prototype 同名原形', () => {
  it('不规则变化表不取到原型上的函数', () => {
    // 用户词书收录 constructor 时，页面 constructors 的卡片会以 constructor 为原形调用 describeForm
    expect(describeForm('constructors', 'constructor')).toBe('复数，第三人称单数');
    expect(describeForm('tostrings', 'toString')).toBe('复数，第三人称单数');
    expect(describeForm('valueof', 'valueOf')).toBeUndefined();
    for (const w of ['hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      expect(() => describeForm(`${w}ed`, w), w).not.toThrow();
    }
  });
});

/** 熟词本、来源词书缓存等以单词为 key 的普通对象（backlog #125） */
describe('own-record：以单词为 key 的普通对象读写', () => {
  it('原型链上的同名属性视为不存在；__proto__ 写成自有属性而不改原型', () => {
    const rec: Record<string, number> = {};
    for (const w of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(hasOwnKey(rec, w), w).toBe(false);
      expect(getOwn(rec, w), w).toBeUndefined();
    }
    setOwn(rec, '__proto__', 1);
    setOwn(rec, 'constructor', 2);
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
    expect(Object.keys(rec).sort()).toEqual(['__proto__', 'constructor']);
    expect(getOwn(rec, '__proto__')).toBe(1);
    expect(getOwn(rec, 'constructor')).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('熟词合并：constructor / __proto__ 作为熟词', () => {
  it('未加入时撤销不产生墓碑，加入后是自有词条且不改原型', () => {
    const empty = createEmptyKnown();
    // 旧实现 w in next.words 会把 constructor 当作已存在，撤销时写出墓碑
    const undo = applyKnownChange(empty, ['constructor', 'toString', '__proto__'], false, 100);
    expect(undo).toEqual({ words: {}, removed: {} });

    const added = applyKnownChange(empty, ['Constructor', '__proto__', 'valueOf'], true, 200);
    expect(Object.keys(added.words).sort()).toEqual(['__proto__', 'constructor', 'valueof']);
    expect(getOwn(added.words, '__proto__')).toBe(200);
    expect(Object.getPrototypeOf(added.words)).toBe(Object.prototype);

    const removed = applyKnownChange(added, ['__proto__', 'constructor'], false, 300);
    expect(Object.keys(removed.words)).toEqual(['valueof']);
    expect(getOwn(removed.removed, '__proto__')).toBe(300);
    expect(getOwn(removed.removed, 'constructor')).toBe(300);
  });

  it('mergeKnownWords 不把原型函数当作加入/撤销时间', () => {
    const now = 1_000;
    const a = applyKnownChange(createEmptyKnown(), ['__proto__', 'constructor'], true, 500);
    const b = normalizeKnown(JSON.parse('{"words":{"hasownproperty":400},"removed":{"__proto__":600}}'));
    const merged = mergeKnownWords(a, b, now);
    expect(merged.words).toEqual({ constructor: 500, hasownproperty: 400 });
    expect(Object.keys(merged.removed)).toEqual(['__proto__']);
    expect(getOwn(merged.removed, '__proto__')).toBe(600);
    expect(Object.getPrototypeOf(merged.words)).toBe(Object.prototype);
    // 两侧都没有 toString：结果不应凭空出现
    expect(hasOwnKey(mergeKnownWords(createEmptyKnown(), createEmptyKnown(), now).words, 'toString')).toBe(false);
  });

  it('同步段编解码保留 __proto__ / constructor 熟词', () => {
    const data = applyKnownChange(createEmptyKnown(), ['__proto__', 'constructor'], true, 1_700_000_000_000);
    const back = decodeKnownSegment(encodeKnownSegment(data, 'full'));
    expect(Object.keys(back.words).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(back.words)).toBe(Object.prototype);
  });
});

describe('生词缓存：constructor / __proto__ 作为生词', () => {
  it('有道条目合并：constructor 不并到原型函数上，__proto__ 写成词条', () => {
    const words: UserWordMap = {};
    mergeYoudaoItem(words, { itemId: '1', word: 'constructor', trans: 'n. 构造器' });
    mergeYoudaoItem(words, { itemId: '2', word: '__proto__', trans: '原型' });
    mergeYoudaoItem(words, { itemId: '3', word: 'Constructor' });
    expect(Object.getPrototypeOf(words)).toBe(Object.prototype);
    expect(Object.keys(words).sort()).toEqual(['__proto__', 'constructor']);
    expect(getOwn(words, 'constructor')).toMatchObject({ word: 'constructor', trans: 'n. 构造器', refs: ['1', '3'] });
    expect(getOwn(words, '__proto__')).toMatchObject({ word: '__proto__', refs: ['2'] });
  });

  it('本地词书 toWordMap + createUserWordBook：只认自有词条', () => {
    const map = toWordMap([{ word: '__proto__', trans: '原型' }, { word: 'Constructor' }]);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    const book = createUserWordBook({ id: 'local:t', name: 't' } as BookMeta, map);
    expect(book.size).toBe(2);
    expect(book.has('__proto__')).toBe(true);
    expect(book.has('constructor')).toBe(true);
    expect(book.has('toString')).toBe(false);
    expect(book.entry?.('__proto__')?.trans).toBe('原型');
    expect(book.entry?.('valueOf')).toBeUndefined();
  });
});
