import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeReadingHighlights } from '@/content/reading/native-highlights';
import { ReadingVisual } from '@/content/reading/visual';
import { trackScrollActivity } from '@/content/scroll-activity';
import { analyzeReading, type ReadingToken } from '@/core/reading/analyze';
import { createDefaultReadingSettings } from '@/core/reading/settings';

class TestHighlight extends Set<AbstractRange> {
  priority = 0;
}

let registry: Map<string, TestHighlight>;
const active: Array<{ stop(): void }> = [];

beforeEach(() => {
  registry = new Map();
  vi.stubGlobal('CSS', { ...window.CSS, highlights: registry });
  vi.stubGlobal('Highlight', TestHighlight);
});
afterEach(() => {
  active.splice(0).reverse().forEach(item => item.stop());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function settings() {
  const result = createDefaultReadingSettings();
  result.enabled = true;
  result.syntax.enabled = true;
  return result;
}

function layer(suffix: string): TestHighlight {
  const result = [...registry].find(([name]) => name.endsWith(`-${suffix}`))?.[1];
  expect(result, suffix).toBeDefined();
  return result!;
}

function ranges() {
  return [...registry.values()].flatMap(highlight => [...highlight]);
}

function selected(range: AbstractRange) {
  expect(range.startContainer).toBe(range.endContainer);
  return (range.startContainer as Text).data.slice(range.startOffset, range.endOffset);
}

function startVisual(analyzeAsync: (text: string, withSyntax: boolean) => Promise<ReadingToken[]> = async (text, syntax) => analyzeReading(text, syntax)) {
  const config = settings();
  const visual = new ReadingVisual(document.body, config, analyzeAsync);
  active.push(visual);
  visual.start();
  return { visual, config };
}

describe('NativeReadingHighlights', () => {
  it('跨行内 Text 精确截取词范围与词首，不改写原节点，也不绘制受保护生词', () => {
    document.body.innerHTML = '<p><span>ne</span><a href="#">ver</a> <hnw-mark><hnw-w>music</hnw-w></hnw-mark></p>';
    const block = document.querySelector('p')!;
    const left = block.querySelector('span')!.firstChild as Text;
    const right = block.querySelector('a')!.firstChild as Text;
    const protectedText = block.querySelector('hnw-w')!.firstChild as Text;
    const before = block.innerHTML;
    const config = settings();
    config.wordStylePriority = 'vocabulary';
    config.bionic.enabled = true;
    config.bionic.minLength = 3;
    config.emphasis.negation = true;
    const native = new NativeReadingHighlights(document, config); active.push(native);
    expect(NativeReadingHighlights.supported(document)).toBe(true);
    const token: ReadingToken = { start: 0, end: 5, text: 'never', pos: 'adverb', emphasis: 'negation' };
    native.paint(block, [
      { node: left, start: 0, end: 2, protected: false },
      { node: right, start: 2, end: 5, protected: false },
      { node: protectedText, start: 6, end: 11, protected: true },
    ], [token, { start: 6, end: 11, text: 'music', pos: 'noun' }], new Set([token]));
    expect([...layer('adverb-negation')].map(selected)).toEqual(['er']);
    expect([...layer('adverb-negation-prefix')].map(selected)).toEqual(['ne', 'v']);
    expect(layer('adverb-negation-prefix').priority).toBe(layer('adverb-negation').priority);
    const fragments = [...layer('adverb-negation'), ...layer('adverb-negation-prefix')];
    expect(fragments.filter(range => range.startContainer === right).map(range => [range.startOffset, range.endOffset]).sort((a, b) => a[0]! - b[0]!)).toEqual([[0, 1], [1, 3]]);
    expect(ranges().every(range => range instanceof StaticRange)).toBe(true);
    expect(ranges().some(range => range.startContainer === protectedText)).toBe(false);
    expect(block.innerHTML).toBe(before);
    expect(block.querySelector('span')!.firstChild).toBe(left);
    expect(block.querySelector('a')!.firstChild).toBe(right);
    expect(document.querySelector('hnw-read')).toBeNull();
    native.remove(block);
    expect(ranges()).toHaveLength(0);
    expect(native.has(block)).toBe(false);
  });

  it.each(['color', 'underline'] as const)('同一 %s 通道由语义强调覆盖词性，不同通道共存', mode => {
    const config = settings();
    config.syntax.mode = mode;
    config.syntax.colors.adverb = '#112233';
    config.bionic.enabled = true;
    config.emphasis.negation = true;
    config.emphasis.styles.negation = { mode, color: '#445566' };
    config.emphasis.connectives = true;
    config.emphasis.styles.connectives = { mode: 'background', color: '#778899' };
    const native = new NativeReadingHighlights(document, config); active.push(native);
    const css = document.head.lastElementChild!.textContent!;
    const negationRule = css.split('\n').find(rule => rule.includes('-adverb-negation)'))!;
    expect(negationRule).toContain('#445566');
    expect(negationRule).not.toContain('#112233');
    const prefixRule = css.split('\n').find(rule => rule.includes('-adverb-negation-prefix)'))!;
    expect(prefixRule).toContain('#445566');
    expect(prefixRule).not.toContain('#112233');
    const connectiveRule = css.split('\n').find(rule => rule.includes('-adverb-connectives)'))!;
    expect(connectiveRule).toContain('#112233');
    expect(connectiveRule).toContain('background-color:#77889933');
  });

  it('停止实例仅移除自己的 registry 项与样式，保留站点及其他实例', () => {
    const site = new TestHighlight(); registry.set('site-search', site);
    const first = new NativeReadingHighlights(document, settings()); active.push(first);
    const firstNames = [...registry.keys()].filter(name => name !== 'site-search');
    const second = new NativeReadingHighlights(document, settings()); active.push(second);
    const secondNames = [...registry.keys()].filter(name => name !== 'site-search' && !firstNames.includes(name));
    first.stop();
    expect(registry.get('site-search')).toBe(site);
    expect(firstNames.every(name => !registry.has(name))).toBe(true);
    expect(secondNames.length).toBeGreaterThan(0);
    expect(secondNames.every(name => registry.has(name))).toBe(true);
    expect(document.head.textContent).not.toContain(`::highlight(${firstNames[0]})`);
    expect(document.head.textContent).toContain(`::highlight(${secondNames[0]})`);
  });

  it('行内子树移出原段落后，仍按实际范围节点清理并保留其他文字的绘制', () => {
    document.body.innerHTML = '<p><span>music</span> record</p>';
    const block = document.querySelector('p')!;
    const inline = document.querySelector('span')!;
    const first = inline.firstChild as Text;
    const last = block.lastChild as Text;
    const native = new NativeReadingHighlights(document, settings()); active.push(native);
    native.paint(block, [{ node: first, start: 0, end: 5, protected: false }, { node: last, start: 5, end: 12, protected: false }],
      [{ start: 0, end: 5, text: 'music', pos: 'noun' }, { start: 6, end: 12, text: 'record', pos: 'noun' }], new Set());
    inline.remove(); native.remove(inline, true);
    expect([...layer('noun-none')].map(selected)).toEqual(['record']);
    expect(native.has(block)).toBe(true);
  });
});

describe('ReadingVisual 原生异步路径', () => {
  it('阅读优先仅首次登记生词复位属性，不改 inline 样式或安装旧伪元素和 has 样式，重绘不重复写属性', async () => {
    document.body.innerHTML = '<p>They enjoy <hnw-mark><hnw-w style="color:red;background:yellow" data-lemma="music">music</hnw-w></hnw-mark> every morning.</p>';
    const word = document.querySelector('hnw-w')!;
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver(records => changes.push(...records));
    observer.observe(word, { attributes: true, subtree: true });
    try {
      startVisual();
      await vi.waitFor(() => expect(ranges().some(range => word.contains(range.startContainer))).toBe(true));
      expect(word.getAttribute('style')).toBe('color:red;background:yellow');
      expect(word.getAttribute('data-lemma')).toBe('music');
      expect(changes).toHaveLength(1);
      expect(changes[0]!.attributeName).toBe('data-hnw-reading-word');
      const text = document.querySelector('p')!.firstChild as Text;
      const old = ranges(); text.data = 'They really enjoy ';
      await vi.waitFor(() => expect(ranges().some(range => word.contains(range.startContainer)) && !ranges().some(range => old.includes(range))).toBe(true));
      expect(changes).toHaveLength(1);
      expect([...document.head.querySelectorAll('style')].some(style => style.textContent?.includes('hnw-read[data-prefix]:has'))).toBe(false);
    } finally { observer.disconnect(); }
  });

  it.each(['wheel', 'scroll', 'touchmove'])('先发生 %s 再启动阅读时，继承安静窗口并在停止输入后继续分析', async event => {
    document.body.innerHTML = '<p>They record music together.</p>';
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    const frame = () => {
      const entry = frames.entries().next().value!;
      expect(entry).toBeDefined();
      frames.delete(entry[0]); entry[1](now);
    };
    const release = trackScrollActivity(window);
    const analyze = vi.fn(async (text: string, syntax: boolean) => analyzeReading(text, syntax));
    let visual: ReadingVisual | undefined;
    try {
      window.dispatchEvent(new Event(event));
      now = 120;
      visual = startVisual(analyze).visual;
      frame();
      expect(analyze).not.toHaveBeenCalled(); expect(ranges()).toHaveLength(0);
      now = 189; frame();
      expect(analyze).not.toHaveBeenCalled(); expect(ranges()).toHaveLength(0);
      now = 190; frame();
      expect(analyze).toHaveBeenCalledOnce();
      await new Promise(resolve => setTimeout(resolve, 0));
      now = 210; frame();
      expect(ranges().length).toBeGreaterThan(0);
    } finally { visual?.stop(); release(); }
  });

  it.each(['wait', 'stop'] as const)('移除行内生词子树并 %s 后恢复原样，重新挂回能再次应用阅读样式', async action => {
    document.body.innerHTML = '<p>They enjoy the <span id="detached"><hnw-mark><hnw-w style="color: red;">record</hnw-w></hnw-mark> every morning</span>.</p>';
    const paragraph = document.querySelector('p')!;
    const inline = document.querySelector('#detached')!;
    const word = document.querySelector('hnw-w')!;
    const originalStyle = word.getAttribute('style');
    const { visual } = startVisual();
    await vi.waitFor(() => expect(ranges().some(range => word.contains(range.startContainer))).toBe(true));
    inline.remove();
    if (action === 'stop') visual.stop();
    await vi.waitFor(() => {
      expect(word.hasAttribute('data-hnw-reading-word')).toBe(false);
      expect(word.getAttribute('style')).toBe(originalStyle);
      expect(ranges().some(range => inline.contains(range.startContainer))).toBe(false);
    });
    paragraph.lastChild!.before(inline);
    if (action === 'stop') visual.start();
    await vi.waitFor(() => expect(ranges().some(range => word.contains(range.startContainer))).toBe(true));
    expect(inline.querySelector('hnw-w')).toBe(word);
    visual.stop(); expect(word.getAttribute('style')).toBe(originalStyle);
  });

  it.each(['pos', 'short'] as const)('正文变更导致 %s 不再合格时，原生词节点撤销旧阅读样式', async reason => {
    document.body.innerHTML = '<p>They enjoy the <hnw-mark><hnw-w style="color: red;">record</hnw-w></hnw-mark>.</p>';
    const paragraph = document.querySelector('p')!;
    const before = paragraph.firstChild as Text;
    const after = paragraph.lastChild as Text;
    const word = document.querySelector('hnw-w')!;
    const originalStyle = word.getAttribute('style');
    const { config } = startVisual();
    for (const key of Object.keys(config.syntax)) if (typeof config.syntax[key as keyof typeof config.syntax] === 'boolean') Object.assign(config.syntax, { [key]: false });
    config.syntax.enabled = true; config.syntax.nouns = true;
    config.bionic.enabled = false;
    await vi.waitFor(() => expect(ranges().some(range => word.contains(range.startContainer))).toBe(true));
    before.data = reason === 'pos' ? 'They ' : '';
    after.data = reason === 'pos' ? ' music.' : '';
    await vi.waitFor(() => {
      expect(word.hasAttribute('data-hnw-reading-word')).toBe(false);
      expect(word.getAttribute('style')).toBe(originalStyle);
      expect(word.hasAttribute('data-pos')).toBe(false);
      expect(ranges().some(range => word.contains(range.startContainer))).toBe(false);
    });
    expect(paragraph.querySelector('hnw-w')).toBe(word);
    expect(document.querySelector('hnw-read')).toBeNull();
  });

  it.each(['hidden', 'nav'] as const)('生词所在行内 span 被 %s 排除后，仅撤销其阅读样式并保留节点', async reason => {
    document.body.innerHTML = '<p>They enjoy the <span id="inline"><hnw-mark><hnw-w style="color: red;">record</hnw-w></hnw-mark></span> every morning.</p><nav></nav>';
    const inline = document.querySelector('#inline')!;
    const word = document.querySelector('hnw-w')!;
    const originalStyle = word.getAttribute('style');
    startVisual();
    await vi.waitFor(() => expect(ranges().some(range => word.contains(range.startContainer))).toBe(true));
    if (reason === 'hidden') inline.setAttribute('hidden', '');
    else document.querySelector('nav')!.append(inline);
    await vi.waitFor(() => {
      expect(word.hasAttribute('data-hnw-reading-word')).toBe(false);
      expect(word.getAttribute('style')).toBe(originalStyle);
      expect(word.hasAttribute('data-pos')).toBe(false);
      expect(ranges().some(range => inline.contains(range.startContainer))).toBe(false);
    });
    expect(inline.querySelector('hnw-w')).toBe(word);
    expect(word.textContent).toBe('record');
  });

  it('后台分析后直接绘制原 Text，保持链接和节点身份，不创建逐词包装', async () => {
    document.body.innerHTML = '<p>They <a href="#music">record</a> music together.</p>';
    const paragraph = document.querySelector('p')!;
    const link = document.querySelector('a')!;
    const texts = [...paragraph.childNodes];
    const linkedText = link.firstChild;
    const before = paragraph.innerHTML;
    const analyze = vi.fn(async (text: string, syntax: boolean) => analyzeReading(text, syntax));
    startVisual(analyze);
    await vi.waitFor(() => expect(ranges().length).toBeGreaterThan(0));
    expect(analyze).toHaveBeenCalledWith('They record music together.', true);
    expect(paragraph.innerHTML).toBe(before);
    expect([...paragraph.childNodes]).toEqual(texts);
    expect(link.firstChild).toBe(linkedText);
    expect(document.querySelector('hnw-read')).toBeNull();
    expect(ranges().some(range => range.startContainer === linkedText && selected(range) === 'record')).toBe(true);
  });

  it('站点直接改写原 Text 后移除旧 StaticRange，并按新文本重新分析', async () => {
    document.body.innerHTML = '<p>They record music together.</p>';
    const text = document.querySelector('p')!.firstChild as Text;
    const analyze = vi.fn(async (value: string, syntax: boolean) => analyzeReading(value, syntax));
    startVisual(analyze);
    await vi.waitFor(() => expect(ranges().length).toBeGreaterThan(0));
    const oldRanges = ranges();
    text.data = 'Friends enjoy reading books.';
    await vi.waitFor(() => {
      expect(analyze).toHaveBeenCalledWith(text.data, true);
      expect(ranges().some(range => selected(range) === 'Friends')).toBe(true);
    });
    expect(ranges().some(range => oldRanges.includes(range))).toBe(false);
    expect(document.querySelector('p')!.firstChild).toBe(text);
    expect(document.querySelector('hnw-read')).toBeNull();
  });

  it.each(['reading', 'vocabulary'] as const)('生词切分后重建范围并遵守 %s 样式优先级，关闭恢复原生词样式', async priority => {
    document.body.innerHTML = '<p>They record music together.</p>';
    const paragraph = document.querySelector('p')!;
    const { visual, config } = startVisual();
    config.wordStylePriority = priority;
    await vi.waitFor(() => expect(ranges().length).toBeGreaterThan(0));
    const oldRanges = ranges();
    const text = paragraph.firstChild as Text;
    const after = text.splitText(11);
    const wordText = text.splitText(5);
    const mark = document.createElement('hnw-mark');
    const word = document.createElement('hnw-w');
    word.setAttribute('style', 'color: red;');
    const originalStyle = word.getAttribute('style');
    word.append(wordText); mark.append(word); after.before(mark);
    await vi.waitFor(() => {
      expect(ranges().some(range => selected(range) === 'music')).toBe(true);
      expect(ranges().some(range => oldRanges.includes(range))).toBe(false);
      expect(ranges().some(range => word.contains(range.startContainer))).toBe(priority === 'reading');
    });
    expect(ranges().some(range => mark.contains(range.startContainer))).toBe(priority === 'reading');
    expect(word.getAttribute('style')).toBe(originalStyle);
    expect(word.hasAttribute('data-hnw-reading-word')).toBe(priority === 'reading');
    visual.stop();
    expect(word.getAttribute('style')).toBe(originalStyle);
    expect(word.hasAttribute('data-hnw-reading-word')).toBe(false);
    expect(paragraph.textContent).toBe('They record music together.');
    expect(document.querySelector('hnw-read')).toBeNull();
  });

  it.each(['update', 'stop'] as const)('分析结果在 %s 后到达时不能恢复旧绘制', async action => {
    document.body.innerHTML = '<p>They record music together.</p>';
    let resolve!: (tokens: ReadingToken[]) => void;
    const analyze = vi.fn(() => new Promise<ReadingToken[]>(done => { resolve = done; }));
    const { visual, config } = startVisual(analyze);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const previousNames = [...registry.keys()];
    if (action === 'update') {
      config.syntax.enabled = false;
      config.emphasis.negation = true;
      visual.update(config);
    } else visual.stop();
    resolve(analyzeReading('They record music together.'));
    await new Promise(done => setTimeout(done, 100));
    expect(previousNames.every(name => !registry.has(name))).toBe(true);
    expect(ranges()).toHaveLength(0);
    expect(document.querySelector('hnw-read')).toBeNull();
  });
});
