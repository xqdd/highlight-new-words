import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingVisual } from '@/content/reading/visual';
import { createReadingTools } from '@/content/reading';
import { analyzeReading } from '@/core/reading/analyze';
import { createDefaultReadingSettings, READING_MARK_STYLES, type ReadingSettings } from '@/core/reading/settings';
import { HighlightEngine } from '@/content/engine/engine';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';

const flush = () => new Promise((resolve) => setTimeout(resolve, 100));
const active: Array<{ stop(): void }> = [];
afterEach(() => { active.splice(0).reverse().forEach((item) => item.stop()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function visual(bionic: Partial<ReadingSettings['bionic']> = {}, configure?: (settings: ReadingSettings) => void) {
  const settings = createDefaultReadingSettings();
  settings.enabled = true;
  settings.syntax.enabled = true;
  settings.syntax.nouns = true;
  settings.bionic.enabled = true;
  settings.emphasis.negation = true;
  settings.emphasis.numbers = true;
  Object.assign(settings.bionic, bionic);
  configure?.(settings);
  const result = new ReadingVisual(document.body, settings);
  active.push(result);
  result.start();
  return result;
}
function engine() {
  const book = createSetWordBook({ id: 'cet4', name: 'test', nameEn: 'test', short: 'test', kind: 'builtin', category: 'exam', level: 3, size: 0 }, ['record', 'music']);
  const matcher = new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book], known: new Set() });
  const dictionary = { lookup: async (word: string) => ({ word, short: '词' }), lookupMany: async () => new Map() };
  const result = new HighlightEngine({ root: document.body, matcher, dictionary, inlineTranslation: 'off' });
  active.push(result);
  result.start();
  return { result, matcher, dictionary };
}

describe('本地阅读分析', () => {
  it('覆盖代词、限定词、序数词、介词与连词，并保留精确原文偏移', () => {
    const text = 'He was the first to travel from London to Paris, and she followed because they agreed.';
    const tokens = analyzeReading(text);
    for (const [word, pos] of [['He', 'pronoun'], ['the', 'determiner'], ['first', 'numeral'], ['from', 'preposition'], ['and', 'conjunction'], ['she', 'pronoun']]) {
      expect(tokens.find(token => token.text === word)?.pos).toBe(pos);
    }
    expect(tokens.filter(token => token.text === 'to').map(token => token.pos)).toEqual(['particle', 'preposition']);
    expect(tokens.find(token => token.text === 'first')?.emphasis).toBe('numbers');
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });
  it('在同一句中按上下文区分 record 动词与名词，保留原文偏移', () => {
    const tokens = analyzeReading('They record a record.');
    expect(tokens.filter((token) => token.text === 'record').map((token) => token.pos)).toEqual(['verb', 'noun']);
    expect(tokens.find((token) => token.start === 14)?.text).toBe('record');
  });
  it('识别否定、转折和数字，不把它们称为句法主干', () => {
    expect(analyzeReading("However, they don't need 42%.", false).filter((token) => token.emphasis).map((token) => token.emphasis)).toEqual(['connectives', 'negation', 'numbers']);
  });
  it('从上下文词性标签识别专名，而不是把所有首字母大写词当作专名', () => {
    const tokens = analyzeReading('They visited London yesterday.');
    expect(tokens.find((token) => token.text === 'London')?.properNoun).toBe(true);
    expect(tokens.find((token) => token.text === 'They')?.properNoun).toBe(false);
  });
});

describe('ReadingVisual', () => {
  it('多行正文中的短标签、链接、话题列表和章节索引分别过滤，正常行内引用保留', async () => {
    document.body.innerHTML = '<article><div id="description" style="white-space:pre-wrap">They record music with friends.\nTOOLS\n'
      + '<a id="url" href="https://example.com/docs">https://example.com/full/documentation</a>\n'
      + '<a id="chapter" href="#chapter">0:30</a> They record music together\n'
      + '<span id="tags">#music #reading #english</span>\n'
      + '<span id="handles">@reading @english @music</span>\n'
      + '<span id="prose">They use <a id="reference" href="/reference">the English reference</a> with friends.</span></div>'
      + '<p id="br">They record music.<br><span id="short">Settings</span><br><a id="br-link" href="/docs">Read the complete documentation</a></p>'
      + '<p id="source-newline">They\n<span>record\nmusic with friends.</span></p>'
      + '<div role="toolbar"><p>Share this article with friends</p></div><div role="status"><p>They record music.</p></div>'
      + '<div role="tablist"><p>They record music.</p></div><div class="post-taglist"><p>They record music.</p></div>'
      + '<ul><li id="list">They record music with friends.</li></ul><p id="inline-date">They arrived at <time>12:30</time> and recorded music.</p></article>';
    const before = document.body.textContent;
    const v = visual();
    await vi.waitFor(() => expect(document.querySelector('#prose [data-pos]')).not.toBeNull());
    expect(document.querySelector('#reference [data-pos]')).not.toBeNull();
    expect(document.querySelector('#url hnw-read,#chapter hnw-read,#tags hnw-read,#handles hnw-read,#short hnw-read,#br-link hnw-read,[role] hnw-read,.post-taglist hnw-read')).toBeNull();
    expect([...document.querySelectorAll('#description [data-pos]')].some(el => el.textContent === 'TOOLS')).toBe(false);
    for (const selector of ['#source-newline', '#list', '#inline-date']) await vi.waitFor(() => expect(document.querySelector(`${selector} [data-pos]`)).not.toBeNull());
    expect(document.body.textContent).toBe(before);
    v.stop(); expect(document.body.textContent).toBe(before);
  });

  it('关闭辅助信息及短文本/链接过滤后，可标记索引内容，隐藏和编辑区仍排除', async () => {
    document.body.innerHTML = '<article><div style="white-space:pre-wrap"><span id="tags">#music #reading #english</span>\n'
      + '<span id="short">Music</span>\n<a id="url" href="/docs">Read the complete documentation</a></div>'
      + '<div role="toolbar"><p>They record music.</p></div><div role="status" hidden><p>They record music.</p></div>'
      + '<div role="toolbar" contenteditable="true"><p>They record music.</p></div></article>';
    const v = visual({}, settings => { settings.scope.skipMetadata = false; settings.scope.skipShortBlocks = false; settings.scope.skipStandaloneLinks = false; });
    await vi.waitFor(() => {
      for (const selector of ['#tags', '#short', '#url', '[role="toolbar"]:not([contenteditable])']) expect(document.querySelector(`${selector} :is([data-pos],[data-bionic])`), selector).not.toBeNull();
    });
    expect(document.querySelector('[hidden] hnw-read,[contenteditable] hnw-read')).toBeNull(); v.stop();
  });

  it('按钮和导航可分别放行，实时切换不破坏控件点击与原文还原', async () => {
    document.body.innerHTML = '<button id="button"><span>They record music.</span></button><div role="button" id="role-button">They record music.</div>'
      + '<nav><a id="nav-link" href="#music">They record music.</a></nav><div role="navigation"><span>They record music.</span></div>'
      + '<header>They record music.</header><footer>They record music.</footer><aside>They record music.</aside><div role="menu">They record music.</div>'
      + '<button hidden>They record music.</button><nav contenteditable="true">They record music.</nav>';
    const before = document.body.textContent;
    const button = document.querySelector('#button')!;
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    const settings = createDefaultReadingSettings(); settings.enabled = true; settings.syntax.enabled = true;
    settings.scope.skipStandaloneLinks = false;
    const v = new ReadingVisual(document.body, settings); active.push(v); v.start();
    await flush();
    expect(document.querySelector('[data-pos]')).toBeNull();
    settings.scope.skipButtons = false; v.update(settings);
    await vi.waitFor(() => expect(document.querySelector('#button [data-pos]')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('#role-button [data-pos]')).not.toBeNull());
    expect(document.querySelector('nav [data-pos],[role="navigation"] [data-pos]')).toBeNull();
    (button.querySelector('[data-pos]') as HTMLElement).click(); expect(clicked).toHaveBeenCalledOnce();
    settings.scope.skipButtons = true; settings.scope.skipNavigation = false; v.update(settings);
    await vi.waitFor(() => {
      for (const selector of ['#nav-link', '[role="navigation"]', 'header', 'footer', 'aside', '[role="menu"]']) {
        expect(document.querySelector(`${selector} [data-pos]`), selector).not.toBeNull();
      }
    });
    expect(document.querySelector('button [data-pos],[role="button"] [data-pos],[contenteditable] [data-pos]')).toBeNull();
    const added = document.createElement('button'); added.textContent = 'They record music.'; document.body.append(added);
    settings.scope.skipButtons = false; v.update(settings);
    await vi.waitFor(() => expect(added.querySelector('[data-pos]')).not.toBeNull());
    const dynamic = document.createElement('button'); dynamic.textContent = 'They record music.'; document.body.append(dynamic);
    await vi.waitFor(() => expect(dynamic.querySelector('[data-pos]')).not.toBeNull());
    v.stop();
    expect(document.body.textContent).toBe(before + 'They record music.They record music.');
    expect(document.querySelector('hnw-read')).toBeNull();
    expect(document.querySelector('#button')).toBe(button);
  });

  it('阅读生命周期停稳后应用范围修改，关闭即时撤销旧标记', async () => {
    document.body.innerHTML = '<article><h2>They record music.</h2><p>They record music.</p></article>';
    const tools = createReadingTools(document); active.push(tools);
    const settings = createDefaultReadingSettings(); settings.enabled = true; settings.syntax.enabled = true;
    tools.update(settings);
    await vi.waitFor(() => expect(document.querySelector('h2 [data-pos]')).not.toBeNull());
    settings.scope.skipHeadings = true;
    tools.update(settings);
    await vi.waitFor(() => {
      expect(document.querySelector('h2 hnw-read')).toBeNull();
      expect(document.querySelector('p [data-pos]')).not.toBeNull();
    });
    settings.scope.minWords = 8;
    tools.update(settings);
    await vi.waitFor(() => expect(document.querySelector('hnw-read')).toBeNull());
    settings.scope.skipShortBlocks = false;
    tools.update(settings);
    await vi.waitFor(() => expect(document.querySelector('p [data-pos]')).not.toBeNull());
    settings.enabled = false;
    tools.update(settings);
    expect(document.querySelector('hnw-read')).toBeNull();
  });

  it('默认跳过孤立单词和整块链接，正文内链接与连字符/斜杠词仍完整标记', async () => {
    document.body.innerHTML = '<article><p id="single">Settings</p><p id="link"><a href="/docs">Read the full documentation here</a></p>'
      + '<p id="body">Use a <a href="/hook">pre-review</a> hook with MCP/HTTP/CLI contributors.</p><button>Review this document</button></article>';
    const before = document.body.textContent;
    const link = document.querySelector('#body a')!;
    const v = visual();
    await vi.waitFor(() => expect(document.querySelector('#body [data-pos]')).not.toBeNull());
    expect(document.querySelector('#single hnw-read,#link hnw-read,button hnw-read')).toBeNull();
    for (const word of ['pre', 'review', 'MCP', 'HTTP', 'CLI']) {
      expect([...document.querySelectorAll('#body [data-pos]')].some(mark => mark.textContent === word), word).toBe(true);
    }
    expect(document.querySelector('#body a')).toBe(link);
    expect(document.body.textContent).toBe(before);
    v.stop();
    expect(document.body.textContent).toBe(before);
    expect(document.querySelector('hnw-read')).toBeNull();
  });

  it('短文本和独立链接可分别放行，阈值按段而不是行内节点计数', async () => {
    document.body.innerHTML = '<article><p id="single">Settings</p><p id="link"><a href="/docs">Read the full documentation here</a></p>'
      + '<p id="split"><span>They </span><a href="/music">record</a><strong> music.</strong></p></article>';
    const v = visual({}, s => { s.scope.skipShortBlocks = false; });
    await vi.waitFor(() => expect(document.querySelector('#single [data-pos]')).not.toBeNull());
    expect(document.querySelector('#link hnw-read')).toBeNull();
    const settings = createDefaultReadingSettings();
    settings.enabled = true; settings.syntax.enabled = true; settings.scope.minWords = 3; settings.scope.skipStandaloneLinks = false;
    v.update(settings);
    await vi.waitFor(() => expect(document.querySelector('#link [data-pos]')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelectorAll('#split [data-pos]')).toHaveLength(3));
    expect(document.querySelector('#single hnw-read')).toBeNull();
  });

  it('标题与表格过滤可切换，缩短动态正文时撤掉旧标记', async () => {
    document.body.innerHTML = '<article><h2>They record music.</h2><table><tbody><tr><td>They record music.</td></tr></tbody></table><p>They record music.</p></article>';
    const v = visual({}, s => { s.scope.skipHeadings = true; s.scope.skipTables = true; });
    await vi.waitFor(() => expect(document.querySelector('p [data-pos]')).not.toBeNull());
    expect(document.querySelector('h2 hnw-read,td hnw-read')).toBeNull();
    const settings = createDefaultReadingSettings(); settings.enabled = true; settings.syntax.enabled = true;
    v.update(settings);
    await vi.waitFor(() => expect(document.querySelector('td [data-pos]')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('h2 [data-pos]')).not.toBeNull());
    const paragraph = document.querySelector('p')!;
    paragraph.textContent = 'Settings';
    await flush();
    expect(paragraph.querySelector('hnw-read')).toBeNull();
    expect(paragraph.textContent).toBe('Settings');
  });

  it('范围过滤不关闭孤立单词的生词本高亮', async () => {
    document.body.innerHTML = '<p id="isolated">record</p><p>They record music with friends.</p>';
    engine();
    const v = visual();
    await vi.waitFor(() => expect(document.querySelector('#isolated hnw-mark')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('p:nth-child(2) [data-pos]')).not.toBeNull());
    expect(document.querySelector('#isolated hnw-read,#isolated [data-hnw-reading-word]')).toBeNull();
    v.stop();
    expect(document.querySelector('#isolated hnw-mark')).not.toBeNull();
    expect(document.getElementById('isolated')!.textContent).toBe('record');
  });

  it.each([true, false])('按浏览器能力启用内层滚动容器四向预读，并保持真实可见观察与原文还原：%s', async supported => {
    type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    let nearby!: Callback;
    const observers: Array<IntersectionObserverInit & { scrollMargin?: string } | undefined> = [];
    const observed = new Set<Element>();
    class RecordingIO {
      constructor(callback: Callback, options?: IntersectionObserverInit) {
        observers.push(options);
        if (options?.rootMargin) nearby = callback;
      }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() {}
    }
    if (supported) Object.defineProperty(RecordingIO.prototype, 'scrollMargin', { value: '0px', configurable: true });
    vi.stubGlobal('IntersectionObserver', RecordingIO);
    document.body.innerHTML = '<div style="overflow:auto"><table><tbody><tr><td>They record music.</td></tr></tbody></table></div>';
    const cell = document.querySelector('td')!;
    const original = cell.firstChild;
    const before = cell.textContent;
    const v = visual();
    await vi.waitFor(() => expect(observed.has(cell)).toBe(true));
    expect(observers[0]?.rootMargin).toBe('1600px 1600px');
    expect(observers[0]?.scrollMargin).toBe(supported ? '1200px 800px' : undefined);
    // 第二个 observer 始终测量真实可见区，不把水平预读误当可见优先级。
    expect(observers[1]).toBeUndefined();
    nearby([{ target: cell, isIntersecting: true }]);
    await flush();
    expect(cell.querySelector('[data-pos="verb"]')).not.toBeNull();
    expect(cell.textContent).toBe(before);
    v.stop();
    expect(cell.firstChild).toBe(original);
    expect(cell.querySelector('hnw-read')).toBeNull();
    expect(cell.textContent).toBe(before);
  });
  it.each(['https://medium.com/story', 'https://example.com/story'])('Medium响应卡片的pre正文仅在对应站点增强，普通代码保持排除：%s', async url => {
    const environment = globalThis as typeof globalThis & { jsdom: { reconfigure(options: { url: string }): void } };
    const originalUrl = document.location.href;
    environment.jsdom.reconfigure({ url });
    try {
      document.body.innerHTML = '<section><button aria-label="Response options"></button><a data-dd-action-name="respond_sidebar.open">Reply</a><div><pre id="response"><div>They record music with friends.</div></pre></div></section>'
        + '<section><button aria-label="Response options"></button><a data-dd-action-name="respond_sidebar.open">Reply</a><div><pre id="code-response"><div><code>They record music.</code></div></pre></div></section>'
        + '<pre id="ordinary"><div>They record music.</div></pre><pre id="code"><code>They record music.</code></pre>';
      const before = document.body.textContent;
      const response = document.getElementById('response')!;
      const original = response.querySelector('div')!.firstChild;
      const v = visual();
      await flush();
      await vi.waitFor(() => expect(!!response.querySelector('[data-pos="verb"]')).toBe(url.includes('medium.com')));
      expect(document.querySelector('#ordinary hnw-read,#code hnw-read,#code-response hnw-read')).toBeNull();
      expect(document.body.textContent).toBe(before);
      v.stop();
      expect(response.querySelector('div')!.firstChild).toBe(original);
      expect(document.body.textContent).toBe(before);
    } finally {
      environment.jsdom.reconfigure({ url: originalUrl });
    }
  });
  it.each(['textContent', 'characterData'])('有视口观察时初始非英文容器后补英文仍能发现：%s', async mode => {
    let intersect!: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect, options?: IntersectionObserverInit) { if (options?.rootMargin) intersect = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() { observed.clear(); }
    });
    document.body.innerHTML = '<article><div id="late">中文</div></article><ytd-comment-view-model><yt-attributed-string id="content-text"></yt-attributed-string></ytd-comment-view-model>';
    const v = visual();
    await flush();
    const div = document.getElementById('late')!;
    const comment = document.getElementById('content-text')!;
    if (mode === 'characterData') (div.firstChild as Text).data = 'We record music.';
    else div.textContent = 'We record music.';
    comment.append('They record music.');
    await vi.waitFor(() => { expect(observed.has(div)).toBe(true); expect(observed.has(comment)).toBe(true); });
    intersect([{ target: div, isIntersecting: true }, { target: comment, isIntersecting: true }]);
    await vi.waitFor(() => { expect(div.querySelector('hnw-read')).not.toBeNull(); expect(comment.querySelector('hnw-read')).not.toBeNull(); });
    v.stop();
    expect(div.textContent).toBe('We record music.');
    expect(comment.textContent).toBe('They record music.');
  });

  it('发现动态 YouTube 描述和评论，排除推荐、按钮及编辑区并完整还原', async () => {
    document.body.innerHTML = '<ytd-watch-flexy role="main"><ytd-watch-metadata><div id="description"><yt-attributed-string>We record music with friends.</yt-attributed-string></div></ytd-watch-metadata><ytd-watch-next-secondary-results-renderer><ytd-compact-video-renderer><h3>They record music with friends.</h3><yt-attributed-string>They record music with friends.</yt-attributed-string></ytd-compact-video-renderer></ytd-watch-next-secondary-results-renderer></ytd-watch-flexy>';
    const original = document.body.textContent;
    const v = visual();
    await vi.waitFor(() => expect(document.querySelector('#description hnw-read')).not.toBeNull());
    const comments = document.createElement('ytd-comment-view-model');
    comments.innerHTML = '<yt-attributed-string id="content-text">We record music together.</yt-attributed-string><button>They record music.</button><div contenteditable="true">We record music.</div>';
    document.body.append(comments);
    await vi.waitFor(() => expect(comments.querySelector('#content-text hnw-read')).not.toBeNull());
    expect(document.querySelector('ytd-compact-video-renderer hnw-read,button hnw-read,[contenteditable] hnw-read')).toBeNull();
    v.stop();
    expect(document.body.textContent).toBe(original + 'We record music together.They record music.We record music.');
    expect(document.querySelector('hnw-read')).toBeNull();
  });

  it('文章 div、标题和表格按各自上下文标注，不重复包装子段落', async () => {
    document.body.innerHTML = '<article><h1>They record music.</h1><div id="outer">They record music.<div id="inner"><span>We record music.</span></div><p>They record music.</p></div><table><tbody><tr><td>They record music.</td></tr></tbody></table><nav><div>They record music.</div></nav><div role="button">They record music.</div></article><div id="outside">They record music.</div>';
    const original = document.body.textContent;
    const v = visual();
    await vi.waitFor(() => expect(document.querySelector('td hnw-read')).not.toBeNull());
    for (const selector of ['h1', '#outer', '#inner', 'p', 'td']) expect(document.querySelector(`${selector} hnw-read`)).not.toBeNull();
    expect(document.querySelector('hnw-read hnw-read[data-group],nav hnw-read,[role="button"] hnw-read,#outside hnw-read')).toBeNull();
    v.stop();
    expect(document.body.textContent).toBe(original);
  });

  it('正文布局容器的动画不额外注册无自身正文的块，排除区增量变化也不入队', async () => {
    let intersect!: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect, options?: IntersectionObserverInit) { if (options?.rootMargin) intersect = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() { observed.clear(); }
    });
    document.body.innerHTML = '<main><div id="layout"><p>We record music.</p></div><nav><div id="navigation">They record music.</div></nav></main>';
    visual();
    await vi.waitFor(() => expect(observed.has(document.querySelector('p')!)).toBe(true));
    const layout = document.getElementById('layout')!;
    const navigation = document.getElementById('navigation')!;
    layout.setAttribute('style', 'opacity:0.9');
    navigation.setAttribute('style', 'opacity:0.9');
    const added = document.createElement('p');
    added.textContent = 'We record music.';
    navigation.append(added);
    await flush();
    expect(observed.has(layout)).toBe(false);
    expect([...observed].some(el => navigation.contains(el))).toBe(false);
  });

  it('渲染前排空记录仍会发现向普通容器加入的独立正文', async () => {
    document.body.innerHTML = '<div id="container"></div>';
    const v = visual();
    const container = document.querySelector('#container')!;
    const p = document.createElement('p');
    p.textContent = 'They record music with friends.';
    container.append(p);
    // 确定性模拟 rAF 写入前 takeRecords，不能只处理已有段落的置脏。
    const internal = v as unknown as { observer: MutationObserver; handleMutations(records: MutationRecord[]): void };
    internal.handleMutations(internal.observer.takeRecords());
    await vi.waitFor(() => expect(p.querySelector('hnw-read')).not.toBeNull());
    v.stop();
    expect(p.textContent).toBe('They record music with friends.');
  });

  it.each(['visual-first', 'engine-first'])('阅读优先生词不丢词、不嵌套包装，重建与切换优先级可撤销：%s', async order => {
    document.body.innerHTML = '<p>They record music with friends.</p>';
    let v: ReadingVisual;
    let e: ReturnType<typeof engine>;
    if (order === 'visual-first') { v = visual(); await flush(); e = engine(); }
    else { e = engine(); await flush(); v = visual(); }
    await vi.waitFor(() => expect(document.querySelectorAll('hnw-w[data-hnw-reading-word]')).toHaveLength(2));
    expect(document.querySelector('hnw-mark hnw-read')).toBeNull();
    expect(document.querySelector<HTMLElement>('hnw-w[data-pos="verb"]')!.style.textDecorationLine).toBe('underline');
    const before = document.body.textContent;
    e.result.rebuild(e.matcher, e.dictionary);
    await vi.waitFor(() => expect(document.querySelectorAll('hnw-w[data-hnw-reading-word]')).toHaveLength(2));
    expect(document.body.textContent).toBe(before);
    const settings = createDefaultReadingSettings();
    settings.enabled = true; settings.syntax.enabled = true; settings.wordStylePriority = 'vocabulary';
    v.update(settings); await flush();
    expect(document.querySelector('hnw-w[data-hnw-reading-word]')).toBeNull();
    expect(document.body.textContent).toBe(before);
    v.stop(); e.result.stop();
    expect(document.body.textContent).toBe(before);
    expect(document.querySelector('[data-hnw-reading-word], hnw-read, hnw-mark')).toBeNull();
  });
  it.each(READING_MARK_STYLES)('词性与语义均支持%s，并保留作者链接装饰与非文字配色模式的原字色', async (mode) => {
    document.body.innerHTML = '<p><a href="/music" style="color:#223344;text-decoration:underline dotted">They record music.</a> However, they never record 42 observations.</p>';
    const before = document.body.textContent;
    const link = document.querySelector('a')!;
    const authorStyle = link.getAttribute('style');
    const v = visual({ enabled: false }, settings => {
      settings.syntax.mode = mode;
      settings.syntax.colors.verb = '#123456';
      settings.emphasis.styles.negation = { mode, color: '#aabbcc' };
    });
    await flush();
    const verb = link.querySelector<HTMLElement>('[data-pos="verb"]')!;
    const negation = document.querySelector<HTMLElement>('[data-emphasis="negation"]')!;
    for (const [node, color] of [[verb, 'rgb(18, 52, 86)'], [negation, 'rgb(170, 187, 204)']] as const) {
      expect(node).not.toBeNull();
      expect(node.style.fontWeight).toBe('');
      expect(node.style.whiteSpace).toBe('');
      expect(node.style.padding).toBe('');
      if (mode === 'color') expect(node.style.color).toBe(color);
      else expect(node.style.color).toBe('');
      if (mode === 'underline' || mode === 'dotted' || mode === 'wavy') {
        expect(node.style.textDecorationLine).toBe('underline');
        expect(node.style.textDecorationStyle).toBe(mode === 'underline' ? 'solid' : mode);
        expect(node.style.textDecorationColor).toBe(color);
      } else if (mode === 'background') {
        expect(node.style.backgroundColor).toMatch(/rgba\(.+, 0\.2\)/);
      } else if (mode === 'marker') {
        expect(node.style.backgroundImage).toContain('linear-gradient');
        expect(node.style.backgroundImage).toMatch(/rgba\(.+, 0\.333/);
      } else if (mode === 'bold') {
        expect(node.style.getPropertyValue('-webkit-text-stroke')).toContain('0.35px');
      }
    }
    expect(link.getAttribute('style')).toBe(authorStyle);
    expect(link.getAttribute('href')).toBe('/music');
    expect(document.body.textContent).toBe(before);
    v.stop();
    expect(document.body.textContent).toBe(before);
  });
  it.each([
    ['underline', 'color'], ['color', 'underline'], ['wavy', 'dotted'], ['background', 'marker'],
  ] as const)('重叠词性%s与专名%s按通道合并，同通道语义优先', async (syntax, emphasis) => {
    document.body.innerHTML = '<p>They visited London yesterday.</p>';
    visual({ enabled: false }, settings => {
      settings.syntax.mode = syntax;
      settings.syntax.colors.noun = '#123456';
      settings.emphasis.properNouns = true;
      settings.emphasis.styles.properNouns = { mode: emphasis, color: '#aabbcc' };
    });
    await flush();
    const london = document.querySelector<HTMLElement>('[data-emphasis="properNouns"]')!;
    expect(london.dataset.pos).toBe('noun');
    if (emphasis === 'color') {
      expect(london.style.color).toBe('rgb(170, 187, 204)');
      expect(london.style.textDecorationColor).toBe('rgb(18, 52, 86)');
    } else if (syntax === 'color') {
      expect(london.style.color).toBe('rgb(18, 52, 86)');
      expect(london.style.textDecorationColor).toBe('rgb(170, 187, 204)');
    } else if (emphasis === 'dotted') {
      expect(london.style.textDecorationStyle).toBe('dotted');
      expect(london.style.textDecorationColor).toBe('rgb(170, 187, 204)');
    } else {
      expect(london.style.backgroundColor).toBe('');
      expect(london.style.backgroundImage).toContain('linear-gradient');
    }
    expect(document.body.textContent).toBe('They visited London yesterday.');
  });
  it('强调样式对象本身不会激活扫描，四个语义开关全关时不读取布局', async () => {
    document.body.innerHTML = '<p>Readers understand 42 observations.</p>';
    const settings = createDefaultReadingSettings(); settings.enabled = true;
    const readStyle = vi.spyOn(window, 'getComputedStyle');
    const v = new ReadingVisual(document.body, settings); active.push(v); v.start();
    await flush();
    expect(readStyle).not.toHaveBeenCalled();
    expect(document.querySelector('hnw-read')).toBeNull();
  });
  it('长文只分析视口邻近段落，滚到末段和新增正文时仍按完整上下文增强', async () => {
    let intersect!: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect, options?: IntersectionObserverInit) { if (options?.rootMargin) intersect = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() { observed.clear(); }
    });
    document.body.innerHTML = '<article>' + Array.from({ length: 120 }, (_, i) => `<p id="paragraph-${i}">They record a record with 42 people.</p>`).join('') + '</article>';
    const before = document.body.textContent;
    const v = visual();
    await vi.waitFor(() => expect(observed.size).toBe(120));
    expect(document.querySelector('hnw-read')).toBeNull();
    const first = document.getElementById('paragraph-0')!;
    const last = document.getElementById('paragraph-119')!;
    intersect([{ target: first, isIntersecting: true }]); await flush();
    expect(first.querySelector('[data-pos="verb"]')).not.toBeNull();
    expect(first.querySelector('[data-pos="noun"]')).not.toBeNull();
    expect(last.querySelector('hnw-read')).toBeNull();
    intersect([{ target: first, isIntersecting: false }, { target: last, isIntersecting: true }]); await flush();
    expect(first.querySelector('[data-pos], [data-prefix]')).not.toBeNull();
    expect(last.querySelector('[data-pos="verb"]')).not.toBeNull();
    expect(document.getElementById('paragraph-60')!.querySelector('hnw-read')).toBeNull();
    intersect([...observed].map(target => ({ target, isIntersecting: true })));
    await vi.waitFor(() => expect([...document.querySelectorAll('p')].every(p => p.querySelector('hnw-read'))).toBe(true), { timeout: 5000 });
    expect(document.body.textContent).toBe(before);
    v.stop();
    expect(document.querySelector('hnw-read')).toBeNull();
    expect(document.body.textContent).toBe(before);
  });
  it('可见正文先于预读区入队更早的段落完成标记', async () => {
    type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    let nearby!: Callback;
    let visible!: Callback;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: Callback, options?: IntersectionObserverInit) {
        if (options?.rootMargin) nearby = callback; else visible = callback;
      }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() { observed.clear(); }
    });
    document.body.innerHTML = Array.from({ length: 36 }, (_, i) => `<p id="buffer-${i}">They record music.</p>`).join('') + '<p id="visible">We understand English.</p>';
    const v = visual();
    await vi.waitFor(() => expect(observed.size).toBe(37));
    const buffer = document.getElementById('buffer-0')!;
    const current = document.getElementById('visible')!;
    nearby([...observed].map(target => ({ target, isIntersecting: true })));
    visible([{ target: current, isIntersecting: true }]);
    // 标记首段时检查预读段仍未处理，避免仅验证最后两段都完成。
    await new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (!current.querySelector('[data-pos]')) return;
        expect(buffer.querySelector('[data-pos]')).toBeNull();
        observer.disconnect(); resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    v.stop();
  });
  it('离屏保留阅读与生词DOM，往返无需重绘，移除整段后重挂不丢原文', async () => {
    let intersect!: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: typeof intersect, private options?: IntersectionObserverInit) {
        if (options?.rootMargin && options.rootMargin !== '1600px') intersect = callback;
      }
      observe(element: Element) {
        observed.add(element);
        // 生词预读先创建 mark；阅读的进出视口仍由用例手动控制，译文保持未进入视口。
        if (this.options?.rootMargin === '1600px') queueMicrotask(() => this.callback([{ target: element, isIntersecting: true }]));
      }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() {}
    });
    document.body.innerHTML = '<main><p>They record music with friends.</p></main>';
    const p = document.querySelector('p')!;
    const main = document.querySelector('main')!;
    const before = p.textContent;
    const original = p.firstChild;
    const e = engine(); await flush();
    const v = visual(); await flush();
    const onReadingIntersection = intersect;
    onReadingIntersection([{ target: p, isIntersecting: true }]); await flush();
    const words = [...p.querySelectorAll('hnw-mark')];
    expect(words).toHaveLength(2);
    expect(p.querySelector('[data-pos]')).not.toBeNull();
    const readingNodes = [...p.querySelectorAll('hnw-read')];
    onReadingIntersection([{ target: p, isIntersecting: false }]); await flush();
    expect(p.querySelector('[data-pos], [data-prefix]')).not.toBeNull();
    expect([...p.querySelectorAll('hnw-mark')]).toEqual(words);
    expect(p.textContent).toBe(before);
    onReadingIntersection([{ target: p, isIntersecting: true }]);
    // IO 刚通知重入时已经保持原样式，无需等下一帧重新生成词级节点。
    expect([...p.querySelectorAll('hnw-read')]).toEqual(readingNodes);
    await flush();
    expect([...p.querySelectorAll('hnw-read')]).toEqual(readingNodes);
    expect(p.querySelector('[data-pos]')).not.toBeNull();
    expect(p.textContent).toBe(before);
    main.remove(); await flush();
    expect(observed.has(p)).toBe(false);
    expect(main.querySelector('hnw-read')).toBeNull();
    expect(p.textContent).toBe(before);
    expect(p.firstChild).toBe(original);
    document.body.append(main); await flush();
    onReadingIntersection([{ target: p, isIntersecting: true }]); await flush();
    expect(p.querySelector('[data-pos]')).not.toBeNull();
    v.stop(); e.result.stop();
    expect(p.textContent).toBe(before);
    expect(p.firstChild).toBe(original);
    expect(p.querySelector('hnw-read,hnw-mark')).toBeNull();
  });
  it('离屏缓存超过64段时回收最早离开的逐词层，缓存保持有界且不改变原文', async () => {
    let intersect!: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect, options?: IntersectionObserverInit) {
        if (options?.rootMargin) {
          expect(options.rootMargin).toBe('1600px 1600px');
          intersect = callback;
        }
      }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() {}
    });
    document.body.innerHTML = '<article>' + Array.from({ length: 68 }, (_, i) => `<p>${i}: They record music.</p>`).join('') + '</article>';
    const paragraphs = [...document.querySelectorAll('p')];
    const before = document.body.textContent;
    const v = visual();
    await vi.waitFor(() => expect(observed.size).toBe(68));
    intersect(paragraphs.map(target => ({ target, isIntersecting: true })));
    await vi.waitFor(() => expect(paragraphs.every(p => p.querySelector('[data-pos]'))).toBe(true), { timeout: 5000 });
    const retained = paragraphs[67]!.querySelector('[data-pos]');
    window.dispatchEvent(new Event('scroll'));
    intersect(paragraphs.map(target => ({ target, isIntersecting: false })));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(paragraphs.filter(p => p.querySelector('[data-pos]'))).toHaveLength(68);
    await vi.waitFor(() => expect(paragraphs.filter(p => p.querySelector('[data-pos]'))).toHaveLength(64));
    expect(paragraphs.slice(0, 4).every(p => !p.querySelector('[data-pos]'))).toBe(true);
    expect(paragraphs[67]!.querySelector('[data-pos]')).toBe(retained);
    expect(document.body.textContent).toBe(before);
    v.stop();
    expect(document.querySelector('hnw-read')).toBeNull();
    expect(document.body.textContent).toBe(before);
  });
  it('有视口观察时连续滚动仍按批次补齐新内容，不等停稳才标注', async () => {
    type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    let nearby!: Callback;
    let visible!: Callback;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: Callback, options?: IntersectionObserverInit) { if (options?.rootMargin) nearby = callback; else visible = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() {}
    });
    document.body.innerHTML = '<p>They record music.</p>';
    const p = document.querySelector('p')!;
    const v = visual();
    await vi.waitFor(() => expect(observed.has(p)).toBe(true));
    window.dispatchEvent(new Event('scroll'));
    nearby([{ target: p, isIntersecting: true }]);
    visible([{ target: p, isIntersecting: true }]);
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(p.querySelector('[data-pos]')).not.toBeNull();
    v.stop();
  });
  it('离屏长段落即使不足64段，也限制为8k原文并保留最近段落', async () => {
    let intersect!: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
    const observed = new Set<Element>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect, options?: IntersectionObserverInit) { if (options?.rootMargin) intersect = callback; }
      observe(element: Element) { observed.add(element); }
      unobserve(element: Element) { observed.delete(element); }
      disconnect() {}
    });
    const paragraph = 'They record music. '.repeat(280);
    document.body.innerHTML = '<article>' + `<p>${paragraph}</p>`.repeat(3) + '</article>';
    const paragraphs = [...document.querySelectorAll('p')];
    const v = visual({ enabled: false });
    await vi.waitFor(() => expect(observed.size).toBe(3));
    intersect(paragraphs.map(target => ({ target, isIntersecting: true })));
    await vi.waitFor(() => expect(paragraphs.every(p => p.querySelector('[data-pos]'))).toBe(true), { timeout: 5000 });
    intersect(paragraphs.map(target => ({ target, isIntersecting: false })));
    await vi.waitFor(() => {
      const retained = paragraphs.filter(p => p.querySelector('[data-pos]'));
      expect(retained.reduce((characters, p) => characters + p.textContent!.length, 0)).toBeLessThanOrEqual(8000);
      expect(paragraphs.at(-1)!.querySelector('[data-pos]')).not.toBeNull();
    });
    expect(paragraphs[0]!.querySelector('[data-pos]')).toBeNull();
    expect(paragraphs.every(p => p.textContent === paragraph)).toBe(true);
    v.stop();
  });
  it('外部正文更新会重新标注', async () => {
    document.body.innerHTML = '<p>They record a record.</p>';
    visual(); await flush();
    const p = document.querySelector('p')!;
    p.textContent = 'They never record 42 observations.';
    await flush();
    expect(p.querySelector('[data-emphasis="negation"]')).not.toBeNull();
    expect(p.textContent).toBe('They never record 42 observations.');
  });
  it('连续滚动时让出视觉标注，停止后补齐完整上下文', async () => {
    document.body.innerHTML = '<p>They record a record with 42 people.</p>';
    const before = document.body.textContent;
    visual();
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(document.querySelector('hnw-read')).toBeNull();
    }
    await vi.waitFor(() => expect(document.querySelector('[data-pos="verb"]')).not.toBeNull());
    expect(document.body.textContent).toBe(before);
  });
  it('同时摘下多个已渲染段落，各自还原后再挂回不互相丢失文字', async () => {
    document.body.innerHTML = '<main><p>Careful readers understand language.</p><p>They record music with friends.</p></main>';
    const main = document.querySelector('main')!;
    const paragraphs = [...main.querySelectorAll('p')];
    const texts = paragraphs.map(p => p.textContent);
    const originals = paragraphs.map(p => p.firstChild);
    const v = visual(); await flush();
    main.replaceChildren(); await flush();
    expect(paragraphs.map(p => p.textContent)).toEqual(texts);
    expect(paragraphs.every(p => !p.querySelector('hnw-read'))).toBe(true);
    main.append(...paragraphs); await flush();
    expect(paragraphs.map(p => p.textContent)).toEqual(texts);
    v.stop();
    expect(paragraphs.map(p => p.firstChild)).toEqual(originals);
    expect(paragraphs.map(p => p.textContent)).toEqual(texts);
  });
  it('词首强调间隔按整段英文词计数，跨inline算一次，数字不计，词性不受影响', async () => {
    document.body.innerHTML = '<p>Readers <em>under</em><strong>stand</strong> 42 complex words.</p><p>Readers understand words.</p>';
    const before = document.body.textContent;
    const v = visual({ interval: 2 }); await flush();
    const paragraphs = document.querySelectorAll('p');
    expect([...paragraphs[0]!.querySelectorAll('[data-prefix]')].map(node => node.textContent)).toEqual(['Readers', 'complex']);
    expect([...paragraphs[1]!.querySelectorAll('[data-prefix]')].map(node => node.textContent)).toEqual(['Readers', 'words']);
    expect(paragraphs[0]!.querySelector('em [data-pos="verb"]')).not.toBeNull();
    expect(paragraphs[0]!.querySelector('strong [data-pos="verb"]')).not.toBeNull();
    expect(document.body.textContent).toBe(before);
    v.stop();
    expect(document.body.textContent).toBe(before);
  });
  it.each([['light', '0.25'], ['medium', '0.45'], ['strong', '0.65']] as const)('强度%s仅改变描边样式，不切开原词或复制文本', async (intensity, stroke) => {
    document.body.innerHTML = '<p>Readers understand language.</p>';
    const before = document.body.textContent;
    visual({ intensity }); await flush();
    expect([...document.head.querySelectorAll('style')].some(style => style.textContent?.includes(`-webkit-text-stroke:${stroke}px`))).toBe(true);
    const word = document.querySelector('[data-prefix]')!;
    expect(word.childNodes).toHaveLength(1);
    expect(word.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(document.body.textContent).toBe(before);
  });
  it('跨行内元素分析并保留原 Text、链接与原文复制，可完整撤销', async () => {
    document.body.innerHTML = '<p>They <a href="/music">record</a> a <em>record</em> with 42 people.</p>';
    const original = document.querySelector('a')!.firstChild!;
    const link = document.querySelector('a')!;
    const before = document.body.textContent;
    const v = visual();
    await flush();
    expect(link.firstChild).toBe(original);
    expect(link.querySelector('[data-pos="verb"]')).not.toBeNull();
    expect(document.querySelector('em [data-pos="noun"]')).not.toBeNull();
    expect(document.body.textContent).toBe(before);
    expect(link.getAttribute('href')).toBe('/music');
    v.stop();
    expect(document.body.textContent).toBe(before);
    expect(document.querySelector('hnw-read')).toBeNull();
    expect(link.firstChild).toBe(original);
  });
  it('跳过导航、隐藏、代码、编辑器与控件，动态新增和框架原节点改写/删除保持原文', async () => {
    document.body.innerHTML = '<nav><p>record music</p></nav><p hidden>record music</p><p><code>record music</code></p><div contenteditable><p>record music</p></div><p>They record music.</p>';
    // 空 contenteditable 也是浏览器可编辑区域。
    document.querySelector('[contenteditable]')!.setAttribute('contenteditable', 'true');
    const p = document.querySelectorAll('p')[4]!;
    const original = p.firstChild!;
    visual();
    await flush();
    expect(document.querySelector('nav hnw-read, [hidden] hnw-read, code hnw-read, [contenteditable] hnw-read')).toBeNull();
    original.nodeValue = 'They record a record.';
    await flush();
    expect(p.textContent).toBe('They record a record.');
    p.removeChild(original);
    await flush();
    expect(p.textContent).toBe('');
    const added = document.createElement('p'); added.textContent = 'They record music.'; document.body.append(added);
    await flush();
    expect(added.querySelector('hnw-read')).not.toBeNull();
  });
  it.each(['visual-first', 'engine-first'])('与真实生词引擎并发 %s，熟词移除、重建、关闭和框架改写不丢词', async (order) => {
    document.body.innerHTML = '<p>They record music with friends.</p>';
    const p = document.querySelector('p')!;
    const original = p.firstChild!;
    let v: ReadingVisual;
    let e: ReturnType<typeof engine>;
    if (order === 'visual-first') { v = visual(); await flush(); e = engine(); }
    else { e = engine(); await flush(); v = visual(); }
    await flush();
    expect(p.textContent).toBe('They record music with friends.');
    expect(p.querySelectorAll('hnw-mark').length).toBe(2);
    expect(p.querySelector('hnw-mark hnw-read')).toBeNull();
    const count = p.querySelectorAll('hnw-read').length;
    await flush();
    expect(p.querySelectorAll('hnw-read').length).toBe(count);
    e.result.removeLemma('music'); await flush();
    expect(p.textContent).toBe('They record music with friends.');
    e.result.rebuild(e.matcher, e.dictionary); await flush();
    expect(p.textContent).toBe('They record music with friends.');
    original.nodeValue = 'They record a record.'; await flush();
    expect(p.textContent).toBe('They record a record.');
    v.stop(); e.result.stop();
    expect(p.textContent).toBe('They record a record.');
    expect(p.querySelector('hnw-read,hnw-mark')).toBeNull();
    expect(p.firstChild).toBe(original);
  });
  it('生词引擎先关闭，再删除框架原节点，视觉组不残留或复制旧文字', async () => {
    document.body.innerHTML = '<p>They record music with friends.</p>';
    const p = document.querySelector('p')!;
    const original = p.firstChild!;
    const e = engine(); await flush();
    const v = visual(); await flush();
    e.result.stop(); await flush();
    expect(p.textContent).toBe('They record music with friends.');
    p.removeChild(original); await flush();
    expect(p.textContent).toBe('');
    v.stop();
    expect(p.textContent).toBe('');
    expect(p.querySelector('hnw-read,hnw-mark')).toBeNull();
  });
  it('关闭视觉后继续让生词引擎运行，不能把还原文本误认为框架改写并丢弃后续片段', async () => {
    document.body.innerHTML = '<p>They record music with friends. However, no scheme can meet every reader needs.</p>';
    const before = document.body.textContent;
    engine(); await flush();
    const v = visual(); await flush();
    v.stop(); await flush();
    expect(document.body.textContent).toBe(before);
    expect(document.querySelector('hnw-read')).toBeNull();
    expect(document.querySelectorAll('hnw-mark')).toHaveLength(2);
  });
  it('祖先切换为可编辑或隐藏时立即还原，重新可见后可再次标注', async () => {
    document.body.innerHTML = '<main><p>They record music.</p></main>';
    const main = document.querySelector('main')!;
    visual(); await flush();
    main.setAttribute('contenteditable', 'true'); await flush();
    expect(main.querySelector('hnw-read')).toBeNull();
    expect(main.textContent).toBe('They record music.');
    main.removeAttribute('contenteditable'); await flush();
    expect(main.querySelector('hnw-read')).not.toBeNull();
    main.setAttribute('hidden', ''); await flush();
    expect(main.querySelector('hnw-read')).toBeNull();
  });
  it('可标注祖先blockquote变为可编辑时也撤销子段落，恢复后重新标注', async () => {
    document.body.innerHTML = '<blockquote><p>Careful readers understand language.</p></blockquote>';
    const quote = document.querySelector('blockquote')!;
    const p = document.querySelector('p')!;
    const original = p.firstChild;
    visual(); await flush();
    expect(p.querySelector('hnw-read')).not.toBeNull();
    quote.setAttribute('contenteditable', 'true'); await flush();
    expect(quote.querySelector('hnw-read')).toBeNull();
    expect(p.firstChild).toBe(original);
    expect(p.textContent).toBe('Careful readers understand language.');
    quote.setAttribute('contenteditable', 'false'); await flush();
    expect(p.querySelector('hnw-read')).not.toBeNull();
    expect(p.textContent).toBe('Careful readers understand language.');
  });
  it('框架把原始节点改写为空串时，真实生词与阅读片段一起删除', async () => {
    document.body.innerHTML = '<p>They record music with friends.</p>';
    const p = document.querySelector('p')!;
    const original = p.firstChild as Text;
    engine(); await flush(); visual(); await flush();
    original.data = ''; await flush();
    expect(p.textContent).toBe('');
    expect(p.querySelector('hnw-mark,hnw-read')).toBeNull();
  });
});
