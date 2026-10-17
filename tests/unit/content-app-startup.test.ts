import { afterEach, expect, it, vi } from 'vitest';
import type { Settings } from '@/core/settings/schema';
import type { EngineOptions } from '@/content/engine/engine';
import { createDefaultSettings } from '@/core/settings/defaults';
import { startContentApp } from '@/content/app';

const state = vi.hoisted(() => ({
  settings: undefined as Settings | undefined,
  change: undefined as ((changes: Record<string, unknown>, area: string) => Promise<void>) | undefined,
  engines: [] as EngineOptions[],
  loaded: [] as string[],
  quietCalls: 0,
  styled: vi.fn(),
  refreshes: [] as Promise<Settings>[],
}));
vi.mock('wxt/browser', () => ({ browser: { storage: { onChanged: { addListener: (listener: typeof state.change) => { state.change = listener; } } } } }));
vi.mock('@/core/settings/store', () => ({ getSettings: () => state.refreshes.shift() ?? Promise.resolve(state.settings), isSiteDisabled: () => false, isReadingSiteDisabled: () => false }));
vi.mock('@/core/known/store', () => ({ getKnownWordSets: async () => ({ words: new Set(), builtin: new Set() }) }));
vi.mock('@/core/lemma', async () => {
  const { SimpleLemmatizer } = await import('@/core/lemma/simple');
  return { createLemmatizer: () => new SimpleLemmatizer() };
});
vi.mock('@/core/wordbook/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/core/wordbook/registry')>();
  return {
    ...actual,
    createExtensionLoaders: () => ({ book: async () => ({ words: [] }) }),
    DefaultWordBookRegistry: class {
      async load(id: string) {
        state.loaded.push(id);
        return actual.createSetWordBook({ id, name: id, nameEn: id, short: id, kind: 'builtin', category: 'exam', level: 1, size: 1 }, [id === 'cet4' ? 'abandon' : 'premise']);
      }
    },
  };
});
vi.mock('@/content/scroll-activity', async importOriginal => {
  const actual = await importOriginal<typeof import('@/content/scroll-activity')>();
  return { ...actual, waitForScrollQuiet: (...args: Parameters<typeof actual.waitForScrollQuiet>) => { state.quietCalls++; return actual.waitForScrollQuiet(...args); } };
});
vi.mock('@/content/engine/engine', () => ({ HighlightEngine: class {
  constructor(options: EngineOptions) { state.engines.push(options); }
  start() {}
  stop() {}
  async primeFirstScreen() {}
} }));
vi.mock('@/content/engine/style', () => ({ applyPageStyle: state.styled, removePageStyle: vi.fn() }));
vi.mock('@/content/sites/context', () => ({ startPageExtras: () => ({ settingsChanged() {} }) }));
vi.mock('@/content/card/card-view', () => ({ ShadowCardView: class { setStyle() {} close() {} } }));
vi.mock('@/content/card/trigger', () => ({ bindCardTrigger: vi.fn() }));
vi.mock('@/core/messaging', () => ({ handleContentMessages: vi.fn(), sendToBackground: vi.fn() }));

const flushPromises = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

it('启动等待期间仍处理关闭与词书变化，静止后只提交按最新词书重建的匹配器', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p>abandon the premise</p>';
  const initial = createDefaultSettings();
  initial.enabled = true; initial.books.enabled = ['cet4']; initial.knownBooks.enabled = [];
  initial.inlineTranslation.mode = 'off'; initial.reading.enabled = false;
  state.settings = initial;
  const starting = startContentApp();
  await flushPromises();
  expect(state.change).toBeDefined();
  expect(state.quietCalls).toBe(1);
  window.dispatchEvent(new Event('wheel'));
  let resolveFirst!: (settings: Settings) => void;
  let resolveSecond!: (settings: Settings) => void;
  state.refreshes.push(new Promise(resolve => { resolveFirst = resolve; }));
  const changing = state.change!({ settings: {} }, 'local');
  await flushPromises();
  await vi.advanceTimersByTimeAsync(60);
  window.dispatchEvent(new Event('wheel'));
  expect(state.engines).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  await flushPromises();
  // 启动循环此时等待 P1；P2 在等待中替换 settingsReady，P1 完成不能被当作最新设置已就绪。
  state.refreshes.push(new Promise(resolve => { resolveSecond = resolve; }));
  const changingAgain = state.change!({ settings: {} }, 'local');
  resolveFirst(initial);
  await flushPromises();
  expect(state.loaded).toEqual(['cet4']);
  expect(state.engines).toHaveLength(0);
  state.settings = { ...initial, books: { ...initial.books, enabled: ['cet6'] } };
  resolveSecond(state.settings);
  await flushPromises();
  await vi.advanceTimersByTimeAsync(40);
  await starting; await changing; await changingAgain;
  expect(state.loaded).toEqual(['cet4', 'cet6']);
  expect(state.engines).toHaveLength(1);
  expect(state.engines[0]!.matcher.match('premise')?.lemma).toBe('premise');
  expect(state.engines[0]!.matcher.match('abandon')).toBeNull();

  // 后续重新启用也共用已注册监听；持续输入时关闭必须取消等待，不能等滚动结束才响应。
  state.settings = { ...state.settings, enabled: false };
  await state.change!({ settings: {} }, 'local');
  state.settings = { ...state.settings, enabled: true };
  window.dispatchEvent(new Event('wheel'));
  const restarting = state.change!({ settings: {} }, 'local');
  await flushPromises();
  state.settings = { ...state.settings, enabled: false };
  await state.change!({ settings: {} }, 'local');
  await restarting;
  expect(state.engines).toHaveLength(1);
  expect(state.styled).toHaveBeenCalledTimes(1);

  let resolveOld!: (settings: Settings) => void;
  let resolveNew!: (settings: Settings) => void;
  state.refreshes.push(new Promise(resolve => { resolveOld = resolve; }), new Promise(resolve => { resolveNew = resolve; }));
  const older = state.change!({ settings: {} }, 'local');
  const newer = state.change!({ settings: {} }, 'local');
  const latest = { ...initial, enabled: false, books: { ...initial.books, enabled: ['cet4'] } };
  resolveNew(latest); await newer;
  resolveOld({ ...initial, enabled: true, books: { ...initial.books, enabled: ['cet6'] } }); await older;
  const current = (globalThis as unknown as { __hnw: { settings: Settings } }).__hnw.settings;
  expect(current.enabled).toBe(false);
  expect(current.books.enabled).toEqual(['cet4']);
  expect(state.engines).toHaveLength(1);
});
