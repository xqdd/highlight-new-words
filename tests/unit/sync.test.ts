import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mergeKnownWords } from '@/core/known/merge';
import { getKnownWords, setKnownWords } from '@/core/known/store';
import { findWordFormsOfLemma } from '@/core/match/forms';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { createDefaultSettings } from '@/core/settings/defaults';
import { getSettings, patchSettings } from '@/core/settings/store';
import { chunkString, decodeSyncValue, encodeSyncValue, syncItemBytes } from '@/core/sync/codec';
import { mergeSyncedSettings, pickSyncedSettings, planLocalBooksMerge } from '@/core/sync/merge';
import { planSyncLayout } from '@/core/sync/plan';
import { StorageSyncService } from '@/core/sync/service';
import { DEFAULT_SYNC_QUOTA, SYNC_MANIFEST_KEY, type SegmentCandidate, type SyncManifest } from '@/core/sync/types';
import { getLocalBook, getLocalIndex, saveLocalBook } from '@/core/wordbook/user-store';

/** 生成不可压缩的随机 base64 文本，用于测试配额 */
function randomText(bytes: number): string {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
  return Buffer.from(buf).toString('base64');
}

describe('sync 编码', () => {
  it('压缩往返，重复数据显著变小', async () => {
    const value = { words: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`word${i}`, 1727000000000 + i])) };
    const enc = await encodeSyncValue(value);
    expect(/^[A-Za-z0-9+/=]+$/.test(enc)).toBe(true);
    expect(enc.length).toBeLessThan(JSON.stringify(value).length / 2);
    expect(await decodeSyncValue(enc)).toEqual(value);
  });

  it('切片往返且每项不超过单项配额', async () => {
    const enc = await encodeSyncValue({ t: randomText(30000) });
    const plan = planSyncLayout([{ id: 'known', kind: 'knownWords', priority: 1, at: 0, label: '', variants: [{ level: 'full', encoded: enc }] }], DEFAULT_SYNC_QUOTA);
    const seg = plan.segments[0]!;
    expect(seg.chunks.length).toBeGreaterThan(3);
    seg.chunks.forEach((c, i) => expect(syncItemBytes(`hnw:known:${i}`, c)).toBeLessThanOrEqual(DEFAULT_SYNC_QUOTA.quotaBytesPerItem));
    expect(seg.chunks.join('')).toBe(enc);
    expect(chunkString('abcde', 2)).toEqual(['ab', 'cd', 'e']);
  });

  it('超配额：按优先级保留，本地词书先降级再跳过', () => {
    const big = (n: number) => randomText(n);
    const cands: SegmentCandidate[] = [
      { id: 'settings', kind: 'settings', priority: 0, at: 0, label: '设置', variants: [{ level: 'full', encoded: big(2000) }] },
      { id: 'known', kind: 'knownWords', priority: 1, at: 0, label: '熟词', variants: [{ level: 'full', encoded: big(40000) }] },
      { id: 'lb:a', kind: 'localBooks', priority: 10, at: 0, label: 'A', variants: [{ level: 'full', encoded: big(50000) }, { level: 'reduced', encoded: big(20000) }] },
      { id: 'lb:b', kind: 'localBooks', priority: 11, at: 0, label: 'B', variants: [{ level: 'full', encoded: big(60000) }, { level: 'reduced', encoded: big(30000) }] },
    ];
    const plan = planSyncLayout(cands, DEFAULT_SYNC_QUOTA);
    expect(plan.usage.segments.map((s) => [s.id, s.state])).toEqual([
      ['settings', 'synced'],
      ['known', 'synced'],
      ['lb:a', 'reduced'],
      ['lb:b', 'skipped'],
    ]);
    expect(plan.usage.bytes).toBeLessThanOrEqual(DEFAULT_SYNC_QUOTA.quotaBytes);
  });
});

describe('sync 合并', () => {
  it('熟词：并集 + 墓碑，交换律与幂等', () => {
    const a = { words: { apple: 10, run: 5 }, removed: { pear: 8 } };
    const b = { words: { pear: 7, zebra: 3 }, removed: { run: 6 } };
    const now = 100;
    const m = mergeKnownWords(a, b, now);
    expect(m).toEqual({ words: { apple: 10, zebra: 3 }, removed: { pear: 8, run: 6 } });
    expect(mergeKnownWords(b, a, now)).toEqual(m);
    expect(mergeKnownWords(m, m, now)).toEqual(m);
    // 重新加入（时间更新）胜过旧墓碑
    expect(mergeKnownWords(m, { words: { run: 9 }, removed: {} }, now).words.run).toBe(9);
  });

  it('设置：按 updatedAt，保留本机 sync 开关与 apiToken', () => {
    const local = createDefaultSettings();
    local.updatedAt = 10;
    local.sync.enabled = true;
    local.sources.eudic!.apiToken = 'secret';
    const remoteFull = createDefaultSettings();
    remoteFull.updatedAt = 20;
    remoteFull.enabled = false;
    remoteFull.sources.eudic!.apiToken = 'other';
    const remote = pickSyncedSettings(remoteFull);
    expect('sync' in remote).toBe(false);
    expect(remote.sources.eudic?.apiToken).toBeUndefined();
    const merged = mergeSyncedSettings(local, remote)!;
    expect(merged.enabled).toBe(false);
    expect(merged.updatedAt).toBe(20);
    expect(merged.sources.eudic?.apiToken).toBe('secret');
    expect(mergeSyncedSettings({ ...local, updatedAt: 30 }, remote)).toBeUndefined();
  });

  it('本地词书：LWW 与删除墓碑', () => {
    const meta = (id: string, updatedAt: number) => ({ id, name: id, format: 'txt' as const, wordCount: 0, createdAt: 0, updatedAt });
    const plan = planLocalBooksMerge(
      { books: { 'local:a': meta('local:a', 5), 'local:b': meta('local:b', 5) }, removed: {} },
      [{ meta: meta('local:a', 9), list: ['x'] }, { meta: meta('local:c', 3), words: {} }, { meta: meta('local:d', 1), words: {} }],
      { 'local:b': 6, 'local:d': 2 },
    );
    expect(plan.upsert.map((s) => s.meta.id)).toEqual(['local:a', 'local:c']);
    expect(plan.remove).toEqual(['local:b']);
  });
});

describe('StorageSyncService（fake-browser）', () => {
  beforeEach(() => fakeBrowser.reset());

  it('推送后在“另一台设备”（清空本机）拉取还原，且无变化时不重复写入', async () => {
    await patchSettings({ inlineTranslation: { mode: 'ruby' } });
    await setKnownWords(['apple', 'run'], true);
    const book = await saveLocalBook({ name: '水果', format: 'txt', words: [{ word: 'pear', trans: 'n. 梨' }] });
    const svc = new StorageSyncService({ debounceMs: 0, minIntervalMs: 0 });
    expect((await svc.syncNow()).phase).toBe('idle');
    const remote = await fakeBrowser.storage.sync.get(null);
    const manifest = remote[SYNC_MANIFEST_KEY] as SyncManifest;
    expect(Object.keys(manifest.segs).sort()).toEqual(['known', 'lb:' + book.id.slice(6), 'lbr', 'settings']);

    // 第二次同步：远端不变
    await svc.syncNow();
    expect(await fakeBrowser.storage.sync.get(null)).toEqual(remote);

    // 模拟新设备：清空本机，保留 sync 区
    await fakeBrowser.storage.local.clear();
    await svc.syncNow();
    expect((await getSettings()).inlineTranslation.mode).toBe('ruby');
    expect([...(await getKnownWords())].sort()).toEqual(['apple', 'run']);
    expect((await getLocalIndex()).books[book.id]?.name).toBe('水果');
    expect((await getLocalBook(book.id))?.words.pear?.trans).toBe('n. 梨');
  });

  it('关闭同步时不读写 storage.sync', async () => {
    await patchSettings({ sync: { enabled: false } });
    const svc = new StorageSyncService();
    expect((await svc.syncNow()).phase).toBe('disabled');
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });
});

describe('同原形词形查找（deleteOnKnown）', () => {
  it('study -> studies/studied/studying，不误伤 student', () => {
    const words = ['study', 'studies', 'studied', 'studying', 'student', 'apple'];
    expect(findWordFormsOfLemma('study', words, new SimpleLemmatizer()).sort()).toEqual(['studied', 'studies', 'study', 'studying']);
  });
});
