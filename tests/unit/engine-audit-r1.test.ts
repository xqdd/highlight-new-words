import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DataLemmatizer, type LemmaDataFile } from '@/core/lemma/data-lemmatizer';
import type { Lemmatizer } from '@/core/lemma/types';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import { createUserWordBook } from '@/core/wordbook/user-book';
import type { BookMeta } from '@/core/wordbook/types';
import type { Dictionary, DictEntry } from '@/core/dict/types';
import { createDefaultSettings } from '@/core/settings/defaults';
import { HighlightEngine, planCodeFloats } from '@/content/engine/engine';
import { buildPageCss } from '@/content/engine/style';

const flush = () => new Promise((r) => setTimeout(r, 40));
const meta = (id: string, kind: BookMeta['kind']): BookMeta => ({
  id,
  name: id,
  nameEn: id,
  short: id,
  kind,
  category: kind === 'builtin' ? 'exam' : 'user',
  level: 1,
  size: 0,
});
const dictOf = (entries: Record<string, Partial<DictEntry>>): Dictionary => ({
  lookup: async (w) => (entries[w] ? { word: w, ...entries[w] } : undefined),
  lookupMany: async (ws) => new Map([...ws].filter((w) => entries[w]).map((w) => [w, { word: w, ...entries[w] }])),
});

let engine: HighlightEngine | undefined;
afterEach(() => {
  engine?.stop();
  engine = undefined;
  document.body.innerHTML = '';
});

describe('A2 用户词书与熟词本中的变形条目按屈折原形参与匹配', () => {
  // 使用打包的真实词形数据（criteria -> criterion 查表；studies/abandoned 走规则兜底）
  const lemmatizer = new DataLemmatizer();
  lemmatizer.setData(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile);
  const cet6 = createSetWordBook(meta('cet6', 'builtin'), ['criterion', 'study', 'abandon', 'runner']);
  const userBook = (words: string[]) => createUserWordBook(meta('local:1', 'local'), Object.fromEntries(words.map((w) => [w, { word: w }])));

  it('熟词本只有 criteria 时，criterion 与 criteria 都不高亮', () => {
    const m = new WordMatcher({ lemmatizer, books: [cet6], known: new Set(['criteria']) });
    expect(m.match('criterion')).toBeNull();
    expect(m.match('criteria')).toBeNull();
    expect(m.match('study')).not.toBeNull();
  });

  it('熟词本只有 abandoned（规则还原）时，abandon/abandons 不高亮', () => {
    const m = new WordMatcher({ lemmatizer, books: [cet6], known: new Set(['abandoned']) });
    expect(m.match('abandon')).toBeNull();
    expect(m.match('abandons')).toBeNull();
  });

  it('生词本只有 studies 时，study、studied 也高亮，lemma 归一为原形（卡片“认识”写入原形）', () => {
    const m = new WordMatcher({ lemmatizer, books: [userBook(['studies'])], known: new Set() });
    expect(m.match('study')).toMatchObject({ lemma: 'study', bookIds: ['local:1'] });
    expect(m.match('studied')).toMatchObject({ lemma: 'study', bookIds: ['local:1'] });
    // studies 不在词形数据表中（规则还原），只有原形被某本已加载词书收录时才归一，避免归一到规则生成的假词
    expect(m.match('studies')?.lemma).toBe('studies');
    const withCet6 = new WordMatcher({ lemmatizer, books: [userBook(['studies']), cet6], known: new Set() });
    expect(withCet6.match('studies')).toMatchObject({ lemma: 'study', bookIds: ['local:1', 'cet6'] });
    // 表内不规则变形（criteria）直接归一
    expect(new WordMatcher({ lemmatizer, books: [userBook(['criteria'])], known: new Set() }).match('criteria')?.lemma).toBe('criterion');
  });

  it('生词本变形条目命中时，bookIds 合并收录原形的内置词书', () => {
    const m = new WordMatcher({ lemmatizer, books: [userBook(['criteria']), cet6], known: new Set() });
    expect(m.match('criteria')).toMatchObject({ lemma: 'criterion', bookIds: ['local:1', 'cet6'] });
    expect(m.match('criterion')).toMatchObject({ lemma: 'criterion', bookIds: ['local:1', 'cet6'] });
  });

  it('只做屈折还原：runners 条目不会让 run 高亮（-er 施事名词不当比较级），派生词不反推', () => {
    const m = new WordMatcher({ lemmatizer, books: [userBook(['runners', 'carelessness'])], known: new Set() });
    expect(m.match('runner')?.lemma).toBe('runner');
    expect(m.match('run')).toBeNull();
    expect(m.match('care')).toBeNull();
  });
});

describe('A1 -ing/-ed 词形缺词条、处在形容词位置时不显示原形动词义', () => {
  // compelling 在词典中没有自己的词条，词形还原到 compel
  const lemmatizer: Lemmatizer = {
    analyze: (w) => {
      const base = w.toLowerCase();
      const infl = base === 'compelling' ? ['compel'] : base === 'compelled' ? ['compel'] : [];
      return { base, inflections: infl, derivations: [], fromTable: true };
    },
    candidates: (w) => {
      const base = w.toLowerCase();
      return base === 'compelling' || base === 'compelled' ? [base, 'compel'] : [base];
    },
  };
  const dict = dictOf({ compel: { short: 'vt. 强迫, 迫使' } });

  it('a compelling scenario / very compelling 不显示“强迫”；was compelling them、compelled to 仍回退动词义', async () => {
    document.body.innerHTML =
      '<p id="a">a compelling scenario.</p><p id="b">It is very compelling.</p><p id="c">He was compelling them.</p><p id="d">They felt compelled to act.</p><p id="e">the compelling of witnesses</p>';
    const matcher = new WordMatcher({ lemmatizer, books: [createSetWordBook(meta('b', 'builtin'), ['compel'])], known: new Set() });
    engine = new HighlightEngine({ root: document.body, matcher, dictionary: dict, inlineTranslation: 'after' });
    engine.start();
    await flush();
    const tr = (id: string) => document.querySelector(`#${id} hnw-mark hnw-tr`)?.getAttribute('data-tr') ?? null;
    expect(document.querySelectorAll('hnw-mark')).toHaveLength(5);
    expect(tr('a')).toBeNull();
    expect(tr('b')).toBeNull();
    expect(tr('c')).toBe('强迫');
    expect(tr('d')).toBe('强迫');
    // 限定词 + -ing + 虚词：动名词，保留动词义
    expect(tr('e')).toBe('强迫');
  });
});

describe('A3 代码浮动小标注的摆放', () => {
  const item = (top: number, center: number, width = 30) => ({ top, bottom: top + 16, center, width, height: 13 });

  it('首行上方超出滚动容器内容顶边时放下方，其余行放上方', () => {
    const clip = { top: 100, bottom: 300 };
    // 首行单词顶边距容器内容顶边 8px（容器内边距小），上方放不下 13+3px 的标注
    expect(planCodeFloats([item(108, 50), item(128, 50), item(148, 200)], clip)).toEqual(['below', 'above', 'above']);
    // 内边距足够（20px）时首行仍在上方
    expect(planCodeFloats([item(120, 50)], clip)).toEqual(['above']);
    // 没有裁切容器（行内 code）时不受限制
    expect(planCodeFloats([item(0, 50)])).toEqual(['above']);
  });

  it('同一行相邻标注重叠时后者放下方，上下都放不下时隐藏（悬停显示）', () => {
    const clip = { top: 0, bottom: 1000 };
    // 三个相邻单词中心相距 20px，标注宽 30px：第二个与第一个重叠 -> 下方；第三个上方与第一个不重叠
    expect(planCodeFloats([item(100, 50), item(100, 70), item(100, 90)], clip)).toEqual(['above', 'below', 'above']);
    // 中心相距 10px：第三个上下都与已放置的重叠
    expect(planCodeFloats([item(100, 50), item(100, 60), item(100, 70)], clip)).toEqual(['above', 'below', 'none']);
    // 输入顺序与位置无关：按从上到下、从左到右放置
    expect(planCodeFloats([item(100, 70), item(100, 50)], clip)).toEqual(['below', 'above']);
  });

  it('首行放下方的标注不与第二行上方的标注重叠', () => {
    const clip = { top: 100, bottom: 300 };
    // 首行单词 [108,124]，下方标注 [127,140]；第二行单词 top=126 时上方标注 [110,123] 与之不重叠
    expect(planCodeFloats([item(108, 50), item(126, 50)], clip)).toEqual(['below', 'above']);
    // 第二行单词 top=135 时上方标注 [119,132] 与首行下方标注重叠，改放下方
    expect(planCodeFloats([item(108, 50), item(135, 50)], clip)).toEqual(['below', 'below']);
  });

  it('样式：below 放单词下方，none 默认隐藏、桌面悬停显示', () => {
    const s = createDefaultSettings();
    s.code = { ...s.code, enabled: true, display: 'float' };
    const css = buildPageCss(s);
    expect(css).toContain('[data-hnw-float=below]>hnw-tr{bottom:auto;top:100%');
    expect(css).toContain('[data-hnw-float=none]>hnw-tr{display:none!important}');
    expect(css).toMatch(/@media \(hover:hover\)\{[^}]*\[data-hnw-float=none\]:hover>hnw-tr\{display:block!important\}/);
  });
});
