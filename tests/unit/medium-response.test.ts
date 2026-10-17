import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMediumResponseText } from '@/content/sites/medium/dom';
import { codeRootOf, collectTextNodes, isTextCandidate } from '@/content/engine/scanner';

// 保留用户快照中的响应卡片层级与语义属性，不依赖 Medium 的压缩类名。
const card = '<section><div><button aria-label="Response options">Options</button></div><div><pre><div><div><div>We appreciate thoughtful comments.</div></div></div></pre></div><div><span data-dd-action-name="Susi presentation tracker respond_sidebar">Reply</span></div></section>';
const environment = globalThis as typeof globalThis & { jsdom: { reconfigure(options: { url: string }): void } };
let originalUrl: string;

describe('Medium 响应正文', () => {
  beforeEach(() => { originalUrl = document.location.href; environment.jsdom.reconfigure({ url: 'https://medium.com/blog/test' }); });
  afterEach(() => { environment.jsdom.reconfigure({ url: originalUrl }); document.body.innerHTML = ''; });
  it.each([undefined, { codeEnabled: true, codeScope: 'comments' as const }, { codeEnabled: true, codeScope: 'all' as const }])('不受代码开关或注释范围限制：%j', opts => {
    document.body.innerHTML = card;
    const pre = document.querySelector('pre')!;
    const text = pre.querySelector('div div div')!.firstChild as Text;
    expect(isMediumResponseText(pre)).toBe(true);
    expect(codeRootOf(text)).toBeNull();
    expect(isTextCandidate(text, opts)).toBe(true);
    expect(collectTextNodes(pre, undefined, opts).map(node => node.data)).toEqual(['We appreciate thoughtful comments.']);
  });

  it.each([
    { url: 'https://example.com/', html: card },
    { url: 'https://medium.com/', html: '<pre><div>We appreciate thoughtful comments.</div></pre>' },
    { url: 'https://medium.com/', html: card.replace('<div>We appreciate thoughtful comments.</div>', '<code>const comments = true;</code>') },
    { url: 'https://medium.com/', html: card.replace('respond_sidebar', 'unrelated') },
  ])('普通代码或其他站点仍跳过：%j', ({ url, html }) => {
    environment.jsdom.reconfigure({ url });
    document.body.innerHTML = html;
    const pre = document.querySelector('pre')!;
    expect(isMediumResponseText(pre)).toBe(false);
    expect(collectTextNodes(pre)).toEqual([]);
    expect(codeRootOf(pre)).toBe(pre);
  });

  it.each(['<pre id="ordinary"><div>We record music.</div></pre>', '<div><pre id="ordinary"><div>We record music.</div></pre></div>'])('同页存在评论卡片时文档根也不能放行普通 pre：%s', html => {
    document.body.innerHTML = card + html;
    const pre = document.getElementById('ordinary')!;
    expect(isMediumResponseText(pre)).toBe(false);
    expect(collectTextNodes(pre)).toEqual([]);
    expect(codeRootOf(pre)).toBe(pre);
  });

  it.each(['main', 'article', 'div'])('共享 %s 中的普通 pre 不能借用另一张评论卡片', tag => {
    document.body.innerHTML = `<${tag}><div><pre id="ordinary"><div>We record music.</div></pre></div>${card}</${tag}>`;
    const pre = document.getElementById('ordinary')!;
    expect(isMediumResponseText(pre)).toBe(false);
    expect(collectTextNodes(pre)).toEqual([]);
    expect(codeRootOf(pre)).toBe(pre);
    expect(isMediumResponseText(document.querySelector('section pre')!)).toBe(true);
  });
});
