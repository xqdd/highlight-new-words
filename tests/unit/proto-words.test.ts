import { describe, expect, it } from 'vitest';
import { PackagedDictionary } from '@/core/dict/packaged';
import type { DictShardFile } from '@/core/dict/types';
import { describeForm } from '@/content/card/word-info';

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
