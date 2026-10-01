import { afterEach, describe, expect, it } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createDefaultSettings } from '@/core/settings/defaults';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Dictionary } from '@/core/dict/types';
import { HighlightEngine, shortenTranslation } from '@/content/engine/engine';
import { highlightTextNode, unwrapAll } from '@/content/engine/highlighter';
import { contrast, ensureContrast, parseColor } from '@/content/engine/color';
import { buildPageCss } from '@/content/engine/style';

const book = createSetWordBook(
  { id: 'cet4', name: 'cet4', nameEn: 'cet4', short: '四级', kind: 'builtin', category: 'exam', level: 3, size: 0 },
  ['abandon', 'scrutinize', 'premise', 'run'],
);
const matcherWith = (known: string[] = []) =>
  new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book], known: new Set(known) });
const dict: Dictionary = {
  lookup: async (w) => ({ word: w, short: 'n. 前提' }),
  lookupMany: async (ws) => new Map([...ws].map((w) => [w, { word: w, short: 'n. 前提' }])),
};
const flush = () => new Promise((r) => setTimeout(r, 40));

function startEngine(): HighlightEngine {
  const engine = new HighlightEngine({ root: document.body, matcher: matcherWith(), dictionary: dict, inlineTranslation: 'after' });
  engine.start();
  return engine;
}

let engine: HighlightEngine | undefined;
afterEach(() => {
  engine?.stop();
  engine = undefined;
  document.body.innerHTML = '';
});

describe('highlightTextNode 原节点不离开原位置', () => {
  it('首词命中时原节点变为空串并留在原位，可完整还原', () => {
    document.body.innerHTML = '<p>Premise matters.</p>';
    const p = document.querySelector('p')!;
    const original = p.firstChild as Text;
    const marks = highlightTextNode(original, (w) => matcherWith().match(w));
    expect(marks).toHaveLength(1);
    expect(original.parentNode).toBe(p);
    expect(original.data).toBe('');
    expect(p.querySelector('hnw-mark > hnw-w')?.textContent).toBe('Premise');
    unwrapAll(document.body);
    expect(p.childNodes).toHaveLength(1);
    expect(p.firstChild).toBe(original);
    expect(original.data).toBe('Premise matters.');
  });
});

describe('与页面框架共存（模拟 React 持有文本节点引用）', () => {
  it('框架改写原文本节点内容：旧片段被丢弃并按新内容重新高亮，不重复文字', async () => {
    document.body.innerHTML = '<p>They abandoned the premise.</p>';
    const p = document.querySelector('p')!;
    const textRef = p.firstChild as Text;
    engine = startEngine();
    await flush();
    expect(p.querySelectorAll('hnw-mark')).toHaveLength(2);
    textRef.nodeValue = 'Officials scrutinize everything.';
    await flush();
    expect(p.textContent).toBe('Officials scrutinize everything.');
    expect([...p.querySelectorAll('hnw-mark')].map((m) => m.getAttribute('data-lemma'))).toEqual(['scrutinize']);
  });

  it('框架 removeChild(原文本节点) 不抛错，片段随之移除', async () => {
    document.body.innerHTML = '<p>Premise first, then abandon.</p>';
    const p = document.querySelector('p')!;
    const textRef = p.firstChild as Text;
    engine = startEngine();
    await flush();
    expect(p.querySelectorAll('hnw-mark')).toHaveLength(2);
    expect(() => p.removeChild(textRef)).not.toThrow();
    await flush();
    expect(p.textContent).toBe('');
    expect(textRef.data).toBe('Premise first, then abandon.');
  });

  it('框架移动原文本节点：片段文字拼回后在新位置重新高亮', async () => {
    document.body.innerHTML = '<p id="a">They abandoned it.</p><p id="b"></p>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const textRef = a.firstChild as Text;
    engine = startEngine();
    await flush();
    b.appendChild(textRef);
    await flush();
    expect(a.textContent).toBe('');
    expect(b.textContent).toBe('They abandoned it.');
    expect(b.querySelectorAll('hnw-mark')).toHaveLength(1);
  });
});

describe('熟词即时取消与原地复核', () => {
  it('removeLemma 立即移除该词条所有词形，文本保持不变', async () => {
    document.body.innerHTML = '<p>Run, he runs, she ran running to the premise.</p>';
    engine = startEngine();
    await flush();
    const before = document.querySelectorAll('hnw-mark[data-lemma="run"]').length;
    // Run/runs 必中；ran/running 取决于 lemma 实现
    expect(before).toBeGreaterThanOrEqual(2);
    engine.removeLemma('run');
    expect(document.querySelectorAll('hnw-mark[data-lemma="run"]')).toHaveLength(0);
    expect(document.querySelectorAll('hnw-mark[data-lemma="premise"]')).toHaveLength(1);
    expect(document.body.textContent).toBe('Run, he runs, she ran running to the premise.');
    expect(engine.matchedLemmas).toEqual(['premise']);
  });

  it('refreshMatches 用新 matcher 原地复核，释义同步保留', async () => {
    document.body.innerHTML = '<p>They abandoned the premise.</p>';
    engine = startEngine();
    await flush();
    engine.refreshMatches(matcherWith(['abandon']), dict);
    const marks = [...document.querySelectorAll('hnw-mark')];
    expect(marks.map((m) => m.getAttribute('data-lemma'))).toEqual(['premise']);
    expect(marks[0]!.querySelector('hnw-tr')?.getAttribute('data-tr')).toBe('前提');
    expect(document.body.textContent).toBe('They abandoned the premise.');
  });
});

describe('深色上下文', () => {
  it('父元素文字为浅色时打 data-hnw-dark', async () => {
    document.body.innerHTML = '<p style="color: rgb(230, 237, 243)">the premise</p><p style="color: rgb(20, 20, 20)">the premise</p>';
    engine = startEngine();
    await flush();
    const marks = [...document.querySelectorAll('hnw-mark')];
    expect(marks.map((m) => m.hasAttribute('data-hnw-dark'))).toEqual([true, false]);
  });
});

describe('颜色与样式', () => {
  it('ensureContrast 在深色背景上提亮过暗的文字色', () => {
    const bg = parseColor('#18181b')!;
    const fixed = ensureContrast('#2563eb', bg, 4.5)!;
    expect(fixed).toMatch(/^rgb/);
    expect(contrast(parseColor(fixed)!, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast('#ffffff', bg, 4.5)).toBeNull();
    expect(parseColor('#fa08')).toEqual({ r: 255, g: 170, b: 0, a: 136 / 255 });
  });

  it('buildPageCss：样式作用于 hnw-w，文字色主题生成深色上下文规则，释义来自属性', () => {
    const s = createDefaultSettings();
    s.style.themeId = 'ink';
    s.books.enabled = ['cet4'];
    const css = buildPageCss(s);
    expect(css).toContain('hnw-mark[data-book="cet4"]>hnw-w{');
    expect(css).toContain('hnw-mark[data-book="cet4"]:where([data-hnw-dark])>hnw-w{color:');
    expect(css).toContain('content:"(" attr(data-tr) ")"');
    expect(css).toContain('display:ruby');
  });
});

describe('shortenTranslation', () => {
  it('去掉领域标注与括注，只取一个义项并限长', () => {
    expect(shortenTranslation('a. [医]结晶的, 使晶状的')).toBe('结晶的');
    expect(shortenTranslation('n. 十字架, 十字架形物件')).toBe('十字架');
    expect(shortenTranslation('vt. (使)开化; 使文明')).toBe('开化');
    expect(shortenTranslation('n. 口语用法很长很长的一个义项')).toBe('口语用法很长…');
    expect(shortenTranslation('[计] ')).toBe('');
  });
});
