import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DataLemmatizer, type LemmaDataFile } from '@/core/lemma/data-lemmatizer';
import { inflectionRuleCandidates, normalizeSurface } from '@/core/lemma/rules';
import { findWordFormsOfLemma } from '@/core/match/forms';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { BookMeta } from '@/core/wordbook/types';
import { isDerivCategory, loadGold, packagedWords, pct, score } from './lemma-eval';

const DATA = path.resolve(__dirname, '../../public/data/lemma/lemma.json');
const data = JSON.parse(fs.readFileSync(DATA, 'utf8')) as LemmaDataFile;

const meta = (id: string): BookMeta => ({ id, name: id, nameEn: id, short: id, kind: 'builtin', category: 'exam', level: 1, size: 0 });

describe('lemma rules', () => {
  it('normalizeSurface 处理所有格、缩写与弯撇号', () => {
    expect(normalizeSurface("Children's")).toBe('children');
    expect(normalizeSurface('John’s')).toBe('john');
    expect(normalizeSurface("students'")).toBe('students');
    expect(normalizeSurface("isn't")).toBe('is');
    expect(normalizeSurface("can't")).toBe('can');
    expect(normalizeSurface("won't")).toBe('will');
    expect(normalizeSurface("we've")).toBe('we');
  });

  it('规则覆盖常见屈折拼写', () => {
    expect(inflectionRuleCandidates('stopped')).toContain('stop');
    expect(inflectionRuleCandidates('lying')).toContain('lie');
    expect(inflectionRuleCandidates('knives')).toContain('knife');
    expect(inflectionRuleCandidates('happiest')).toContain('happy');
    expect(inflectionRuleCandidates('travelled')).toContain('travel');
  });
});

describe('DataLemmatizer', () => {
  const lem = new DataLemmatizer();
  beforeAll(() => lem.setData(data));

  it('契约：首个候选为小写原词，去重', () => {
    const c = lem.candidates('Running');
    expect(c[0]).toBe('running');
    expect(c).toContain('run');
    expect(new Set(c).size).toBe(c.length);
  });

  it('不规则变化与派生词', () => {
    expect(lem.candidates('went')).toContain('go');
    expect(lem.candidates('better')).toContain('good');
    expect(lem.candidates('children')).toContain('child');
    expect(lem.candidates("children's")).toEqual(["children's", 'children', 'child']);
    expect(lem.candidates('happiness')).toContain('happy');
    expect(lem.candidates('carelessly')).toEqual(expect.arrayContaining(['careless', 'care']));
    // 低频派生词：屈折 + 派生链（teacher 是高频独立词条，不再派生到 teach，见“高频词不做派生还原”）
    expect(lem.candidates('sailors')).toEqual(expect.arrayContaining(['sailor', 'sail']));
  });

  it('analyze 区分屈折与派生', () => {
    expect(lem.analyze("Sailors'")).toMatchObject({ base: 'sailors', inflections: ['sailor'], derivations: ['sail'], fromTable: true });
    expect(lem.analyze("Teachers'")).toMatchObject({ base: 'teachers', inflections: ['teacher'], derivations: [] });
    expect(lem.analyze('went')).toMatchObject({ inflections: ['go'], derivations: [] });
    expect(lem.analyze('zorbified').fromTable).toBe(false);
  });

  it('不误还原', () => {
    expect(lem.candidates('business')).toEqual(['business']);
    expect(lem.candidates('news')).toEqual(['news']);
    expect(lem.candidates('used')).not.toContain('us');
    expect(lem.candidates('hardly')).not.toContain('hard');
    expect(lem.candidates('corner')).not.toContain('corn');
  });

  // L1：高频独立词条不做派生还原（normal ↛ norm “标准”），低频派生词仍还原到词根
  it('高频词不做派生还原（派生还原过度回归）', () => {
    const highFreq = ['normal', 'committee', 'total', 'professional', 'formal', 'signal', 'mineral', 'spiral', 'they', 'after',
      'happen', 'often', 'figure', 'baby', 'realize', 'pressure', 'position', 'business', 'series', 'lovely', 'family', 'teacher'];
    for (const w of highFreq) expect(lem.analyze(w).derivations, w).toEqual([]);
    // 低频派生词仍能还原
    expect(lem.analyze('careless').derivations).toEqual(['care']);
    expect(lem.analyze('carelessly').derivations).toEqual(['careless', 'care']);
    expect(lem.analyze('carelessness').derivations).toEqual(['careless', 'care']);
    // 高频词中的透明派生（方式副词 -ly、-ness/-ful/-less）保留
    expect(lem.analyze('quickly').derivations).toEqual(['quick']);
    expect(lem.analyze('happiness').derivations).toEqual(['happy']);
    expect(lem.analyze('carefully').derivations).toEqual(['careful', 'care']);
  });

  it('词书只收词根时高频词不借词根命中；页面词形自身作卡片词条（a normal student）', () => {
    // cet6/ielts/gre 内置词书收了 norm 而没有 normal：修复前 normal 被高亮成 norm（卡片显示“标准”）
    const onlyRoot = new WordMatcher({ lemmatizer: lem, books: [createSetWordBook(meta('cet6'), ['norm', 'commit', 'press', 'sail'])], known: new Set() });
    for (const w of ['normal', 'committee', 'pressure']) expect(onlyRoot.match(w), w).toBeNull();
    expect(onlyRoot.match('sailors')?.lemma).toBe('sail');
    const both = new WordMatcher({ lemmatizer: lem, books: [createSetWordBook(meta('b'), ['norm', 'normal'])], known: new Set() });
    expect(both.match('normal')?.lemma).toBe('normal');
    // YouTube 字幕面板对非生词取第一个查得到释义的候选作卡片词条：normal 的候选只有它自己
    expect(lem.candidates('normal')).toEqual(['normal']);
    // 熟词判定也不再串到词根：标记 norm 为熟词不影响 normal
    const knownRoot = new WordMatcher({ lemmatizer: lem, books: [createSetWordBook(meta('b'), ['normal'])], known: new Set(['norm']) });
    expect(knownRoot.match('normal')?.lemma).toBe('normal');
  });

  it('init 前退化为规则还原；数据加载失败不抛错', async () => {
    const plain = new DataLemmatizer();
    expect(plain.candidates('walked')).toContain('walk');
    const broken = new DataLemmatizer(() => Promise.reject(new Error('404')));
    await expect(broken.init()).resolves.toBeUndefined();
    expect(broken.candidates('studies')).toContain('study');
  });

  it('init 幂等，只加载一次', async () => {
    let calls = 0;
    const l = new DataLemmatizer(async () => {
      calls++;
      return data;
    });
    await Promise.all([l.init(), l.init()]);
    await l.init();
    expect(calls).toBe(1);
    expect(l.candidates('went')).toContain('go');
  });

  it('与 WordMatcher 配合：词书只收原形时命中变形与派生，熟词按原形生效', () => {
    const book = createSetWordBook(meta('b'), ['go', 'happy', 'busy', 'child', 'sail']);
    const m = new WordMatcher({ lemmatizer: lem, books: [book], known: new Set() });
    expect(m.match('went')?.lemma).toBe('go');
    expect(m.match('Happily')?.lemma).toBe('happy');
    expect(m.match("children's")?.lemma).toBe('child');
    expect(m.match('sailors')?.lemma).toBe('sail');
    expect(m.match('business')).toBeNull();
    const known = new WordMatcher({ lemmatizer: lem, books: [book], known: new Set(['go']) });
    expect(known.match('gone')).toBeNull();
  });

  it('findWordFormsOfLemma：同原形的词形都找出来（deleteOnKnown）', () => {
    // runner 是高频独立词条（排名 ≤ 5000），不算 run 的派生形式
    expect(findWordFormsOfLemma('run', ['ran', 'running', 'runs', 'rung', 'runner', 'rune'], lem).sort()).toEqual(
      ['ran', 'running', 'runs'].sort(),
    );
    expect(findWordFormsOfLemma('sail', ['sailed', 'sailing', 'sailor', 'sailors', 'sale'], lem).sort()).toEqual(
      ['sailed', 'sailing', 'sailor', 'sailors'].sort(),
    );
    expect(findWordFormsOfLemma('busy', ['business', 'busier', 'busily'], lem)).not.toContain('business');
  });

  it('金标测试集准确率（打包词典作为真实词判定）', () => {
    const words = packagedWords();
    const isWord = (w: string) => words.has(w);
    const res = score(loadGold(), {
      name: 'hnw',
      predict: (it) => (isDerivCategory(it.category) ? lem.root(it.word, isWord) : lem.lemma(it.word, isWord)),
      candidates: (it) => lem.candidates(it.word),
    });
    console.log(
      Object.entries(res)
        .map(([k, v]) => `${k}: ${pct(v)}${v.errors.length ? `  错: ${v.errors.slice(0, 12).join(', ')}` : ''}`)
        .join('\n'),
    );
    expect(res['ALL-无派生']!.correct / res['ALL-无派生']!.total).toBeGreaterThan(0.9);
    expect(res.keep!.correct / res.keep!.total).toBeGreaterThan(0.9);
    // 派生口径（docs/architecture.md「词形还原」）：低频派生与高频透明后缀照常回到词根，高频独立词条一律不还原
    expect(res.deriv!.correct / res.deriv!.total).toBeGreaterThan(0.95);
    expect(res['deriv-hf']!.errors).toEqual([]);
  });

  it('性能：10 万次 candidates < 1s', () => {
    const words = loadGold().map((g) => g.word);
    const l = new DataLemmatizer();
    l.setData(data);
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) l.candidates(words[i % words.length]! + (i % 7 === 0 ? 's' : ''));
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
