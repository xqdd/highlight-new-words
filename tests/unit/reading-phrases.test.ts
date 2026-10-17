import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { lookupReadingPhrase, normalizeReadingPhrase, ReadingPhrasesController } from '../../src/content/reading/phrases';

afterEach(() => { document.getSelection()?.removeAllRanges(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('本地固定短语释义', () => {
  it('只接受2–8个英文词的连续选区', () => {
    expect(normalizeReadingPhrase('  In\u00a0spite of ')).toBe('in spite of');
    for (const text of ['word', 'as a result.', 'one\ntwo', 'a b c d e f g h i', '中文']) expect(normalizeReadingPhrase(text)).toBeUndefined();
  });

  it('数据覆盖常用整体表达并保留固定来源', () => {
    const data = JSON.parse(fs.readFileSync('public/data/reading-phrases.json', 'utf8'));
    expect(data.source.commit).toBe('bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b');
    expect(data.source.license).toBe('MIT');
    for (const phrase of ['give up', 'look up', 'as a result', 'in spite of', 'on the other hand', 'take into account', 'in other words', 'used to', 'be used to', 'give rise to', 'in light of', 'be subject to']) expect(data.entries[phrase]).toMatch(/[\u4e00-\u9fff]/);
    expect(lookupReadingPhrase(data, 'is subject to')).toBe(data.entries['be subject to']);
    expect(lookupReadingPhrase(data, 'are used to')).toBe('习惯于');
    expect(lookupReadingPhrase(data, 'used to')).toMatch(/过去/);
    expect(lookupReadingPhrase(data, 'not in the dictionary')).toBeUndefined();
    expect(Object.keys(data.entries).length).toBeGreaterThan(1000);
  });

  it('跨inline选择精确释义，禁用后移除浮层且不改原文', async () => {
    document.body.innerHTML = '<p>as <em>a</em> result</p>';
    const paragraph = document.querySelector('p')!;
    const before = paragraph.outerHTML;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.getBoundingClientRect = () => ({ left: 40, top: 30, bottom: 50 } as DOMRect);
    document.getSelection()!.addRange(range);
    const load = vi.fn(async () => ({ entries: { 'as a result': '结果' } }));
    const controller = new ReadingPhrasesController({ load });
    controller.update({ enabled: true });
    document.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-hnw-ui="reading-phrase"]')).not.toBeNull());
    expect(paragraph.outerHTML).toBe(before);
    expect(load).toHaveBeenCalledOnce();
    // 移动端延迟到达、但并未移动选区的 scroll 通知不能关掉刚出现的浮层。
    window.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[data-hnw-ui="reading-phrase"]')).not.toBeNull();
    range.getBoundingClientRect = () => ({ left: 40, top: 130, bottom: 150 } as DOMRect);
    window.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[data-hnw-ui="reading-phrase"]')).toBeNull();
    controller.update({ enabled: false });
    expect(document.querySelector('[data-hnw-ui="reading-phrase"]')).toBeNull();
    controller.dispose();
  });

  it('拒绝链接与编辑器选区', async () => {
    document.body.innerHTML = '<a>give up</a>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('a')!);
    document.getSelection()!.addRange(range);
    const load = vi.fn(async () => ({ entries: {} }));
    const controller = new ReadingPhrasesController({ load });
    controller.update({ enabled: true });
    document.dispatchEvent(new Event('pointerup'));
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('词典加载期间关闭不会重新弹出', async () => {
    document.body.innerHTML = '<p>give up</p>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    range.getBoundingClientRect = () => ({ left: 40, top: 30, bottom: 50 } as DOMRect);
    document.getSelection()!.addRange(range);
    let resolve!: (value: { entries: Record<string, string> }) => void;
    const controller = new ReadingPhrasesController({ load: () => new Promise(done => { resolve = done; }) });
    controller.update({ enabled: true });
    document.dispatchEvent(new Event('pointerup'));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    resolve({ entries: { 'give up': '放弃' } });
    await Promise.resolve();
    expect(document.querySelector('[data-hnw-ui="reading-phrase"]')).toBeNull();
    controller.dispose();
  });
});
