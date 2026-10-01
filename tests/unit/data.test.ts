import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CompositeDictionary, PackagedDictionary, parseForms } from '@/core/dict/packaged';
import type { DictShardFile } from '@/core/dict/types';
import { createUserWordBook, UserBooksDictionary } from '@/core/wordbook/user-book';
import { DefaultWordBookRegistry, localBookMeta, type RegistryLoaders } from '@/core/wordbook/registry';
import type { BookCatalog, BookDataFile, CatalogBookMeta } from '@/core/wordbook/types';

/**
 * data 分片单测：registry 的嵌套词书加载、打包词典两层懒加载，以及 public/data 产物的完整性与“常用词误报”回归。
 * 产物由 scripts/data/build-data.mjs 生成，改动构建规则后需重新生成并通过本测试。
 */

const DATA = path.resolve(__dirname, '../../public/data');
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')) as T;

const catalogMeta = (id: string, size = 0): CatalogBookMeta => ({ id, name: id, nameEn: id, short: id, category: 'level', level: 1, size });

function memoryLoaders(catalog: BookCatalog, files: Record<string, BookDataFile>): RegistryLoaders & { book: ReturnType<typeof vi.fn> } {
  return {
    catalog: async () => catalog,
    book: vi.fn(async (id: string) => {
      const f = files[id];
      if (!f) throw new Error('404 ' + id);
      return f;
    }),
    sourceIndex: async () => ({ books: {}, providers: {} }),
    sourceBook: async () => undefined,
    localIndex: async () => ({ books: {}, removed: {} }),
    localBook: async () => undefined,
  };
}

describe('DefaultWordBookRegistry 嵌套词书（extends）', () => {
  const files: Record<string, BookDataFile> = {
    c2: { id: 'c2', words: ['obfuscate'] },
    c1: { id: 'c1', words: ['scrutinize'], extends: ['c2'] },
    b2: { id: 'b2', words: ['vulnerable'], extends: ['c1'] },
    loop: { id: 'loop', words: ['x'], extends: ['loop'] },
  };
  const catalog: BookCatalog = { version: 2, books: ['c2', 'c1', 'b2', 'loop'].map((id) => catalogMeta(id)) };

  it('递归合并 extends 的词，共享文件只加载一次', async () => {
    const loaders = memoryLoaders(catalog, files);
    const reg = new DefaultWordBookRegistry(loaders);
    const [b2, c1] = await Promise.all([reg.load('b2'), reg.load('c1')]);
    expect([...b2!.words()].sort()).toEqual(['obfuscate', 'scrutinize', 'vulnerable']);
    expect(b2!.has('obfuscate')).toBe(true);
    expect(c1!.size).toBe(2);
    expect(loaders.book.mock.calls.map((c) => c[0]).filter((id) => id === 'c2')).toHaveLength(1);
  });

  it('循环引用不死循环', async () => {
    const reg = new DefaultWordBookRegistry(memoryLoaders(catalog, files));
    expect((await reg.load('loop'))!.size).toBe(1);
  });
});

describe('PackagedDictionary 两层分片', () => {
  const shards: Record<string, DictShardFile> = {
    w: { width: { p: 'widθ', s: '宽度', g: 'cet4 cet6', l: 4, r: 6752 } },
    'full/w': { width: { f: 'n. 宽度, 宽广', x: 's:widths' } },
    // 旧格式：f 直接在短表中
    o: { old: { s: '旧的', f: 'a. 旧的, 老的' } },
  };

  it('lookupMany 只读短表，lookup 补齐完整释义与词形', async () => {
    const load = vi.fn(async (p: string) => shards[p] ?? {});
    const dict = new PackagedDictionary(load);
    const many = await dict.lookupMany(['Width', 'nope']);
    expect(many.get('width')).toMatchObject({ short: '宽度', full: '宽度', tags: ['cet4', 'cet6'], level: 4, rank: 6752 });
    expect(many.has('nope')).toBe(false);
    expect(load.mock.calls.map((c) => c[0])).not.toContain('full/w');

    const one = await dict.lookup('width');
    expect(one).toMatchObject({ full: 'n. 宽度, 宽广', forms: [{ type: 's', word: 'widths' }] });
    expect((await dict.lookup('old'))?.full).toBe('a. 旧的, 老的');
  });

  it('parseForms 只保留屈折类型并展开多个词形', () => {
    expect(parseForms('p:went/d:gone/0:go/i:going,goin')).toEqual([
      { type: 'p', word: 'went' },
      { type: 'd', word: 'gone' },
      { type: 'i', word: 'going' },
      { type: 'i', word: 'goin' },
    ]);
    expect(parseForms('')).toBeUndefined();
  });

  it('CompositeDictionary.lookup：用户词书释义优先，打包词典补齐级别/词形', async () => {
    const packaged = new PackagedDictionary(async (p) => shards[p] ?? {});
    const meta = localBookMeta({ id: 'local:1', name: 't', format: 'txt', wordCount: 1, createdAt: 0, updatedAt: 0 });
    const user = new UserBooksDictionary([createUserWordBook(meta, { width: { word: 'width', trans: '宽' } })]);
    const e = await new CompositeDictionary([user, packaged]).lookup('width');
    expect(e).toMatchObject({ short: '宽', level: 4, forms: [{ type: 's', word: 'widths' }] });
  });
});

// ---------------------------------------------------------------------------
// 产物完整性
// ---------------------------------------------------------------------------

const catalog = readJson<BookCatalog>('books/index.json');
const fileCache = new Map<string, BookDataFile>();
const bookFile = (id: string) => {
  let f = fileCache.get(id);
  if (!f) {
    f = readJson<BookDataFile>(`books/${id}.json`);
    fileCache.set(id, f);
  }
  return f;
};
/** 与 registry 相同的合并规则 */
function bookWords(id: string): Set<string> {
  const f = bookFile(id);
  return new Set([...f.words, ...(f.extends ?? []).flatMap((p) => [...bookWords(p)])]);
}
const shortShard = (c: string) => readJson<DictShardFile>(`dict/${c}.json`);
const dictShort = new Map<string, DictShardFile>();
function dictEntry(w: string) {
  const c = w[0]!;
  if (!dictShort.has(c)) dictShort.set(c, shortShard(c));
  return dictShort.get(c)![w];
}

describe('public/data 产物', () => {
  it('目录：id 唯一、文件存在、size 与合并后词数一致、分类合法', () => {
    const ids = catalog.books.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of catalog.books) {
      expect(['level', 'exam', 'frequency', 'other']).toContain(b.category);
      expect(bookFile(b.id).id).toBe(b.id);
      expect(bookWords(b.id).size, b.id).toBe(b.size);
      expect(b.description, b.id).toBeTruthy();
    }
    // 默认启用的 cet6 必须存在；考试书覆盖需求列出的全部考试
    for (const id of ['zk', 'gk', 'cet4', 'cet6', 'kaoyan', 'toefl', 'ielts', 'gre', 'sat', 'cet6-new', 'cefr-b2', 'coca-5k']) expect(ids).toContain(id);
  });

  it('词书文件：小写纯字母、已排序、不重复，嵌套书只存差集', () => {
    for (const b of catalog.books) {
      const { words, extends: ext } = bookFile(b.id);
      expect(words.every((w) => /^[a-z]+$/.test(w)), b.id).toBe(true);
      expect([...words].sort(), b.id).toEqual(words);
      expect(new Set(words).size, b.id).toBe(words.length);
      for (const p of ext ?? []) {
        const parent = bookWords(p);
        expect(words.some((w) => parent.has(w)), `${b.id} 与 ${p} 重复存储`).toBe(false);
      }
    }
  });

  it('级别是包含体系：B2 ⊃ C1 ⊃ C2，B2 不含 A1–B1 词', () => {
    const b2 = bookWords('cefr-b2');
    const c1 = bookWords('cefr-c1');
    expect([...c1].every((w) => b2.has(w))).toBe(true);
    for (const w of ['vulnerable', 'infrastructure', 'pessimistic', 'dilemma']) expect(b2.has(w), w).toBe(true);
    for (const w of ['city', 'water', 'people', 'good', 'energy', 'year', 'because']) expect(b2.has(w), w).toBe(false);
  });

  it('增量词书与被减去的考试书不相交', () => {
    for (const b of catalog.books.filter((x) => x.delta)) {
      const words = bookWords(b.id);
      for (const m of b.delta!.minus) {
        const raw = bookWords(m);
        // minus 按原始考试词表（含基础词）计算，去基础词后的考试书是其子集，所以一定不相交
        expect([...words].filter((w) => raw.has(w)), `${b.id} ∩ ${m}`).toEqual([]);
      }
      expect([...words].every((w) => bookWords(b.delta!.of).has(w))).toBe(true);
    }
  });

  it('考试书去掉了基础常用词，且不含变形词/专有名词', () => {
    const cet6 = bookWords('cet6');
    for (const w of ['the', 'and', 'have', 'good', 'people', 'city', 'school', 'cities', 'levels', 'margaret']) expect(cet6.has(w), w).toBe(false);
    for (const w of ['vulnerable', 'premise', 'genuine', 'retreat']) expect(cet6.has(w), w).toBe(true);
    expect(bookWords('ielts').has('cities')).toBe(false);
  });

  it('词典覆盖所有内置词书的词，行内短释义 ≤ 8 字且不带词性', () => {
    const missing: string[] = [];
    let noShort = 0;
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    for (const w of all) {
      const e = dictEntry(w);
      if (!e) missing.push(w);
      else if (!e.s) noShort++;
      else {
        expect(e.s.length, w).toBeLessThanOrEqual(8);
        expect(e.s, w).not.toMatch(/^[a-z]+\./);
      }
    }
    expect(missing).toEqual([]);
    expect(noShort).toBeLessThan(10);
    expect(dictEntry('abandon')?.s).toBe('放弃');
    expect(dictEntry('scrutinize')).toMatchObject({ l: 5 });
  });
});

// ---------------------------------------------------------------------------
// 标杆回归：同一篇文章上的生词判定（对照 Relingo B2 级别在 tests/fixtures/article.html 上标出的词）
// ---------------------------------------------------------------------------

describe('文章生词判定回归（article.html）', () => {
  // 用词典全表的词形（x）反查原形，作为与 lemma 分片解耦的最小还原
  const formToLemma = new Map<string, string>();
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const full = readJson<DictShardFile>(`dict/full/${c}.json`);
    for (const [w, e] of Object.entries(full)) for (const f of parseForms(e.x) ?? []) if (!formToLemma.has(f.word)) formToLemma.set(f.word, w);
  }
  const html = fs.readFileSync(path.resolve(__dirname, '../fixtures/article.html'), 'utf8');
  const text = html.replace(/<(script|style|pre)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((m) => m[0].toLowerCase());
  const hits = (id: string) => {
    const words = bookWords(id);
    const out = new Set<string>();
    for (const t of tokens) {
      const l = words.has(t) ? t : formToLemma.get(t);
      if (l && words.has(l)) out.add(l);
    }
    return out;
  };
  // Relingo（B2）在该页标出的词中，我们的数据应当覆盖的部分（屈折/派生由 lemma 分片处理，这里只列原形出现在页面的）
  const RELINGO_B2 = ['surge', 'assumption', 'pessimistic', 'inspect', 'barrier', 'dilemma', 'vicious', 'retreat', 'revenue', 'ethical', 'reluctant', 'infrastructure', 'premise', 'vulnerable', 'hybrid', 'conventional', 'mature', 'quantify', 'genuine', 'skeptical', 'distinctive', 'urban', 'deliberate'];
  const COMMON = ['city', 'water', 'storm', 'year', 'people', 'family', 'price', 'money', 'home', 'children', 'trust', 'question'];

  it('cefr-b2：覆盖 Relingo B2 判定，常用词不高亮', () => {
    const h = hits('cefr-b2');
    const recall = RELINGO_B2.filter((w) => h.has(w)).length / RELINGO_B2.length;
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(COMMON.filter((w) => h.has(w))).toEqual([]);
  });

  it('cet6（默认词书）：高亮量与 Relingo 同量级，常用词不高亮', () => {
    const h = hits('cet6');
    expect(RELINGO_B2.filter((w) => h.has(w)).length / RELINGO_B2.length).toBeGreaterThanOrEqual(0.75);
    expect(COMMON.filter((w) => h.has(w))).toEqual([]);
    // Relingo 在此页标出约 75 个不同原形；默认词书不应过密（< 2 倍）
    expect(h.size).toBeLessThan(150);
  });
});
