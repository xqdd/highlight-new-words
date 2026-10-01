import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ShadowCardView } from '@/content/card/card-view';
import { speakWord } from '@/content/card/speak';
import type { CardActions } from '@/content/card/types';
import { addNotice, type CardBackend } from '@/content/card/word-actions';
import { sendToBackground } from '@/core/messaging';
import type { AddWordResult } from '@/core/messaging/protocol';
import { speakText } from '@/core/platform/tts';
import { createDefaultSettings } from '@/core/settings/defaults';
import { STORAGE_KEYS } from '@/core/storage/keys';

/**
 * card 修复轮：C4 右键菜单结果 toast（actionNotice）、C5 发音页面兜底、C6 加入生词本单处失败写出本名。
 * C1–C3（悬停延迟、Ctrl+点击链接、首次提示）见 card-trigger.test.ts “card 修复轮”。
 */

vi.mock('@/core/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/messaging')>()),
  sendToBackground: vi.fn(),
}));
vi.mock('@/core/platform/tts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/platform/tts')>()),
  speakText: vi.fn(async () => ({ spoken: true, engine: 'speech' })),
}));
// 站点适配层与悬浮球（floatball 模块）与本用例无关
vi.mock('@/content/sites/context', () => ({ startPageExtras: () => ({ settingsChanged() {} }) }));

const send = vi.mocked(sendToBackground);
const speak = vi.mocked(speakText);
const tts = createDefaultSettings().tts;

describe('C5 卡片发音：后台 unavailable 时页面内兜底', () => {
  beforeEach(() => {
    send.mockReset();
    speak.mockClear();
  });

  it('后台返回 {spoken:false, reason:unavailable}：调用 speakText 一次（带设置中的语音与语速）', async () => {
    send.mockResolvedValue({ spoken: false, reason: 'unavailable' } as never);
    await speakWord('abandon', true, { ...tts, rate: 1.2 });
    expect(send).toHaveBeenCalledWith('tts', { text: 'abandon', force: true });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('abandon', { lang: 'en', rate: 1.2 });
  });

  it('后台正常朗读、自动发音关闭或出错：不兜底', async () => {
    for (const res of [{ spoken: true }, { spoken: false, reason: 'disabled' }, { spoken: false, reason: 'error' }]) {
      send.mockResolvedValue(res as never);
      await speakWord('abandon', false, tts);
    }
    expect(speak).not.toHaveBeenCalled();
  });

  it('后台不可达（扩展已重载）：静默，不抛错', async () => {
    send.mockRejectedValue(new Error('Extension context invalidated.'));
    await expect(speakWord('abandon', true, tts)).resolves.toBeUndefined();
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('C4 右键菜单结果 toast', () => {
  const actions = { speak() {}, markKnown: async () => ({}), unmarkKnown: async () => {}, deleteFromSources: async () => ({}) } as unknown as CardActions;
  const pending = () => new Promise<never>(() => {});
  const backend = { getWordState: pending, preview: pending, listAddTargets: pending, sourceStates: pending } as unknown as CardBackend;
  const toast = () => document.querySelector('hnw-card-host')!.shadowRoot!.querySelector<HTMLElement>('.toast')!;

  afterEach(() => {
    document.querySelectorAll('hnw-card-host').forEach((n) => n.remove());
  });

  it('showMessage：ok=false 用错误样式，主行为 message 第一段，其余进详情；卡片无需打开', () => {
    const view = new ShadowCardView(document, actions, backend);
    view.showMessage('“欧路词典 · 已掌握单词”只读，无法写入；请在设置中更换目标', false, 'run');
    expect(toast().hidden).toBe(false);
    expect(toast().classList.contains('err')).toBe(true);
    expect(toast().textContent).toContain('「run」：“欧路词典 · 已掌握单词”只读，无法写入');
    expect(view.isOpen).toBe(false);
    view.showMessage('已加入“我的生词本”', true, 'run');
    expect(toast().classList.contains('ok')).toBe(true);
    expect(toast().textContent).toContain('「run」已加入“我的生词本”');
    // 选区不是单词时后台没有 lemma：不加前缀
    view.showMessage('请只选中一个英文单词', false, '');
    expect(toast().textContent).toContain('请只选中一个英文单词');
    expect(toast().textContent).not.toContain('「');
    view.destroy();
  });

  it('内容脚本注册 actionNotice：后台发出 {ok:false, message:…只读…} 后页面出现错误 toast', async () => {
    fakeBrowser.reset();
    // 关闭总开关：不启动引擎（不加载词书），只验证消息接线
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: { ...createDefaultSettings(), enabled: false } });
    const { startContentApp } = await import('@/content/app');
    await startContentApp();
    await fakeBrowser.runtime.sendMessage({
      ns: 'hnw',
      type: 'actionNotice',
      data: { action: 'known', word: 'run', lemma: 'run', ok: false, message: '未能写入“欧路词典 · 已掌握单词”：只读' },
    });
    expect(toast().hidden).toBe(false);
    expect(toast().classList.contains('err')).toBe(true);
    expect(toast().textContent).toContain('只读');
  });
});

describe('C6 加入生词本部分失败的主行', () => {
  const base: AddWordResult = {
    ok: true,
    lemma: 'run',
    added: [{ bookId: 'local:mine', name: '我的生词本', ok: true, words: ['run'] }],
    removedKnown: [],
    message: '已加入“我的生词本”',
  };

  it('只有一处失败：主行写出失败的本名', () => {
    const one = {
      ...base,
      added: [...base.added, { bookId: 'src:eudic:t', name: '欧路·测试', ok: false, words: [], error: 'HTTP 500' }],
      message: '已加入“我的生词本”；“欧路·测试”失败：HTTP 500',
    };
    expect(addNotice(one, 'run')).toEqual({
      level: 'warn',
      title: '部分失败：「run」已加入“我的生词本”，“欧路·测试”加入失败',
      details: ['“欧路·测试”失败：HTTP 500'],
    });
    // 失败的是“从熟词本移出”
    const rm = { ...base, removedKnown: [{ bookId: 'known:local', name: '本地熟词本', ok: false, words: [], error: '写入失败' }] };
    expect(addNotice(rm, 'run').title).toBe('部分失败：「run」已加入“我的生词本”，未能从“本地熟词本”移出');
    // 同时有跳过：仍带“N 处跳过”
    const withSkip = { ...one, added: [...one.added, { bookId: 'src:youdao:9', name: '有道 · 托福', ok: false, words: [], error: '只读', skipped: true }] };
    expect(addNotice(withSkip, 'run').title).toBe('部分失败：「run」已加入“我的生词本”，“欧路·测试”加入失败（1 处跳过）');
  });

  it('多处失败：保持“N 处失败”，逐项在详情', () => {
    const two = {
      ...base,
      added: [
        ...base.added,
        { bookId: 'src:eudic:t', name: '欧路·测试', ok: false, words: [], error: 'HTTP 500' },
        { bookId: 'src:youdao:0', name: '有道 · 无标签', ok: false, words: [], error: '未登录' },
      ],
      message: '已加入“我的生词本”；“欧路·测试”失败：HTTP 500；“有道 · 无标签”失败：未登录',
    };
    expect(addNotice(two, 'run')).toEqual({
      level: 'warn',
      title: '部分失败：「run」已加入“我的生词本”（2 处失败）',
      details: ['“欧路·测试”失败：HTTP 500', '“有道 · 无标签”失败：未登录'],
    });
  });
});
