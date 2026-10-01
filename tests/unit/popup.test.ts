import { describe, expect, it } from 'vitest';
import {
  filterWords,
  formatAgo,
  formatCount,
  groupBooks,
  oneLineMeaning,
  recentKnownWords,
  resolvePageStatus,
  solidSwatch,
  summarizeCloudSync,
  summarizeSourceSync,
  toggleEnabledBook,
  toggleSiteRule,
} from '@/entrypoints/popup/model';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';
import type { SyncStatus } from '@/core/sync/types';

const NOW = new Date('2026-10-01T12:00:00Z').getTime();

function book(id: string, extra: Partial<BookMeta> = {}): BookMeta {
  return { id, kind: 'builtin', name: id, nameEn: id, short: id, category: 'exam', level: 1, size: 10, ...extra };
}

function sourceBook(id: string, sync: Partial<SourceBookState>): BookMeta {
  return book(id, {
    kind: 'source',
    category: 'user',
    sync: { id, providerId: 'youdao', remoteId: 'default', name: '默认', status: 'ok', lastSyncAt: 0, lastAttemptAt: 0, wordCount: 3, ...sync },
  });
}

describe('popup model', () => {
  it('formatAgo 输出相对时间', () => {
    expect(formatAgo(0, NOW)).toBe('从未');
    expect(formatAgo(NOW - 20_000, NOW)).toBe('刚刚');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatAgo(NOW - 3 * 3600_000, NOW)).toBe('3 小时前');
    expect(formatAgo(NOW - 2 * 86400_000, NOW)).toBe('2 天前');
  });

  it('resolvePageStatus 按优先级判定', () => {
    const base = { loaded: true, url: 'https://a.com/x', contentReady: true, enabled: true, siteDisabled: false };
    expect(resolvePageStatus({ ...base, loaded: false })).toBe('loading');
    expect(resolvePageStatus({ ...base, url: 'chrome://newtab/' })).toBe('unsupported');
    expect(resolvePageStatus({ ...base, url: undefined })).toBe('unsupported');
    expect(resolvePageStatus({ ...base, enabled: false })).toBe('paused');
    expect(resolvePageStatus({ ...base, siteDisabled: true })).toBe('site-off');
    expect(resolvePageStatus({ ...base, contentReady: false })).toBe('not-injected');
    expect(resolvePageStatus(base)).toBe('active');
  });

  it('toggleSiteRule 打开时移除父域规则，关闭时追加精确域名', () => {
    expect(toggleSiteRule(['example.com', 'b.com'], 'www.example.com', true)).toEqual(['b.com']);
    expect(toggleSiteRule(['b.com'], 'WWW.Example.com', false)).toEqual(['b.com', 'www.example.com']);
    // 不误删相似后缀
    expect(toggleSiteRule(['ample.com'], 'example.com', true)).toEqual(['ample.com']);
  });

  it('toggleEnabledBook 启用追加到末尾、停用移除且不重复', () => {
    expect(toggleEnabledBook(['cet6', 'gre'], 'cet4', true)).toEqual(['cet6', 'gre', 'cet4']);
    expect(toggleEnabledBook(['cet6', 'gre'], 'cet6', false)).toEqual(['gre']);
    expect(toggleEnabledBook(['cet6'], 'cet6', true)).toEqual(['cet6']);
  });

  it('groupBooks 按 用户/考试/词频 分组并丢弃空组', () => {
    const groups = groupBooks([book('cet6'), book('local:1', { kind: 'local', category: 'user' }), book('coca', { category: 'frequency' })]);
    expect(groups.map((g) => g.category)).toEqual(['user', 'exam', 'frequency']);
    expect(groups[0]!.books.map((b) => b.id)).toEqual(['local:1']);
  });

  it('summarizeSourceSync 汇总来源词书状态', () => {
    expect(summarizeSourceSync([book('cet6')], NOW).tone).toBe('muted');
    expect(summarizeSourceSync([sourceBook('a', { status: 'syncing' })], NOW).tone).toBe('busy');
    const err = summarizeSourceSync([sourceBook('a', { status: 'error', error: '未登录' }), sourceBook('b', { lastSyncAt: NOW })], NOW);
    expect(err).toEqual({ text: '1 本同步失败：未登录', tone: 'error' });
    expect(summarizeSourceSync([sourceBook('a', { lastSyncAt: NOW - 120_000 })], NOW)).toEqual({ text: '1 本生词本 · 2 分钟前同步', tone: 'ok' });
    expect(summarizeSourceSync([sourceBook('a', { status: 'never' })], NOW).tone).toBe('warn');
  });

  it('summarizeCloudSync 显示阶段与超配额', () => {
    expect(summarizeCloudSync(false, undefined, NOW).text).toBe('跨设备同步未开启');
    const status: SyncStatus = { enabled: true, phase: 'idle', deviceId: 'd', lastPushAt: NOW - 60_000, lastPullAt: 0 };
    expect(summarizeCloudSync(true, status, NOW)).toEqual({ text: '跨设备已同步 · 1 分钟前', tone: 'ok' });
    const over: SyncStatus = {
      ...status,
      usage: { bytes: 1, quotaBytes: 2, items: 1, maxItems: 512, segments: [{ id: 'lb:1', kind: 'localBooks', label: 'x', bytes: 1, items: 1, state: 'skipped' }] },
    };
    expect(summarizeCloudSync(true, over, NOW).tone).toBe('warn');
    expect(summarizeCloudSync(true, { ...status, phase: 'error', error: 'QUOTA' }, NOW)).toEqual({ text: '跨设备同步出错：QUOTA', tone: 'error' });
  });

  it('recentKnownWords 按加入时间倒序', () => {
    const list = recentKnownWords({ words: { a: 1, b: 3, c: 2 }, removed: {} }, 2);
    expect(list.map((k) => k.word)).toEqual(['b', 'c']);
  });

  it('文本工具', () => {
    expect(oneLineMeaning('n. 苹果\nv. 吃', 40)).toBe('n. 苹果；v. 吃');
    expect(oneLineMeaning('a'.repeat(50), 10)).toBe('aaaaaaaaa…');
    expect(filterWords(['abandon', 'ban', 'urban'], 'ban')).toEqual(['ban', 'abandon', 'urban']);
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(15360)).toBe('1.5万');
    expect(solidSwatch({ background: 'rgba(255, 196, 0, 0.30)', color: '', underlineColor: '' })).toBe('rgb(255, 196, 0)');
    expect(solidSwatch({ background: '', color: '', underlineColor: '#f00' })).toBe('#f00');
  });
});
