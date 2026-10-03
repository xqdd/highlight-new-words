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
  friendlySyncError,
  friendlyChannels,
  primaryFixChannel,
  isAlertSnoozed,
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
    // 难度分级、词频分级组内单选：启用一档时停用同组其他档，其他分类不受影响
    const metas = [
      { id: 'cefr-b1', category: 'level' },
      { id: 'cefr-b2', category: 'level' },
      { id: 'coca-3k', category: 'frequency' },
      { id: 'coca-5k', category: 'frequency' },
      { id: 'cet4', category: 'exam' },
      { id: 'cet6', category: 'exam' },
    ] as BookMeta[];
    expect(toggleEnabledBook(['cet4', 'cefr-b1', 'coca-3k'], 'cefr-b2', true, metas)).toEqual(['cet4', 'coca-3k', 'cefr-b2']);
    expect(toggleEnabledBook(['cet4', 'cefr-b2', 'coca-3k'], 'coca-5k', true, metas)).toEqual(['cet4', 'cefr-b2', 'coca-5k']);
    expect(toggleEnabledBook(['cet4'], 'cet6', true, metas)).toEqual(['cet4', 'cet6']);
    expect(toggleEnabledBook(['cefr-b2', 'coca-5k'], 'coca-5k', false, metas)).toEqual(['cefr-b2']);
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
      { ...sourceBook('src:eudic:1', { providerId: 'eudic', status: 'error', error: '授权失效', lastSyncAt: NOW - 3600e3 }), providerId: 'eudic' },
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
    // 来源启用但还没有任何生词本：中性“未连接”，给去连接入口（与后台 sourceItem 同口径）
    const none = buildSyncChannels({ books: [], sources: { youdao: { enabled: true } }, providers, now: NOW });
    expect(none[0]).toMatchObject({ action: 'fix', status: { text: '未连接', tone: 'muted' } });
    // 从没成功过的书同步失败：同样是未连接，不是红色错误
    const fresh = buildSyncChannels({ books: [{ ...sourceBook('src:youdao:0', { status: 'error', error: '未登录有道' }), providerId: 'youdao' }], sources: { youdao: { enabled: true } }, providers, now: NOW });
    expect(fresh[0]).toMatchObject({ action: 'fix', status: { text: '未连接', tone: 'muted' }, detail: '未登录有道' });
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
    // “仅悬停”同样能被记住并恢复（之前分段选项缺 hover，关再开会丢失用户选择）
    const all = ['after', 'ruby', 'hover'] as const;
    expect(nextInlineMode('hover', null, all)).toBe('off');
    expect(nextInlineMode('off', 'hover', all)).toBe('hover');
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
      dismissible: true,
    });
    expect(resolveStatusAlert({ online: true, channels: [youdao, dav] })?.action).toEqual({ label: '2 项需处理', sheet: true });
    expect(resolveStatusAlert({ online: true, channels: [ch('ok', 'webdav', '3 小时前', 'ok')] })).toBeUndefined();
  });

  it('friendlySyncError：技术文案改短句，原文保留到 detail，识别不出原样返回', () => {
    expect(friendlySyncError('无法连接 WebDAV 服务器（127.0.0.1:9）：Failed to fetch')).toEqual({
      short: '连不上服务器 127.0.0.1:9',
      detail: '无法连接 WebDAV 服务器（127.0.0.1:9）：Failed to fetch',
    });
    expect(friendlySyncError('未登录有道或登录已失效，请先登录有道单词本网页版').short).toBe('登录已过期');
    // 从没同步成功过（新装默认启用有道）是“未登录”，不是“登录已过期”
    expect(friendlySyncError('未登录有道或登录已失效，请先登录有道单词本网页版', { neverSynced: true }).short).toBe('未登录');
    expect(friendlySyncError('1/2 本失败：授权失效，请重新填写 API token').short).toBe('1/2 本失败：授权已失效');
    expect(friendlySyncError('同步失败：欧路 API 授权无效或已过期，请重新获取授权信息').short).toBe('授权已失效');
    expect(friendlySyncError('奇怪的错误')).toEqual({ short: '奇怪的错误' });
    // 改写后修复动作仍按原文判断
    const [c] = friendlyChannels([{ ...ch('WebDAV', 'webdav', '无法连接 WebDAV 服务器（127.0.0.1:9）：Failed to fetch') }]);
    expect(c!.status.text).toBe('连不上服务器 127.0.0.1:9');
    expect(syncFixVerb(c!)).toBe('检查服务器');
  });

  it('新装未登录有道：中性“未连接 / 去连接”，不计入告警；成功过再失败才是“登录已过期 / 重新登录”', () => {
    const NOW = 1_800_000_000_000;
    const item = (level: StatusItem['level'], lastSyncAt: number): StatusItem => ({
      id: 'source:youdao',
      kind: 'source',
      name: '有道词典',
      level,
      text: '未登录有道或登录已失效，请先登录有道单词本网页版',
      lastSyncAt,
      href: '#sources',
    });
    // 后台口径（core/source/connect-status）：从没成功过 → level=never、text=未连接、原因在 detail
    const neverItem: StatusItem = { ...item('never', 0), text: '未连接', detail: '未登录有道或登录已失效，请先登录有道单词本网页版' };
    const [fresh] = friendlyChannels(channelsFromStatusItems([neverItem], NOW));
    expect(fresh).toMatchObject({ action: 'fix', status: { text: '未连接', tone: 'muted' }, detail: neverItem.detail });
    expect(fresh!.since).toBeUndefined();
    expect(syncFixVerb(fresh!)).toBe('去连接');
    expect(overallSyncStatus([fresh!])).toEqual({ text: '有道词典：未连接', tone: 'muted' });
    expect(resolveStatusAlert({ online: true, channels: [fresh!] })).toBeUndefined();
    expect(primaryFixChannel([fresh!])?.id).toBe('source:youdao');
    // 只是没试过同步：先试一次，不给修复入口
    const untried = channelsFromStatusItems([{ ...item('never', 0), text: '尚未同步，点“立即同步”拉取生词本' }], NOW)[0]!;
    expect(untried.action).toBe('sync');
    expect(primaryFixChannel([untried])).toBeUndefined();
    const [expired] = friendlyChannels(channelsFromStatusItems([item('error', NOW - 3 * 3600e3)], NOW));
    expect(expired).toMatchObject({ action: 'fix', since: '上次成功 3 小时前', status: { text: '登录已过期', tone: 'error' } });
    expect(syncFixVerb(expired!)).toBe('重新登录');
    // 出错优先作为主修复动作
    expect(primaryFixChannel([fresh!, expired!])?.status.text).toBe('登录已过期');
    expect(overallSyncStatus([fresh!, expired!]).tone).toBe('error');
    // 正常行带上次同步时间
    const ok = channelsFromStatusItems([{ ...item('ok', NOW - 120_000), id: 'storage-sync', kind: 'backend', text: '已同步 · 已用 1.0 KB / 100 KB' }], NOW)[0]!;
    expect(ok.status.text).toBe('已同步 · 已用 1.0 KB / 100 KB · 2 分钟前');
  });

  it('isAlertSnoozed：同一条告警收起 24 小时，文案变化立即重新显示', () => {
    const a = { tone: 'error' as const, text: '有道：登录已过期', dismissible: true };
    expect(isAlertSnoozed(a, { text: a.text, at: 1000 }, 1000 + 3600e3)).toBe(true);
    expect(isAlertSnoozed(a, { text: a.text, at: 1000 }, 1000 + 25 * 3600e3)).toBe(false);
    expect(isAlertSnoozed(a, { text: '别的', at: 1000 }, 2000)).toBe(false);
    expect(isAlertSnoozed({ ...a, dismissible: undefined }, { text: a.text, at: 1000 }, 2000)).toBe(false);
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

describe('buildPresetSections', () => {
  it('组合预设与单色分组，顺序与 presetGroups 一致（选项页/悬浮球同源）', async () => {
    const { presetGroups } = await import('@/entrypoints/options/lib/appearance');
    const { buildPresetSections } = await import('@/entrypoints/popup/model');
    const { combos, singles, main } = presetGroups();
    const chip = (t: (typeof combos)[number]) => ({ id: t.id, name: t.name, mark: t.mark });
    const sections = buildPresetSections(combos.map(chip), singles.map(chip));
    expect(sections.map((s) => s.key)).toEqual(['combo', 'single']);
    expect(sections[0]!.title).toBe('组合预设');
    expect(sections[1]!.title).toBe(`单色（${singles.length}）`);
    // 拼接后的顺序和悬浮球使用的 main 完全一致
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toEqual(main.map((t) => t.id));
    expect(sections[0]!.items.some((i) => i.name === '下划线 + 括号译文')).toBe(combos.some((t) => t.name === '下划线 + 括号译文'));
  });

  it('自定义/旧版等列表外的当前样式放在组合预设最前', async () => {
    const { buildPresetSections } = await import('@/entrypoints/popup/model');
    const sections = buildPresetSections([{ id: 'a', name: 'A', mark: 1 }], [{ id: 'b', name: 'B', mark: 2 }], { id: 'custom', name: '自定义', mark: 0 });
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['custom', 'a']);
    expect(sections[1]!.items.map((i) => i.id)).toEqual(['b']);
  });
});
