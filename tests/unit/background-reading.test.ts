import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { setupBackground } from '@/background/index';
import { sendToBackground } from '@/core/messaging';

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
  setupBackground();
});
afterEach(() => vi.restoreAllMocks());

describe('后台本地阅读分析', () => {
  it('保留上下文词性和原文偏移，不发起网络请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const text = 'They record a record.';
    const tokens = await sendToBackground('analyzeReading', { text, withSyntax: true });
    expect(tokens.filter(token => token.text === 'record').map(token => token.pos)).toEqual(['verb', 'noun']);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('关闭词性时仍返回强调信息，允许长度恰为 6000 的文本', async () => {
    const tokens = await sendToBackground('analyzeReading', { text: 'However, never 42%.'.padEnd(6000), withSyntax: false });
    expect(tokens.map(token => token.emphasis)).toEqual(['connectives', 'negation', 'numbers']);
    expect(tokens.every(token => token.pos === undefined)).toBe(true);
  });

  it('超长文本通过消息错误响应拒绝分析', async () => {
    await expect(sendToBackground('analyzeReading', { text: 'a'.repeat(6001), withSyntax: true }))
      .rejects.toThrow('阅读分析单次文本不能超过 6000 个字符');
  });
});
