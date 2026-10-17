import { effectScope, nextTick, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '@/core/settings/defaults';
import type { Settings } from '@/core/settings/schema';
import { useSettings } from '@/ui/composables/useSettings';

const store = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), watch: vi.fn(), unwatch: vi.fn() }));
vi.mock('@/core/settings/store', () => ({ getSettings: store.get, saveSettings: store.save, watchSettings: store.watch }));

let persisted: Settings;
let notify: (settings: Settings) => void;
let scope: EffectScope;
let ui: ReturnType<typeof useSettings>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function write(value: Settings) {
  persisted = { ...copy(value), updatedAt: persisted.updatedAt + 1 };
  notify(copy(persisted));
}

async function setup() {
  scope = effectScope();
  ui = scope.run(() => useSettings())!;
  await ui.ready;
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  persisted = createDefaultSettings();
  store.get.mockImplementation(async () => copy(persisted));
  store.save.mockImplementation(async (value: Settings) => write(value));
  store.watch.mockImplementation((listener: typeof notify) => { notify = listener; return store.unwatch; });
});
afterEach(() => { scope?.stop(); vi.useRealTimers(); });

describe('useSettings 保存时序', () => {
  it('防抖期间收到旧存储回流时保留本地编辑', async () => {
    await setup();
    ui.settings.value!.reading.bionic.ratio = 0.65;
    await nextTick();
    notify({ ...copy(persisted), updatedAt: 1 });
    await nextTick();
    expect(ui.settings.value!.reading.bionic.ratio).toBe(0.65);
    await vi.advanceTimersByTimeAsync(150);
    expect(persisted.reading.bionic.ratio).toBe(0.65);
  });

  it('旧保存尚未完成时的新编辑不会被旧echo覆盖，第二次保存包含全部修改', async () => {
    await setup();
    let finishFirst!: () => void;
    store.save.mockImplementationOnce((value: Settings) => new Promise<void>(resolve => {
      finishFirst = () => { write(value); resolve(); };
    }));
    ui.settings.value!.reading.syntax.colors.verb = '#123456';
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    ui.settings.value!.reading.bionic.ratio = 0.65;
    await nextTick();
    finishFirst();
    await nextTick();
    expect(ui.settings.value!.reading.bionic.ratio).toBe(0.65);
    ui.settings.value!.reading.phrases.enabled = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(persisted.reading).toMatchObject({ syntax: { colors: { verb: '#123456' } }, bionic: { ratio: 0.65 }, phrases: { enabled: true } });
  });

  it('串行保存确保前一次慢请求不能在新请求之后落库', async () => {
    await setup();
    let finishFirst!: () => void;
    store.save.mockImplementationOnce((value: Settings) => new Promise<void>(resolve => {
      finishFirst = () => { write(value); resolve(); };
    }));
    ui.settings.value!.reading.enabled = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    ui.settings.value!.reading.bionic.ratio = 0.7;
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    expect(store.save).toHaveBeenCalledTimes(1);
    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(persisted.reading.bionic.ratio).toBe(0.7);
  });

  it('没有本地编辑时正常接收跨上下文更新，且不回写', async () => {
    await setup();
    const incoming = copy(persisted);
    incoming.reading.enabled = true;
    incoming.updatedAt = 8;
    notify(incoming);
    await nextTick();
    expect(ui.settings.value!.reading.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('保存后同步时间戳且不形成循环，再次编辑照常保存', async () => {
    await setup();
    ui.settings.value!.reading.enabled = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    expect(ui.settings.value!.updatedAt).toBe(1);
    ui.settings.value!.reading.bionic.ratio = 0.6;
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    expect(persisted.reading.bionic.ratio).toBe(0.6);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it('离开页面取消尚未执行的防抖保存和订阅', async () => {
    await setup();
    ui.settings.value!.reading.enabled = true;
    await nextTick();
    scope.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.unwatch).toHaveBeenCalledOnce();
  });
});
