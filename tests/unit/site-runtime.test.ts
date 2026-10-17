import { afterEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultSettings } from '@/core/settings/defaults';
import { STORAGE_KEYS } from '@/core/storage/keys';

const calls = vi.hoisted(() => ({ engineStart: vi.fn(), engineStop: vi.fn(), readingUpdate: vi.fn(), readingStop: vi.fn() }));
vi.mock('@/content/sites/context', () => ({ startPageExtras: () => ({ settingsChanged() {} }) }));
vi.mock('@/core/lemma', () => ({ createLemmatizer: () => ({ candidates: (word: string) => [word] }) }));
vi.mock('@/content/card/trigger', () => ({ bindCardTrigger() {} }));
vi.mock('@/content/card/card-view', () => ({ ShadowCardView: class { setStyle() {} close() {} } }));
vi.mock('@/content/reading', () => ({ createReadingTools: () => ({ update: calls.readingUpdate, stop: calls.readingStop }) }));
vi.mock('@/content/engine/engine', () => ({ HighlightEngine: class {
  matchedLemmas = [];
  start = calls.engineStart;
  stop = calls.engineStop;
  async primeFirstScreen() {}
  setCode() {} rebuild() {} setInlineTranslation() {} refreshMatches() {}
} }));

afterEach(() => { fakeBrowser.reset(); document.body.innerHTML = ''; vi.clearAllMocks(); });

it('SPA URL 与存储变化分别启停高亮和阅读，独立阅读不被高亮停启影响，总开关关闭两者', async () => {
  fakeBrowser.reset();
  document.body.innerHTML = '<p>Article body remains available.</p>';
  history.replaceState({}, '', '/blocked');
  const settings = createDefaultSettings();
  settings.books.enabled = []; settings.knownBooks.enabled = []; settings.inlineTranslation.mode = 'off';
  settings.reading.enabled = true;
  settings.sites.disabled = [`glob:${location.origin}/blocked**`];
  settings.readingSites = { mode: 'all', disabled: [], allowed: [] };
  await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  const { startContentApp } = await import('@/content/app');
  let locationChanged!: () => void;
  await startContentApp({ onLocationChange: callback => { locationChanged = callback; } });
  await vi.waitFor(() => expect(calls.readingUpdate).toHaveBeenCalled());
  expect(calls.engineStart).not.toHaveBeenCalled();

  history.pushState({}, '', '/allowed'); locationChanged();
  await vi.waitFor(() => expect(calls.engineStart).toHaveBeenCalledTimes(1));
  history.pushState({}, '', '/blocked'); locationChanged();
  expect(calls.engineStop).toHaveBeenCalledTimes(1);
  expect(calls.readingStop).not.toHaveBeenCalled();

  settings.readingSites.disabled = [location.hostname];
  await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  await vi.waitFor(() => expect(calls.readingStop).toHaveBeenCalledTimes(1));
  const beforeEnable = calls.readingUpdate.mock.calls.length;
  settings.readingSites.disabled = [];
  await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  await vi.waitFor(() => expect(calls.readingUpdate.mock.calls.length).toBeGreaterThan(beforeEnable));

  settings.enabled = false;
  await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  await vi.waitFor(() => expect(calls.readingStop).toHaveBeenCalledTimes(2));
  settings.enabled = true; delete settings.readingSites;
  await fakeBrowser.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls.engineStart).toHaveBeenCalledTimes(1);
  expect(calls.readingStop).toHaveBeenCalledTimes(2);
  history.pushState({}, '', '/allowed'); locationChanged();
  await vi.waitFor(() => expect(calls.engineStart).toHaveBeenCalledTimes(2));
  expect(calls.readingUpdate.mock.calls.length).toBeGreaterThan(beforeEnable);
});
