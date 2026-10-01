import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultSettings } from '@/core/settings/defaults';
import type { Settings } from '@/core/settings/schema';
import { provideOptions } from '@/entrypoints/options/lib/context';
import { sourceConnectFeedback } from '@/entrypoints/options/lib/source-card';
import { toast } from '@/entrypoints/options/lib/toast';

/**
 * 启用即连接：选项页把来源从关切到开时立即同步一次该来源并反馈结果。
 * 消息与 Firefox 授权用 mock 替换，只验证选项页的行为。
 */
const send = vi.hoisted(() => vi.fn());
vi.mock('@/core/messaging', () => ({ sendToBackground: send }));
vi.mock('@/core/platform', () => ({ requestDataCollection: vi.fn(async () => true) }));

const { default: SourcesSection } = await import('@/entrypoints/options/sections/SourcesSection.vue');

function mountSources(settings = ref<Settings>(createDefaultSettings())) {
  const el = document.createElement('div');
  document.body.append(el);
  const Root = defineComponent({
    setup() {
      provideOptions({ settings, books: ref([]), navigate: () => {} });
      return () => h(SourcesSection);
    },
  });
  const app = createApp(Root);
  app.mount(el);
  return { el, settings, unmount: () => { app.unmount(); el.remove(); } };
}

const toggleOf = (el: HTMLElement, name: string) => el.querySelector<HTMLInputElement>(`label[aria-label="启用${name}"] input`)!;

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  toast.current = null;
});
afterEach(() => vi.useRealTimers());

describe('sourceConnectFeedback', () => {
  it('全部成功：本数与词数', () => {
    const fb = sourceConnectFeedback('有道词典', [
      { bookId: 'src:youdao:0', ok: true, message: '', count: 1200 },
      { bookId: 'src:youdao:1', ok: true, message: '', count: 34 },
    ], false);
    expect(fb).toMatchObject({ tone: 'info', login: false });
    expect(fb.message).toMatch(/^已连接有道词典：同步 2 本，共 1,?234 词$/);
  });

  it('未登录：给出原因与去登录入口；填了 token 的来源不给网页登录入口', () => {
    const results = [{ bookId: 'src:youdao:', ok: false, message: '未登录有道或登录已失效，请先登录有道单词本网页版' }];
    expect(sourceConnectFeedback('有道词典', results, false)).toEqual({
      message: '有道词典连接失败：未登录有道或登录已失效，请先登录有道单词本网页版',
      tone: 'error',
      login: true,
    });
    expect(sourceConnectFeedback('欧路词典', results, true).login).toBe(false);
  });

  it('没有任何生词本：提示确认登录', () => {
    expect(sourceConnectFeedback('有道词典', [], false)).toMatchObject({ tone: 'error', login: true });
  });
});

describe('选项页：开启来源即连接', () => {
  it('默认两个来源都关闭；打开有道后立即同步有道并提示结果', async () => {
    send.mockResolvedValue([{ bookId: 'src:youdao:0', ok: true, message: '', count: 12 }]);
    const { el, settings, unmount } = mountSources();
    const input = toggleOf(el, '有道词典');
    expect(input.checked).toBe(false);
    expect(toggleOf(el, '欧路词典').checked).toBe(false);
    input.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('syncSourceBooks', { providerId: 'youdao' }), { timeout: 2000 });
    expect(settings.value.sources.youdao!.enabled).toBe(true);
    await vi.waitFor(() => expect(toast.current?.message).toBe('已连接有道词典：同步 1 本，共 12 词'));
    unmount();
  });

  it('同步失败（未登录）：提示原因并附“去登录”，点击打开登录页', async () => {
    send.mockResolvedValue([{ bookId: 'src:youdao:', ok: false, message: '未登录有道或登录已失效，请先登录有道单词本网页版' }]);
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const { el, unmount } = mountSources();
    toggleOf(el, '有道词典').click();
    await vi.waitFor(() => expect(toast.current?.tone).toBe('error'), { timeout: 2000 });
    expect(toast.current?.message).toContain('未登录有道');
    expect(toast.current?.action?.label).toBe('去登录');
    toast.current!.action!.run();
    expect(create).toHaveBeenCalledWith({ url: 'https://dict.youdao.com/wordbook/wordlist' });
    unmount();
  });

  it('关闭来源不发请求；已启用来源重新渲染不会触发同步', async () => {
    const s = createDefaultSettings();
    s.sources.youdao!.enabled = true;
    const { el, settings, unmount } = mountSources(ref(s));
    await nextTick();
    toggleOf(el, '有道词典').click();
    await new Promise((r) => setTimeout(r, 600));
    expect(settings.value.sources.youdao!.enabled).toBe(false);
    expect(send).not.toHaveBeenCalledWith('syncSourceBooks', expect.anything());
    unmount();
  });
});
