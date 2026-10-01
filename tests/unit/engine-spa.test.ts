import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('页面删除未进入视口的 mark：懒插入观察者停止持有（E4）', () => {
  /** 记录被观察节点的 IntersectionObserver 替身：永不回调（模拟一直在视口外） */
  class RecordingIO {
    static held = new Set<Element>();
    observe = vi.fn((el: Element) => RecordingIO.held.add(el));
    unobserve = vi.fn((el: Element) => RecordingIO.held.delete(el));
    disconnect() {
      RecordingIO.held.clear();
    }
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    RecordingIO.held.clear();
  });

  it('大量删除含 mark 的子树后，observer 不再持有这些节点；被移动（仍在文档中）的保留观察', async () => {
    vi.stubGlobal('IntersectionObserver', RecordingIO);
    const paras = Array.from({ length: 200 }, (_, i) => `<p>item ${i}: abandon the premise</p>`).join('');
    document.body.innerHTML = `<div id="feed">${paras}</div><div id="keep"><p>scrutinize it</p></div><section id="dst"></section>`;
    engine = startEngine();
    // 扫描按时间片分批进行，等全部处理完
    for (let i = 0; i < 50 && document.querySelectorAll('#feed hnw-mark').length < 400; i++) await flush();
    await flush();
    const feedMarks = [...document.querySelectorAll('#feed hnw-mark')];
    expect(feedMarks.length).toBe(400);
    expect(feedMarks.every((m) => RecordingIO.held.has(m))).toBe(true);
    const kept = document.querySelector('#keep hnw-mark')!;
    expect(RecordingIO.held.has(kept)).toBe(true);

    document.getElementById('feed')!.remove();
    // 移动：同一批 mutation 中先删后插，节点仍在文档中，译文之后还要写入
    document.getElementById('dst')!.appendChild(document.getElementById('keep')!);
    await flush();
    expect(feedMarks.some((m) => RecordingIO.held.has(m))).toBe(false);
    expect(RecordingIO.held.has(kept)).toBe(true);
    expect(RecordingIO.held.size).toBe(1);
  });

  it('页面直接删除/改写原文本节点（还原/丢弃切分组）时同样停止观察片段中的 mark', async () => {
    vi.stubGlobal('IntersectionObserver', RecordingIO);
    document.body.innerHTML = '<p id="a">They abandon it.</p><p id="b">A premise here.</p>';
    engine = startEngine();
    await flush();
    await flush();
    const [ma, mb] = [document.querySelector('#a hnw-mark')!, document.querySelector('#b hnw-mark')!];
    expect(RecordingIO.held.has(ma) && RecordingIO.held.has(mb)).toBe(true);
    // 框架删除自己持有的原文本节点（片段被拼回、mark 被移除）
    (document.getElementById('a')!.firstChild as Text).remove();
    // 框架改写原文本节点内容（旧片段被丢弃）
    (document.getElementById('b')!.firstChild as Text).data = 'nothing to see';
    await flush();
    expect(RecordingIO.held.has(ma)).toBe(false);
    expect(RecordingIO.held.has(mb)).toBe(false);
  });

  it('摘下的子树在下一批 mutation 后重新挂回：未写入译文的 mark 恢复观察，已写入的不重复观察', async () => {
    vi.stubGlobal('IntersectionObserver', RecordingIO);
    document.body.innerHTML = '<p id="near">They abandon it.</p><div id="far"><p>A premise and scrutinize.</p></div>';
    engine = startEngine();
    await flush();
    await flush();
    const near = document.querySelector('#near hnw-mark')!;
    const farMarks = [...document.querySelectorAll('#far hnw-mark')];
    expect(farMarks).toHaveLength(2);
    // 模拟 #near 已进入视口并写入译文
    RecordingIO.held.delete(near);
    near.appendChild(document.createElement('hnw-tr'));

    // 虚拟列表 / keep-alive：先摘下（下一批 mutation 才挂回）
    const far = document.getElementById('far')!;
    far.remove();
    await flush();
    expect(farMarks.some((m) => RecordingIO.held.has(m))).toBe(false);
    document.body.appendChild(far);
    // 已写入译文的 mark 随父节点一同被挂回时不应被重新观察
    const nearP = document.getElementById('near')!;
    nearP.remove();
    document.body.appendChild(nearP);
    await flush();
    expect(farMarks.every((m) => RecordingIO.held.has(m))).toBe(true);
    expect(RecordingIO.held.has(near)).toBe(false);
  });
});
