import { describe, expect, it } from 'vitest';
import {
  buildSyncChannels,
  channelsFromStatusItems,
  nextInlineMode,
  overallSyncStatus,
  summarizeStorageSync,
  summarizeWebdav,
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
  syncFixVerb,
  resolveStatusAlert,
  markKnownToast,
  presetScrollLeft,
} from '@/entrypoints/popup/model';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';
import type { BackendSyncStatus, SyncStatus } from '@/core/sync/types';
import type { StatusItem } from '@/core/messaging/protocol';

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

  it('resolvePageStatus：未授权且内容脚本未应答为 no-access；单独授权了本站（已应答）仍为 active', () => {
    const base = { loaded: true, url: 'https://a.com/', enabled: true, siteDisabled: false };
    expect(resolvePageStatus({ ...base, contentReady: false, hostAccess: false })).toBe('no-access');
    expect(resolvePageStatus({ ...base, contentReady: true, hostAccess: false })).toBe('active');
    expect(resolvePageStatus({ ...base, contentReady: false })).toBe('not-injected');
    expect(resolvePageStatus({ ...base, url: 'chrome://newtab', contentReady: false, hostAccess: false })).toBe('unsupported');
    expect(resolvePageStatus({ ...base, enabled: false, contentReady: false, hostAccess: false })).toBe('paused');
  });

  it('buildSyncChannels：按来源汇总，未启用来源与未开启后端不占行，出错给处理入口', () => {
    const providers = [
      { id: 'youdao', name: '有道' },
      { id: 'eudic', name: '欧路' },
      { id: 'other', name: '其他' },
    ];
    const books = [
      sourceBook('src:youdao:0', { lastSyncAt: NOW - 60_000, wordCount: 1200 }),
      sourceBook('src:youdao:5', { lastSyncAt: NOW - 3_600_000, wordCount: 30 }),
      { ...sourceBook('src:eudic:1', { providerId: 'eudic', status: 'error', error: '授权失效' }), providerId: 'eudic' },
    ].map((b) => ({ ...b, providerId: b.providerId ?? b.sync!.providerId }));
    const storageSync: SyncStatus = { enabled: true, phase: 'idle', deviceId: 'd', lastPushAt: NOW - 120_000, lastPullAt: 0 };
    const webdav: BackendSyncStatus = { backend: 'webdav', enabled: true, phase: 'syncing', lastSyncAt: 0, lastPullAt: 0, lastPushAt: 0 };
    const rows = buildSyncChannels({
      books,
      sources: { youdao: { enabled: true }, eudic: { enabled: true }, other: { enabled: false } },
      providers,
      storageSync,
      webdav,
      now: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(['source:youdao', 'source:eudic', 'storage-sync', 'webdav']);
    expect(rows[0]).toMatchObject({ action: 'sync', status: { text: '2 本 · 1,230 词 · 1 分钟前', tone: 'ok' } });
    expect(rows[1]).toMatchObject({ action: 'fix', route: '#sources/provider-eudic', status: { text: '同步失败：授权失效', tone: 'error' } });
    expect(rows[2]).toMatchObject({ action: 'sync', status: { text: '2 分钟前同步', tone: 'ok' } });
    expect(rows[3]).toMatchObject({ running: true, status: { tone: 'busy' } });
    expect(overallSyncStatus(rows)).toEqual({ text: '欧路同步出错', tone: 'error' });
    // 来源启用但还没有任何生词本：提示去连接
    const none = buildSyncChannels({ books: [], sources: { youdao: { enabled: true } }, providers, now: NOW });
    expect(none[0]).toMatchObject({ action: 'fix', status: { tone: 'warn' } });
    expect(overallSyncStatus([])).toEqual({ text: '未开启任何同步', tone: 'muted' });
  });

  it('summarizeStorageSync / summarizeWebdav：未开启返回 undefined，超配额与退避文案', () => {
    expect(summarizeStorageSync(undefined)).toBeUndefined();
    const st: SyncStatus = { enabled: true, phase: 'pending', deviceId: 'd', lastPushAt: 0, lastPullAt: 0, notice: '写入过于频繁，10:32 自动重试' };
    expect(summarizeStorageSync(st, NOW)).toEqual({ text: '写入过于频繁，10:32 自动重试', tone: 'busy' });
    const over: SyncStatus = {
      ...st,
      phase: 'idle',
      lastPushAt: NOW,
      usage: { bytes: 1, quotaBytes: 2, items: 1, maxItems: 512, segments: [{ id: 'lb:1', kind: 'localBooks', label: 'x', bytes: 1, items: 1, state: 'skipped' }] },
    };
    expect(summarizeStorageSync(over, NOW)).toEqual({ text: '刚刚同步 · 1 项超出配额', tone: 'warn' });
    const dav: BackendSyncStatus = { backend: 'webdav', enabled: false, phase: 'disabled', lastSyncAt: 0, lastPullAt: 0, lastPushAt: 0 };
    expect(summarizeWebdav(dav)).toBeUndefined();
    expect(summarizeWebdav({ ...dav, enabled: true, phase: 'error', error: '401 用户名或密码错误' })).toEqual({ text: '401 用户名或密码错误', tone: 'error' });
  });

  it('channelsFromStatusItems：background 总状态映射，off 不占行，只有 error 给处理入口，pending 可手动同步', () => {
    const item = (id: string, level: StatusItem['level'], extra: Partial<StatusItem> = {}): StatusItem => ({
      id,
      kind: id.startsWith('source:') ? 'source' : 'backend',
      name: id,
      level,
      text: level,
      lastSyncAt: 0,
      href: '',
      ...extra,
    });
    const rows = channelsFromStatusItems([
      item('storage-sync', 'pending'),
      item('webdav', 'off'),
      item('source:eudic', 'error', { href: '#sources/provider-eudic' }),
      item('source:youdao', 'busy'),
    ]);
    expect(rows.map((r) => [r.id, r.kind, r.action, !!r.running])).toEqual([
      ['storage-sync', 'storage-sync', 'sync', false],
      ['source:eudic', 'source', 'fix', false],
      ['source:youdao', 'source', 'sync', true],
    ]);
    expect(rows[1]).toMatchObject({ providerId: 'eudic', route: '#sources/provider-eudic' });
    expect(rows[0]!.route).toBe('#sync/sync');
  });

  it('nextInlineMode：开启时恢复上次方式，无效记录用第一个', () => {
    const modes = ['after', 'ruby'] as const;
    expect(nextInlineMode('after', 'ruby', modes)).toBe('off');
    expect(nextInlineMode('off', 'ruby', modes)).toBe('ruby');
    expect(nextInlineMode('off', null, modes)).toBe('after');
    expect(nextInlineMode('off', 'bogus', modes)).toBe('after');
  });
});

describe('popup 顶部状态位与提示', () => {
  const ch = (id: string, kind: 'source' | 'storage-sync' | 'webdav', text: string, tone: 'ok' | 'error' = 'error') => ({
    id,
    kind,
    label: id,
    status: { text, tone },
    action: tone === 'error' ? ('fix' as const) : ('sync' as const),
    route: `#r-${id}`,
  });

  it('syncFixVerb 按错误原因给出具体动作', () => {
    expect(syncFixVerb(ch('有道', 'source', '请重新登录有道词典网页版'))).toBe('重新登录');
    expect(syncFixVerb(ch('欧路', 'source', '授权失效，请重新填写 token'))).toBe('更新授权');
    expect(syncFixVerb(ch('WebDAV', 'webdav', '无法连接 WebDAV 服务器（127.0.0.1:9）'))).toBe('检查服务器');
    expect(syncFixVerb(ch('WebDAV', 'webdav', '认证失败（401）'))).toBe('检查账号');
    expect(syncFixVerb(ch('x', 'storage-sync', '奇怪的错误'))).toBe('去处理');
  });

  it('resolveStatusAlert：离线优先，单项出错给具体动作，多项出错滚到同步卡片，正常不显示', () => {
    const youdao = ch('有道', 'source', '登录已过期');
    const dav = ch('WebDAV', 'webdav', '无法连接服务器');
    expect(resolveStatusAlert({ online: false, channels: [youdao] })?.tone).toBe('warn');
    expect(resolveStatusAlert({ online: true, channels: [youdao] })).toEqual({
      tone: 'error',
      text: '有道：登录已过期',
      action: { label: '重新登录', route: '#r-有道' },
    });
    expect(resolveStatusAlert({ online: true, channels: [youdao, dav] })?.action).toEqual({ label: '查看', scroll: true });
    expect(resolveStatusAlert({ online: true, channels: [ch('ok', 'webdav', '3 小时前', 'ok')] })).toBeUndefined();
  });

  it('markKnownToast：远端删除失败（含离线）时不显示成全部完成', () => {
    const ok = markKnownToast('apple', { deleted: [{ deleted: ['apple', 'apples'], failed: [] }] }, true);
    expect(ok).toEqual({ text: '已将 apple 标为熟词，并从生词本删除 2 个词形', failed: false });
    const off = markKnownToast('apple', { deleted: [{ deleted: [], failed: [{ word: 'apple', error: 'Failed to fetch' }] }] }, false);
    expect(off.failed).toBe(true);
    expect(off.text).toContain('当前离线');
    const err = markKnownToast('apple', { deleted: [{ deleted: [], failed: [{ word: 'apple', error: '登录已过期' }] }] }, true);
    expect(err.text).toContain('登录已过期');
  });

  it('presetScrollLeft：选中项在首屏内从最左开始，靠后时完整可见并露出半张下一项', () => {
    expect(presetScrollLeft({ itemLeft: 94, itemWidth: 74, viewport: 366, peek: 37, max: 900 })).toBe(0);
    expect(presetScrollLeft({ itemLeft: 494, itemWidth: 74, viewport: 366, peek: 37, max: 900 })).toBe(494 + 74 + 37 - 366);
    expect(presetScrollLeft({ itemLeft: 994, itemWidth: 74, viewport: 366, peek: 37, max: 700 })).toBe(700);
    // 对齐到某一项的左缘：最左边那张完整显示
    const snaps = Array.from({ length: 12 }, (_, i) => i * 80);
    expect(presetScrollLeft({ itemLeft: 494, itemWidth: 74, viewport: 366, peek: 37, max: 900, snaps })).toBe(240);
  });
});
