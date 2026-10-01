import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Dictionary } from '@/core/dict/types';
import { createDefaultSettings } from '@/core/settings/defaults';
import { HighlightEngine } from '@/content/engine/engine';
import { highlightTextNode } from '@/content/engine/highlighter';
import { layoutAffectingSettings, prehidePage } from '@/content/engine/prehide';

const book = createSetWordBook(
  { id: 'cet4', name: 'cet4', nameEn: 'cet4', short: '四级', kind: 'builtin', category: 'exam', level: 3, size: 0 },
  ['abandon', 'scrutinize', 'premise', 'tom', 'volatile', 'ambitious', 'skeptical'],
);
const matcher = () => new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book], known: new Set() });
/** 词频排名：数字越大越罕见 */
const RANKS: Record<string, number> = { abandon: 3000, premise: 9000, scrutinize: 12000, volatile: 7000, ambitious: 4000, skeptical: 8000 };
const dict: Dictionary = {
  lookup: async (w) => ({ word: w, short: '释义' }),
  lookupMany: async (ws) => new Map([...ws].map((w) => [w, { word: w, short: `${w}义`, rank: RANKS[w] }])),
};
const flush = () => new Promise((r) => setTimeout(r, 30));

function startEngine(mode: 'after' | 'ruby' = 'after'): HighlightEngine {
  const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: mode });
  engine.start();
  return engine;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('分词：非 ASCII 字母', () => {
  it('Tomás、naïve 这类含非 ASCII 字母的词整体跳过，不切出 Tom', () => {
    document.body.innerHTML = '<p>By Tomás and Tom, 3premise or premise2 then premise.</p>';
    const marks = highlightTextNode(document.querySelector('p')!.firstChild as Text, (w) => matcher().match(w));
    expect(marks.map((m) => m.textContent)).toEqual(['Tom', 'premise']);
    expect(document.querySelector('p')!.textContent).toBe('By Tomás and Tom, 3premise or premise2 then premise.');
  });
});

describe('行内括注：链接、标题与密度控制', () => {
  it('标题内的 mark 在 ruby 模式不预留占位注解；链接内与正文一样预留', async () => {
    document.body.innerHTML = '<h2>The premise</h2><p>See <a href="#">abandon</a> and premise.</p>';
    const engine = startEngine('ruby');
    const [h, a, p] = [...document.querySelectorAll('hnw-mark')];
    expect(a!.hasAttribute('data-hnw-link')).toBe(true);
    expect(h!.querySelector('hnw-tr')).toBeNull();
    // 链接内、正文 mark 都在创建的同一帧预留注解
    expect(a!.querySelector('hnw-tr')).not.toBeNull();
    expect(p!.querySelector('hnw-tr')).not.toBeNull();
    engine.stop();
  });

  it('同一段落里同一词条只给第一次出现的加括注', async () => {
    document.body.innerHTML = '<p>They abandon it, then abandon it again; the premise holds.</p><p>We abandon it.</p>';
    const engine = startEngine();
    await flush();
    const marks = [...document.querySelectorAll('p:first-child hnw-mark')];
    expect(marks.map((m) => m.hasAttribute('data-hnw-nogloss'))).toEqual([false, true, false]);
    // 不同段落各自独立
    expect(document.querySelector('p:last-child hnw-mark')!.hasAttribute('data-hnw-nogloss')).toBe(false);
    engine.stop();
  });

  it('窄屏按段落字数限制括注数量，优先保留更罕见的词', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    // 约 60 个字符、4 个生词 -> 窄屏只保留 1 个：最罕见的 scrutinize
    document.body.innerHTML = '<p>Abandon the volatile premise; scrutinize it, be ambitious.</p>';
    const engine = startEngine();
    await flush();
    const kept = [...document.querySelectorAll('hnw-mark:not([data-hnw-nogloss])')].map((m) => m.getAttribute('data-lemma'));
    expect(kept).toEqual(['scrutinize']);
    // 被省略的仍然高亮
    expect(document.querySelectorAll('hnw-mark').length).toBe(5);
    engine.stop();
  });

  it('宽屏不限密度', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    document.body.innerHTML = '<p>Abandon the volatile premise; scrutinize it, be ambitious.</p>';
    const engine = startEngine();
    await flush();
    expect(document.querySelectorAll('hnw-mark[data-hnw-nogloss]').length).toBe(0);
    engine.stop();
  });
});

describe('首屏预隐藏', () => {
  it('primeFirstScreen 立即写入视口内的译文（不等懒插入）', async () => {
    document.body.innerHTML = '<p>They abandoned the premise.</p>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 30, left: 0, right: 50, width: 50, height: 20, x: 0, y: 10, toJSON: () => ({}) });
    // 永不回调的 IntersectionObserver：没有 primeFirstScreen 时译文只会等懒插入
    class NeverIO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', NeverIO);
    const engine = startEngine();
    await flush();
    expect(document.querySelectorAll('hnw-tr[data-tr]').length).toBe(0);
    await engine.primeFirstScreen();
    expect([...document.querySelectorAll('hnw-tr')].map((t) => t.getAttribute('data-tr'))).toEqual(['abando…', 'premis…']);
    engine.stop();
    vi.unstubAllGlobals();
  });

  it('只有改变排版的设置才需要预隐藏；隐藏样式未生效时不处理', () => {
    const s = createDefaultSettings();
    s.inlineTranslation.mode = 'off';
    s.style.themeId = 'wavy-line';
    expect(layoutAffectingSettings(s)).toBe(false);
    s.style.themeId = 'bold-accent';
    expect(layoutAffectingSettings(s)).toBe(true);
    s.style.themeId = 'wavy-line';
    s.inlineTranslation.mode = 'ruby';
    expect(layoutAffectingSettings(s)).toBe(true);
    // 隐藏样式未注册（未生效）时为空操作：不加 data-hnw-ready
    prehidePage(document)();
    expect(document.documentElement.hasAttribute('data-hnw-ready')).toBe(false);
  });
});

describe('数据接入：连字符前缀、动词释义、代码熟词屈折形式', () => {
  const book2 = createSetWordBook(
    { id: 'x', name: 'x', nameEn: 'x', short: 'x', kind: 'builtin', category: 'exam', level: 3, size: 0 },
    ['vice', 'president', 'advocate', 'module', 'premise'],
  );
  const m2 = () => new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book2], known: new Set() });

  it('词-词 结构中的构词前缀不单独高亮', () => {
    document.body.innerHTML = '<p>The vice-president met the vice squad.</p>';
    const marks = highlightTextNode(document.querySelector('p')!.firstChild as Text, (w) => m2().match(w));
    expect(marks.map((m) => m.textContent)).toEqual(['president', 'vice']);
  });

  it('动词变形使用原形的动词释义', async () => {
    document.body.innerHTML = '<p>They are advocating it; an advocate agrees.</p>';
    const d: Dictionary = {
      lookup: async (w) => ({ word: w }),
      lookupMany: async (ws) => new Map([...ws].filter((w) => w === 'advocate').map((w) => [w, { word: w, short: 'n. 提倡者', shortVerb: '提倡' }])),
    };
    const engine = new HighlightEngine({ root: document.body, matcher: m2(), dictionary: d, inlineTranslation: 'after' });
    engine.start();
    await flush();
    expect([...document.querySelectorAll('hnw-tr')].map((t) => t.getAttribute('data-tr'))).toEqual(['提倡', '提倡者']);
    engine.stop();
  });

  it('代码本体中编程熟词的屈折形式不高亮', () => {
    document.body.innerHTML = '<pre><code>loadModules(premises)</code></pre>';
    const t = document.querySelector('code')!.firstChild as Text;
    const marks = highlightTextNode(t, (w) => m2().match(w), undefined, { code: 'identifier' });
    expect(marks.map((m) => m.textContent)).toEqual(['premises']);
  });
});

describe('固定搭配义', () => {
  it('相邻词构成搭配时改用搭配义，跨标点不算', async () => {
    const b = createSetWordBook(
      { id: 'y', name: 'y', nameEn: 'y', short: 'y', kind: 'builtin', category: 'exam', level: 3, size: 0 },
      ['surge', 'concrete'],
    );
    const m = new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [b], known: new Set() });
    const d: Dictionary = {
      lookup: async (w) => ({ word: w }),
      lookupMany: async (ws) => new Map([...ws].map((w) => [w, { word: w, short: w === 'surge' ? '激增' : '具体的' }])),
    };
    document.body.innerHTML = '<p>The storm surge hit concrete structures. A storm. Surge again, concrete!</p>';
    const engine = new HighlightEngine({ root: document.body, matcher: m, dictionary: d, inlineTranslation: 'after' });
    engine.start();
    await flush();
    const trs = [...document.querySelectorAll('hnw-mark')].map((x) => x.querySelector('hnw-tr')?.getAttribute('data-tr'));
    // storm surge、concrete structures 命中搭配；句号隔开的 “storm. Surge” 与句末 “concrete!” 用词典首选义
    expect(trs).toEqual(['风暴潮', '混凝土', '激增', '具体的']);
    engine.stop();
  });
});

describe('flex 容器中的空格', () => {
  it('flex 容器的直接子文本切开后空格会被折叠：撤销该段高亮；单独成段的词照常高亮', async () => {
    document.body.innerHTML = '<a style="display:flex" id="f">Print premise now</a><a style="display:flex" id="g">premise</a><p id="p">Print premise now</p>';
    const engine = startEngine();
    await flush();
    expect(document.querySelector('#f hnw-mark')).toBeNull();
    expect(document.querySelector('#f')!.childNodes.length).toBe(1);
    expect(document.querySelector('#f')!.textContent).toBe('Print premise now');
    expect(document.querySelector('#g hnw-mark')).not.toBeNull();
    expect(document.querySelector('#p hnw-mark')).not.toBeNull();
    engine.stop();
  });
});
