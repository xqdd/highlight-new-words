import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Dictionary } from '@/core/dict/types';
import { HighlightEngine, shortenTranslation } from '@/content/engine/engine';
import { highlightTextNode, unwrapAll } from '@/content/engine/highlighter';
import { collectTextNodes } from '@/content/engine/scanner';
import { createDefaultReadingSettings } from '@/core/reading/settings';
import { normalizeSettings } from '@/core/settings/migrate';
import { trackScrollActivity } from '@/content/scroll-activity';

const book = createSetWordBook(
  { id: 'cet4', name: 'cet4', nameEn: 'cet4', short: '四级', kind: 'builtin', category: 'exam', level: 3, size: 0 },
  ['abandon', 'scrutinize', 'premise'],
);
const matcher = () => new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book], known: new Set() });
const dict: Dictionary = {
  lookup: async (w) => ({ word: w, short: 'v. 放弃；抛弃' }),
  lookupMany: async (ws) => new Map([...ws].map((w) => [w, { word: w, short: 'v. 放弃；抛弃' }])),
};
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('scanner', () => {
  it('跳过 script/code/input/contenteditable 与自身节点', () => {
    document.body.innerHTML = `<p>abandon here</p><code>abandon</code><script>var abandon</script>
      <div contenteditable="true">abandon</div><hnw-mark>abandon</hnw-mark><textarea>abandon</textarea>`;
    const texts = collectTextNodes(document.body).map((t) => t.data);
    expect(texts).toEqual(['abandon here']);
  });
});

describe('highlightTextNode', () => {
  it('保留原文本节点并包裹命中词，可还原', () => {
    document.body.innerHTML = '<p>They abandoned the premise quickly.</p>';
    const p = document.querySelector('p')!;
    const original = p.firstChild as Text;
    const marks = highlightTextNode(original, (w) => matcher().match(w));
    expect(marks.map((m) => m.textContent)).toEqual(['abandoned', 'premise']);
    expect(marks[0]!.getAttribute('data-lemma')).toBe('abandon');
    expect(p.firstChild).toBe(original);
    expect(p.textContent).toBe('They abandoned the premise quickly.');
    unwrapAll(document.body);
    expect(p.querySelector('hnw-mark')).toBeNull();
    expect(p.textContent).toBe('They abandoned the premise quickly.');
  });
});

describe('HighlightEngine', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p>They abandoned the premise.</p>';
  });

  it('全量扫描、增量插入、行内翻译与停止', async () => {
    const reported: string[][] = [];
    const engine = new HighlightEngine({
      root: document.body,
      matcher: matcher(),
      dictionary: dict,
      inlineTranslation: 'after',
      onLemmasChanged: (l) => reported.push(l),
    });
    engine.start();
    await flush();
    expect(document.querySelectorAll('hnw-mark').length).toBe(2);
    expect(document.querySelector('hnw-mark hnw-tr')?.getAttribute('data-tr')).toBe('放弃');
    expect(document.querySelector('hnw-mark')?.textContent).toBe('abandoned');

    const div = document.createElement('div');
    div.textContent = 'Officials scrutinized it.';
    document.body.appendChild(div);
    await flush();
    expect(div.querySelector('hnw-mark')?.getAttribute('data-lemma')).toBe('scrutinize');
    expect(new Set(engine.matchedLemmas)).toEqual(new Set(['abandon', 'premise', 'scrutinize']));

    engine.removeLemma('premise');
    expect(document.querySelectorAll('hnw-mark[data-lemma="premise"]').length).toBe(0);

    engine.stop();
    expect(document.querySelectorAll('hnw-mark').length).toBe(0);
    expect(document.body.textContent).toContain('They abandoned the premise.');
  });
});

describe('shortenTranslation', () => {
  it('取第一个义项并去词性', () => {
    expect(shortenTranslation('vt. 放弃, 抛弃')).toBe('放弃');
  });
});

describe('生词视口预读', () => {
  it('零盒 display:contents 转交有盒祖先，跨容器移动后重新观察且不漏生词', async () => {
    const observers: FakeObserver[] = [];
    class FakeObserver {
      targets = new Set<Element>();
      constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      report(target: Element, isIntersecting: boolean) {
        this.callback([{ target, isIntersecting, boundingClientRect: { width: 0, height: 0 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    document.body.innerHTML = '<main><section style="display:contents"><span id="text" style="display:contents">abandon the premise</span></section></main><article></article>';
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'off' });
    try {
      engine.start(); await flush();
      const viewport = observers[0]!;
      const text = document.querySelector('#text')!;
      const main = document.querySelector('main')!;
      const article = document.querySelector('article')!;
      viewport.report(text, false);
      expect(viewport.targets.has(text)).toBe(false);
      expect(viewport.targets.has(main)).toBe(true);
      // 还没进入旧祖先视口就移动，旧祖先的待处理文字必须能随新位置重新发现。
      article.append(text); await flush();
      expect(viewport.targets.has(text)).toBe(true);
      viewport.report(text, false);
      expect(viewport.targets.has(article)).toBe(true);
      viewport.report(article, true); await flush();
      expect(text.querySelectorAll('hnw-mark')).toHaveLength(2);
      expect(main.querySelector('hnw-mark')).toBeNull();
      expect(text.textContent).toBe('abandon the premise');
      engine.stop();
      expect(text.textContent).toBe('abandon the premise');
      expect(text.querySelector('hnw-mark')).toBeNull();
    } finally { engine.stop(); vi.unstubAllGlobals(); }
  });

  it('先发现全文，随机跳转只包装目标区域；移除、重挂及框架文字更新仍可处理', async () => {
    const observers: FakeObserver[] = [];
    class FakeObserver {
      targets = new Set<Element>();
      constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      enter(target: Element) {
        this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    document.body.innerHTML = '<p id="top">abandon the premise</p><p id="bottom">scrutinize the premise</p>';
    const original = document.body.textContent;
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'off' });
    try {
      engine.start();
      await flush();
      const viewport = observers[0]!;
      const top = document.querySelector('#top')!;
      const bottom = document.querySelector('#bottom')!;
      expect(viewport.targets.has(top)).toBe(true);
      expect(viewport.targets.has(bottom)).toBe(true);
      expect(document.querySelectorAll('hnw-mark')).toHaveLength(0);
      viewport.enter(bottom);
      await flush();
      expect(bottom.querySelectorAll('hnw-mark')).toHaveLength(2);
      expect(top.querySelectorAll('hnw-mark')).toHaveLength(0);
      top.remove();
      await flush();
      expect(viewport.targets.has(top)).toBe(false);
      document.body.append(top);
      await flush();
      expect(viewport.targets.has(top)).toBe(true);
      viewport.enter(top);
      await flush();
      expect(top.querySelectorAll('hnw-mark')).toHaveLength(2);
      const owner = top.firstChild as Text;
      owner.data = 'scrutinize everything';
      await flush();
      expect(top.textContent).toBe('scrutinize everything');
      expect(top.querySelector('hnw-mark')?.getAttribute('data-lemma')).toBe('scrutinize');
      engine.stop();
      expect(document.querySelectorAll('hnw-mark')).toHaveLength(0);
      expect(observers.every(observer => observer.targets.size === 0)).toBe(true);
      expect(original).toContain('abandon the premise');
    } finally {
      engine.stop();
      vi.unstubAllGlobals();
    }
  });
});

describe('滚动期间延迟译文写入', () => {
  it('异步启动前已发生输入时，首片和 prime 均让出，停稳后再补标', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>abandon the premise</p>';
    const release = trackScrollActivity(window);
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'after' });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    try {
      window.dispatchEvent(new Event('wheel'));
      engine.start();
      await engine.primeFirstScreen();
      expect(document.querySelector('hnw-mark')).toBeNull();
      expect(geometry).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60);
      expect(document.querySelector('hnw-mark')).toBeNull();
      window.dispatchEvent(new Event('touchmove'));
      await vi.advanceTimersByTimeAsync(60);
      expect(document.querySelector('hnw-mark')).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      expect(document.querySelectorAll('hnw-mark')).toHaveLength(2);
      expect(document.querySelectorAll('hnw-tr[data-tr]')).toHaveLength(2);
    } finally { engine.stop(); release(); geometry.mockRestore(); vi.useRealTimers(); }
  });

  it('词典异步返回后仍等待最后一次滚动输入停稳，再一次补齐译文', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>abandon the premise</p>';
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    const dictionary: Dictionary = { ...dict, lookupMany: async words => { await response; return dict.lookupMany(words); } };
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary, inlineTranslation: 'after' });
    try {
      engine.start();
      window.dispatchEvent(new Event('wheel'));
      release();
      await vi.advanceTimersByTimeAsync(60);
      expect(document.querySelectorAll('hnw-mark')).toHaveLength(2);
      expect(document.querySelector('hnw-tr')).toBeNull();
      expect(document.querySelector('[data-hnw-nogloss]')).toBeNull();
      window.dispatchEvent(new Event('touchmove'));
      await vi.advanceTimersByTimeAsync(60);
      expect(document.querySelector('hnw-tr')).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      expect(document.querySelectorAll('hnw-tr[data-tr]')).toHaveLength(2);
    } finally { engine.stop(); vi.useRealTimers(); }
  });

  it.each(['off', 'stop'])('等待期间 %s 不会在停稳后补写旧译文', async action => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>abandon the premise</p>';
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'off' });
    try {
      engine.start();
      window.dispatchEvent(new Event('wheel'));
      engine.setInlineTranslation('after');
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('hnw-tr')).toBeNull();
      if (action === 'stop') engine.stop(); else engine.setInlineTranslation('off');
      await vi.advanceTimersByTimeAsync(200);
      expect(document.querySelector('hnw-tr')).toBeNull();
      if (action === 'stop') expect(document.querySelector('hnw-mark')).toBeNull();
    } finally { engine.stop(); vi.useRealTimers(); }
  });
});

describe('独立生词标记范围', () => {
  const scope = () => ({ ...createDefaultReadingSettings().scope, enabled: true });
  it('默认关闭，配置与阅读范围独立归一化', () => {
    const defaults = normalizeSettings({});
    expect(defaults.highlightScope.enabled).toBe(false);
    const settings = normalizeSettings({ highlightScope: { enabled: true, minWords: 5 }, reading: { scope: { minWords: 8 } } });
    expect(settings.highlightScope.minWords).toBe(5);
    expect(settings.reading.scope.minWords).toBe(8);
    expect(settings.highlightScope.skipMetadata).toBe(true);
    expect(normalizeSettings(settings).highlightScope).toEqual(settings.highlightScope);
  });

  it('分别过滤零散文字，保留跨行内节点的正文；关闭后恢复旧行为', async () => {
    document.body.innerHTML = `<p id="short">premise</p><p id="link"><a href="#">abandon the premise</a></p>
      <p id="prose">They <a href="#">abandon</a> the premise.</p><button>abandon the premise</button>
      <nav>abandon the premise</nav><p class="byline">abandon the premise</p>
      <p id="lines">They abandon the premise.<br><span>premise</span></p>`;
    const original = document.body.textContent;
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'off', highlightScope: scope() });
    engine.start(); await flush();
    await vi.waitFor(() => expect(document.querySelectorAll('#prose hnw-mark').length).toBe(2));
    await vi.waitFor(() => expect(document.querySelectorAll('#lines hnw-mark').length).toBe(2));
    expect(document.querySelectorAll('#short hnw-mark,#link hnw-mark,button hnw-mark,nav hnw-mark,.byline hnw-mark,#lines span hnw-mark').length).toBe(0);
    engine.setScope({ ...scope(), enabled: false }); await flush();
    await vi.waitFor(() => expect(document.querySelector('#short hnw-mark')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('button hnw-mark')).not.toBeNull());
    engine.stop(); expect(document.body.textContent).toBe(original);
  });

  it('动态增删相邻文本跨过阈值时重新评估整段，刷新不重新引入过滤词', async () => {
    document.body.innerHTML = '<p>premise</p>';
    const p = document.querySelector('p')!;
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'off', highlightScope: scope() });
    engine.start(); await flush(); expect(p.querySelector('hnw-mark')).toBeNull();
    const span = document.createElement('span'); span.textContent = ' they scrutinize'; p.append(span);
    await vi.waitFor(() => expect(p.querySelectorAll('hnw-mark').length).toBe(2));
    span.remove(); await vi.waitFor(() => expect(p.querySelector('hnw-mark')).toBeNull());
    engine.refreshMatches(matcher(), dict); await flush(); expect(p.querySelector('hnw-mark')).toBeNull();
    engine.stop(); expect(p.textContent).toBe('premise');
  });

  it('新增相邻评论不重建已有段落的标记', async () => {
    document.body.innerHTML = '<main><p>They abandon the premise.</p></main>';
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'off', highlightScope: scope() });
    engine.start(); await vi.waitFor(() => expect(document.querySelector('hnw-mark')).not.toBeNull());
    const mark = document.querySelector('hnw-mark');
    const p = document.createElement('p'); p.textContent = 'They scrutinize the premise.';
    document.querySelector('main')!.append(p); await flush();
    expect(document.querySelector('hnw-mark')).toBe(mark);
    await vi.waitFor(() => expect(p.querySelectorAll('hnw-mark').length).toBe(2));
    engine.stop();
  });
});
