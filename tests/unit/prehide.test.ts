import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PREHIDE_CSS_SCRIPT, setupPrehideRegistration, shouldRegisterPrehide, syncPrehideRegistration } from '@/background/prehide';
import { PREHIDE_MAX_MS, PREHIDE_READY_ATTR, PREHIDE_SCRIPT_ID, prehidePage } from '@/content/engine/prehide';
import { createDefaultSettings } from '@/core/settings/defaults';
import { normalizeSettings } from '@/core/settings/migrate';
import { saveSettings } from '@/core/settings/store';
import type { DynamicCssScript } from '@/core/platform/content-scripts';

/** 内存版 scripting 动态注册（fake-browser 未实现 scripting） */
function mockScripting() {
  const registered = new Map<string, DynamicCssScript>();
  const api = {
    registerContentScripts: vi.fn(async (scripts: DynamicCssScript[]) => {
      for (const s of scripts) {
        if (registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        registered.set(s.id, s);
      }
    }),
    updateContentScripts: vi.fn(async (scripts: DynamicCssScript[]) => {
      for (const s of scripts) registered.set(s.id, s);
    }),
    unregisterContentScripts: vi.fn(async (filter?: { ids?: string[] }) => {
      for (const id of filter?.ids ?? [...registered.keys()]) registered.delete(id);
    }),
    getRegisteredContentScripts: vi.fn(async (filter?: { ids?: string[] }) =>
      [...registered.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)),
    ),
  };
  (browser as unknown as { scripting: unknown }).scripting = api;
  return { api, registered };
}

/** 开启预隐藏且首屏会改变排版（词后译文）的设置 */
function prehideOnSettings() {
  const s = createDefaultSettings();
  s.performance.prehide = true;
  s.inlineTranslation.mode = 'after';
  return s;
}

describe('prehide 设置字段', () => {
  it('默认关闭；旧设置缺字段时按默认值补齐，已有值保留', () => {
    expect(createDefaultSettings().performance.prehide).toBe(false);
    const { performance: _p, ...legacy } = createDefaultSettings();
    expect(normalizeSettings(legacy).performance).toEqual({ prehide: false });
    expect(normalizeSettings({ ...legacy, performance: { prehide: true } }).performance.prehide).toBe(true);
  });

  it('只有开启、总开关打开且样式改变排版时才需要注册', () => {
    const s = prehideOnSettings();
    expect(shouldRegisterPrehide(s)).toBe(true);
    expect(shouldRegisterPrehide({ ...s, enabled: false })).toBe(false);
    expect(shouldRegisterPrehide({ ...s, performance: { prehide: false } })).toBe(false);
    // 不改变排版（无行内译文、默认荧光笔样式）：开启了也不注册
    expect(shouldRegisterPrehide({ ...s, inlineTranslation: { ...s.inlineTranslation, mode: 'off' } })).toBe(false);
  });
});

describe('prehide 动态注册', () => {
  let scripting: ReturnType<typeof mockScripting>;
  beforeEach(() => {
    fakeBrowser.reset();
    scripting = mockScripting();
  });

  it('按设置注册/注销，重复对齐幂等（已注册时原地更新，不先注销）', async () => {
    const on = prehideOnSettings();
    expect(await syncPrehideRegistration(on)).toBe(true);
    expect(scripting.registered.get(PREHIDE_SCRIPT_ID)).toEqual(PREHIDE_CSS_SCRIPT);
    expect(PREHIDE_CSS_SCRIPT).toMatchObject({ runAt: 'document_start', allFrames: false, css: ['/prehide.css'] });
    await syncPrehideRegistration(on);
    expect(scripting.api.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(scripting.api.updateContentScripts).toHaveBeenCalledTimes(1);
    expect(scripting.api.unregisterContentScripts).not.toHaveBeenCalled();

    expect(await syncPrehideRegistration(createDefaultSettings())).toBe(false);
    expect(scripting.registered.size).toBe(0);
    // 未注册时再次关闭不调用注销
    await syncPrehideRegistration(createDefaultSettings());
    expect(scripting.api.unregisterContentScripts).toHaveBeenCalledTimes(1);
  });

  it('并发对齐串行执行，不会重复注册同一 id', async () => {
    const on = prehideOnSettings();
    await Promise.all([syncPrehideRegistration(on), syncPrehideRegistration(on), syncPrehideRegistration(on)]);
    expect(scripting.api.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(scripting.registered.size).toBe(1);
  });

  it('scripting API 不存在时跳过（视为未注册）', async () => {
    (browser as unknown as { scripting?: unknown }).scripting = undefined;
    expect(await syncPrehideRegistration(prehideOnSettings())).toBe(false);
  });

  it('后台启动时按当前设置对齐，之后随设置变化注册/注销', async () => {
    await saveSettings(prehideOnSettings());
    setupPrehideRegistration(Promise.resolve());
    await vi.waitFor(() => expect(scripting.registered.has(PREHIDE_SCRIPT_ID)).toBe(true));

    const off = prehideOnSettings();
    off.performance.prehide = false;
    await saveSettings(off);
    await vi.waitFor(() => expect(scripting.registered.has(PREHIDE_SCRIPT_ID)).toBe(false));

    await saveSettings(prehideOnSettings());
    await vi.waitFor(() => expect(scripting.registered.has(PREHIDE_SCRIPT_ID)).toBe(true));
  });
});

describe('prehidePage（内容脚本）', () => {
  // jsdom 的 readyState 为 complete；内容脚本在 document_start 注入时页面仍在解析
  beforeEach(() => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
  });
  afterEach(() => {
    delete (document as unknown as { readyState?: unknown }).readyState;
    document.documentElement.removeAttribute(PREHIDE_READY_ATTR);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 模拟浏览器在 document_start 注入的注册样式（jsdom 不计算 animation 简写，直接给出计算结果） */
  function injectPrehideCss() {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === document.documentElement && !el.hasAttribute(PREHIDE_READY_ATTR) ? ({ animationName: 'hnw-prehide' } as CSSStyleDeclaration) : real(el, pseudo),
    );
  }

  it('隐藏样式生效时：release 加 data-hnw-ready（幂等）', () => {
    injectPrehideCss();
    const release = prehidePage(document);
    expect(document.documentElement.hasAttribute(PREHIDE_READY_ATTR)).toBe(false);
    release();
    release();
    expect(document.documentElement.hasAttribute(PREHIDE_READY_ATTR)).toBe(true);
  });

  it('隐藏样式生效时：超时兜底强制释放', () => {
    vi.useFakeTimers();
    injectPrehideCss();
    prehidePage(document);
    vi.advanceTimersByTime(PREHIDE_MAX_MS - 1);
    expect(document.documentElement.hasAttribute(PREHIDE_READY_ATTR)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.documentElement.hasAttribute(PREHIDE_READY_ATTR)).toBe(true);
  });

  it('隐藏样式未生效（默认关闭）时为空操作', () => {
    vi.useFakeTimers();
    prehidePage(document)();
    vi.advanceTimersByTime(PREHIDE_MAX_MS);
    expect(document.documentElement.hasAttribute(PREHIDE_READY_ATTR)).toBe(false);
  });
});
