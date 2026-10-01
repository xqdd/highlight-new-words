import { describe, expect, it } from 'vitest';
import { createSkipRule } from '@/content/sites/youtube/dom';

describe('YouTube 页面跳过规则：m.youtube.com 评论正文', () => {
  it('评论正文外层的 button 放行，其内部“Read more”等真正按钮仍跳过', () => {
    // 2026-10 实测结构：ytm-comment-renderer > button.YtmCommentRendererContent > p > span，Read more 在 ytm-button-renderer > button 里
    document.body.innerHTML = `<ytm-comment-renderer><button class="YtmCommentRendererContent"><p class="YtmCommentRendererText"><span>We have a prompt engineer</span></p>
      <ytm-button-renderer class="YtmCommentRendererExpand"><button>Read more</button></ytm-button-renderer></button></ytm-comment-renderer>
      <div><button id="plain">Subscribe</button></div>`;
    const rule = createSkipRule(() => true);
    expect(rule(document.querySelector('.YtmCommentRendererContent')!)).toBe(false);
    expect(rule(document.querySelector('ytm-button-renderer')!)).toBe(true);
    expect(rule(document.getElementById('plain')!)).toBe(true);
  });
});
