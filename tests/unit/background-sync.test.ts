import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getKnownWords, setKnownWords } from '@/core/known/store';
import { getSettings, patchSettings, runMigrationIfNeeded } from '@/core/settings/store';
import { encodeSyncValue, syncItemBytes } from '@/core/sync/codec';
import { fromLocalBookSegment } from '@/core/sync/merge';
import { StorageSyncService } from '@/core/sync/service';
import { DEFAULT_SYNC_QUOTA, SYNC_MANIFEST_KEY, type SyncManifest } from '@/core/sync/types';
import { getLocalBook, saveLocalBook } from '@/core/wordbook/user-store';
import { badgeText, getTabWords, pageKey, reportFrameWords, setupBadge, shouldClearOnUrlChange } from '@/background/badge';
import { speak } from '@/background/tts';

/** 扩展包内置词书的真实单词（用于按真实压缩率测试配额） */
function realWords(): string[] {
  const dir = resolve(__dirname, '../../public/data/books');
  const set = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      for (const w of (JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as { words?: string[] }).words ?? []) set.add(w);
    } catch {
      // 其他分片正在改写的数据文件，跳过
    }
  }
  return [...set];
}

const fast = () => new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 });

/** 模拟换一台设备：清空本机 storage.local（含设备 id），保留 storage.sync */
async function switchDevice() {
  await fakeBrowser.storage.local.clear();
}

beforeEach(() => fakeBrowser.reset());
afterEach(() => vi.restoreAllMocks());

describe('storage.sync：多设备与容错', () => {
  it('新设备全新安装（默认设置 updatedAt=0）不会用默认值覆盖远端设置', async () => {
    await runMigrationIfNeeded();
    await patchSettings({ inlineTranslation: { mode: 'ruby' } });
    await fast().syncNow();
    await switchDevice();
    await runMigrationIfNeeded();
    expect((await getSettings()).updatedAt).toBe(0);
    await fast().syncNow();
    expect((await getSettings()).inlineTranslation.mode).toBe('ruby');
    const remote = (await fakeBrowser.storage.sync.get(null))[SYNC_MANIFEST_KEY] as SyncManifest;
    expect(remote.segs.settings).toBeDefined();
  });

  it('旧版数据迁移的 updatedAt=1：只胜过全新默认值，不覆盖其他设备的真实修改', async () => {
    await fakeBrowser.storage.local.set({ toggle: false, ttsVoices: { lang: 'en' } });
    await runMigrationIfNeeded();
    const s = await getSettings();
    expect(s.updatedAt).toBe(1);
    expect(s.enabled).toBe(false);
  });

  it('段哈希与 manifest 不一致（两台设备并发写）时跳过该段，其余段照常合并，随后推送修复', async () => {
    await patchSettings({ inlineTranslation: { mode: 'after' } });
    await setKnownWords(['apple'], true);
    await fast().syncNow();
    // 用另一份合法数据替换 known 切片，manifest 哈希不再匹配
    await fakeBrowser.storage.sync.set({ 'hnw:known:0': await encodeSyncValue({ words: { evil: 1 }, removed: {} }) });
    await switchDevice();
    const status = await fast().syncNow();
    expect(status.phase).toBe('idle');
    expect((await getSettings()).inlineTranslation.mode).toBe('after');
    expect((await getKnownWords()).has('evil')).toBe(false);
    // 本机推送后远端 known 段与 manifest 一致
    const all = await fakeBrowser.storage.sync.get(null);
    const m = all[SYNC_MANIFEST_KEY] as SyncManifest;
    expect(m.segs.known!.n).toBe(1);
  });

  it('切片内容损坏（无法解码）不抛错', async () => {
    await setKnownWords(['apple'], true);
    await fast().syncNow();
    await fakeBrowser.storage.sync.set({ 'hnw:known:0': 'not-base64!!' });
    await switchDevice();
    expect((await fast().syncNow()).phase).toBe('idle');
  });

  it('降级段（只有单词）合并时保留本机同词释义', () => {
    const meta = { id: 'local:x', name: 'x', format: 'txt' as const, wordCount: 2, createdAt: 0, updatedAt: 9 };
    const data = fromLocalBookSegment({ meta, list: ['Pear', 'fig'] }, { id: 'local:x', words: { pear: { word: 'Pear', trans: 'n. 梨' } } });
    expect(data.words).toEqual({ pear: { word: 'Pear', trans: 'n. 梨' }, fig: { word: 'fig' } });
  });

  it('设备 id 首次读取即持久化', async () => {
    const svc = fast();
    const a = await svc.getStatus();
    const b = await svc.getStatus();
    expect(a.deviceId).toBeTruthy();
    expect(b.deviceId).toBe(a.deviceId);
  });

  it('触发写频率限制：提示并退避，退避期内的同步只拉取不写入', async () => {
    await setKnownWords(['apple'], true);
    const area = fakeBrowser.storage.sync;
    const set = vi.spyOn(area, 'set').mockRejectedValueOnce(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.'));
    const svc = new StorageSyncService({ area, debounceMs: 0, minIntervalMs: 0 });
    const st = await svc.syncNow();
    expect(st.phase).toBe('error');
    expect(st.error).toContain('写入过于频繁');
    const again = await svc.syncNow();
    expect(again.phase).toBe('pending');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('真实规模数据：每项不超过 8KB、总量与项数在配额内，超出部分按优先级取舍', async () => {
    // 8000 个真实单词作熟词（加入时间在一年内随机）+ 6 本各 3000 词带释义的本地词书，远超 100KB
    const rand = () => Math.random().toString(36).slice(2, 10);
    const real = realWords().slice(0, 8000);
    expect(real.length).toBeGreaterThan(5000);
    const t0 = 1_790_000_000_000;
    await fakeBrowser.storage.local.set({
      knownWords: { words: Object.fromEntries(real.map((w) => [w, t0 + Math.floor(Math.random() * 3e10)])), removed: {} },
    });
    for (let b = 0; b < 6; b++) {
      await saveLocalBook({ name: `书${b}`, format: 'csv', words: Array.from({ length: 3000 }, () => ({ word: rand(), trans: `n. ${rand()}${rand()}` })) });
    }
    const st = await fast().syncNow();
    expect(st.phase).toBe('idle');
    const all = await fakeBrowser.storage.sync.get(null);
    let total = 0;
    for (const [k, v] of Object.entries(all)) {
      const bytes = syncItemBytes(k, v);
      expect(bytes).toBeLessThanOrEqual(DEFAULT_SYNC_QUOTA.quotaBytesPerItem);
      total += bytes;
    }
    expect(total).toBeLessThanOrEqual(DEFAULT_SYNC_QUOTA.quotaBytes);
    expect(Object.keys(all).length).toBeLessThanOrEqual(DEFAULT_SYNC_QUOTA.maxItems);
    const states = st.usage!.segments.map((s) => [s.id.split(':')[0], s.state]);
    expect(states[0]).toEqual(['settings', 'synced']);
    expect(states[1]).toEqual(['known', 'synced']);
    expect(states.some(([, s]) => s === 'skipped' || s === 'reduced')).toBe(true);
    // 用量计算与实际写入一致（误差仅来自 manifest 预估）
    expect(Math.abs(st.usage!.bytes - total)).toBeLessThan(600);
  });

  it('本地词书在另一台设备删除后，本机同步时删除（墓碑）', async () => {
    const book = await saveLocalBook({ name: 'A', format: 'txt', words: [{ word: 'pear' }] });
    await fast().syncNow();
    const { deleteLocalBook } = await import('@/core/wordbook/user-store');
    await new Promise((r) => setTimeout(r, 2));
    await deleteLocalBook(book.id);
    await fast().syncNow();
    // 另一台设备：先拿到旧数据，再收到墓碑
    expect(await getLocalBook(book.id)).toBeUndefined();
    await switchDevice();
    await fast().syncNow();
    expect(await getLocalBook(book.id)).toBeUndefined();
  });
});

describe('徽章计数', () => {
  it('文本与 URL 规则', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(12)).toBe('12');
    expect(badgeText(1200)).toBe('999+');
    expect(pageKey('https://a.com/x?q=1#top')).toBe('https://a.com/x?q=1');
    expect(shouldClearOnUrlChange('https://a.com/x#a', 'https://a.com/x#b')).toBe(false);
    expect(shouldClearOnUrlChange('https://a.com/x', 'https://a.com/y')).toBe(true);
  });

  it('多 frame 合并去重；SPA 路由切换清零，锚点跳转不清零', async () => {
    const setBadge = vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue(undefined);
    // fake-browser 未实现以下 API
    vi.spyOn(fakeBrowser.tabs.onReplaced, 'addListener').mockImplementation(() => {});
    vi.spyOn(fakeBrowser.action, 'setBadgeBackgroundColor').mockResolvedValue(undefined);
    setupBadge();
    await reportFrameWords(1, 0, ['run', 'apple'], 'https://spa.com/a');
    await reportFrameWords(1, 3, ['apple', 'pear'], 'https://ads.com/frame');
    expect((await getTabWords(1)).sort()).toEqual(['apple', 'pear', 'run']);
    expect(setBadge).toHaveBeenLastCalledWith({ tabId: 1, text: '3' });

    await fakeBrowser.tabs.onUpdated.trigger(1, { url: 'https://spa.com/a#section' }, {} as never);
    await getTabWords(1);
    expect((await getTabWords(1)).length).toBe(3);

    await fakeBrowser.tabs.onUpdated.trigger(1, { url: 'https://spa.com/b' }, {} as never);
    expect(await getTabWords(1)).toEqual([]);
    expect(setBadge).toHaveBeenLastCalledWith({ tabId: 1, text: '' });

    // 新路由下重新上报
    await reportFrameWords(1, 0, ['zebra'], 'https://spa.com/b');
    expect(await getTabWords(1)).toEqual(['zebra']);
  });

  it('旧页面迟到的上报不会污染新页面', async () => {
    vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue(undefined);
    await reportFrameWords(2, 0, ['a'], 'https://x.com/1');
    await reportFrameWords(2, 5, ['b'], 'https://x.com/sub');
    await reportFrameWords(2, 0, ['c'], 'https://x.com/2');
    expect(await getTabWords(2)).toEqual(['c']);
  });
});

describe('TTS', () => {
  it('自动发音关闭时不朗读；按钮强制朗读；本机不存在的 voiceName 退回按 lang 选择', async () => {
    const spoken = vi.spyOn(fakeBrowser.tts, 'speak').mockResolvedValue(undefined);
    vi.spyOn(fakeBrowser.tts, 'getVoices').mockResolvedValue([{ voiceName: 'Google US English', lang: 'en-US' }] as never);
    await patchSettings({ tts: { enabled: false, voice: { voiceName: 'Microsoft Aria', lang: 'en-US' }, rate: 1.2 } });
    expect(await speak('run')).toEqual({ spoken: false, reason: 'disabled' });
    expect(spoken).not.toHaveBeenCalled();
    expect(await speak('run', true)).toEqual({ spoken: true });
    expect(spoken).toHaveBeenCalledWith('run', { lang: 'en-US', rate: 1.2 });
  });

  it('chrome.tts 抛错时返回 error 而不是让消息失败', async () => {
    vi.spyOn(fakeBrowser.tts, 'speak').mockRejectedValue(new Error('boom'));
    expect(await speak('run', true)).toEqual({ spoken: false, reason: 'error' });
  });
});

describe('熟词本紧凑编码', () => {
  it('full 秒精度往返；reduced 天精度；兼容旧结构', async () => {
    const { encodeKnownSegment, decodeKnownSegment } = await import('@/core/sync/known-codec');
    const data = { words: { run: 1_790_000_001_234, apple: 1_790_100_000_999 }, removed: { pear: 1_790_000_000_005 } };
    const full = decodeKnownSegment(encodeKnownSegment(data, 'full'));
    expect(full).toEqual({ words: { apple: 1_790_100_000_000, run: 1_790_000_001_000 }, removed: data.removed });
    const reduced = decodeKnownSegment(encodeKnownSegment(data, 'reduced'));
    expect(reduced.words.run! % 86_400_000).toBe(0);
    expect(reduced.words.run!).toBeLessThanOrEqual(data.words.run);
    expect(data.words.run - reduced.words.run!).toBeLessThan(86_400_000);
    expect(decodeKnownSegment(data)).toEqual(data);
    expect(decodeKnownSegment(encodeKnownSegment({ words: {}, removed: {} }, 'full'))).toEqual({ words: {}, removed: {} });
  });
});

describe('storage 读回对象键序变化（Chrome 底层为有序字典）', () => {
  /** 模拟 Chrome：读回的对象键按字母序排列 */
  function sortedArea(area: typeof fakeBrowser.storage.sync) {
    const sortDeep = (v: unknown): unknown =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortDeep(x)]))
        : v;
    return new Proxy(area, {
      get(target, prop, recv) {
        if (prop === 'get') return async (keys: never) => sortDeep(await target.get(keys));
        return Reflect.get(target, prop, recv);
      },
    });
  }

  it('第二次同步无变化时不写 storage.sync，也不重写本机熟词本', async () => {
    await setKnownWords(['zebra', 'apple', 'mango'], true);
    await saveLocalBook({ name: 'B', format: 'txt', words: [{ word: 'pear' }] });
    const area = sortedArea(fakeBrowser.storage.sync);
    const set = vi.spyOn(fakeBrowser.storage.sync, 'set');
    const svc = new StorageSyncService({ area, debounceMs: 0, minIntervalMs: 0 });
    await svc.syncNow();
    expect(set).toHaveBeenCalledTimes(1);
    const localSet = vi.spyOn(fakeBrowser.storage.local, 'set');
    await svc.syncNow();
    expect(set).toHaveBeenCalledTimes(1);
    // 只允许写 syncState（状态），不允许写熟词本/词书
    const keys = localSet.mock.calls.flatMap((c) => Object.keys(c[0] as object));
    expect(keys.filter((k) => k !== 'syncState')).toEqual([]);
  });
});
