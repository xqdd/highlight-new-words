import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultReadingSettings } from '@/core/reading/settings';
import { trackScrollActivity, waitForScrollQuiet } from '@/content/scroll-activity';
import { createReadingTools } from '@/content/reading';

const calls = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(), update: vi.fn(), stop: vi.fn() }));
vi.mock('@/content/reading/visual', () => ({
  ReadingVisual: class {
    constructor(...args: unknown[]) { calls.create(...args); }
    start = calls.start;
    update = calls.update;
    stop = calls.stop;
  },
}));

describe('晚启动的样式安装', () => {
  let release: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    release = trackScrollActivity(window);
  });
  afterEach(() => { release(); vi.useRealTimers(); });

  it('等待至少一个渲染机会，并随最新输入延长到100ms，取消后释放计时器', async () => {
    const quiet = vi.fn();
    const control = new AbortController();
    void waitForScrollQuiet(window, control.signal).then(quiet);
    expect(quiet).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('wheel'));
    await vi.advanceTimersByTimeAsync(60);
    window.dispatchEvent(new Event('touchmove'));
    await vi.advanceTimersByTimeAsync(60);
    expect(quiet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    expect(quiet).toHaveBeenCalledWith(true);
    const pending = new AbortController();
    const cancelled = waitForScrollQuiet(window, pending.signal);
    pending.abort();
    expect(await cancelled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('首次创建与重建均等待停稳，更新中的旧视觉保留，过期设置不会提交', async () => {
    const tools = createReadingTools(document);
    const settings = createDefaultReadingSettings();
    settings.enabled = true; settings.bionic.enabled = true; settings.phrases.enabled = false;
    try {
      window.dispatchEvent(new Event('wheel'));
      tools.update(settings);
      await vi.advanceTimersByTimeAsync(60);
      expect(calls.create).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      expect(calls.create).toHaveBeenCalledTimes(1);
      expect(calls.start).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('wheel'));
      tools.update({ ...settings, bionic: { ...settings.bionic, ratio: 0.3 } });
      await vi.advanceTimersByTimeAsync(60);
      expect(calls.stop).not.toHaveBeenCalled();
      expect(calls.update).not.toHaveBeenCalled();
      const latest = { ...settings, bionic: { ...settings.bionic, ratio: 0.7 } };
      tools.update(latest);
      await vi.advanceTimersByTimeAsync(40);
      expect(calls.update).toHaveBeenCalledTimes(1);
      expect(calls.update).toHaveBeenCalledWith(latest);
    } finally { tools.stop(); }
  });

  it.each(['disable', 'stop'])('%s 立即取消待创建或待重建的视觉', async action => {
    const tools = createReadingTools(document);
    const settings = createDefaultReadingSettings();
    settings.enabled = true; settings.bionic.enabled = true; settings.phrases.enabled = false;
    try {
      window.dispatchEvent(new Event('wheel'));
      tools.update(settings);
      if (action === 'disable') tools.update({ ...settings, enabled: false }); else tools.stop();
      await vi.advanceTimersByTimeAsync(150);
      expect(calls.create).not.toHaveBeenCalled();
      tools.update(settings);
      await vi.advanceTimersByTimeAsync(40);
      expect(calls.create).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('wheel'));
      tools.update({ ...settings, bionic: { ...settings.bionic, ratio: 0.7 } });
      if (action === 'disable') tools.update({ ...settings, enabled: false }); else tools.stop();
      expect(calls.stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(calls.update).not.toHaveBeenCalled();
    } finally { tools.stop(); }
  });
});
