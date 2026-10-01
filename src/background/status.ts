import { browser } from 'wxt/browser';
import type { PermissionStatus, SourceSyncResult, StatusItem, StatusLevel, StatusSummary, SyncAllProgress, SyncAllResult, UpdateNotice } from '@/core/messaging/protocol';
import { hasAllSitesAccess, hasOriginAccess } from '@/core/platform';
import type { Settings } from '@/core/settings/schema';
import { getSettings } from '@/core/settings/store';
import { SOURCE_PROVIDER_INFOS } from '@/core/source/providers';
import { STORAGE_KEYS } from '@/core/storage/keys';
import type { BackendSyncStatus, SyncStatus } from '@/core/sync/types';
import type { SourceBookIndex } from '@/core/wordbook/types';
import { getSourceIndex } from '@/core/wordbook/user-store';

/**
 * 总状态（popup 顶部状态条、options 概览）：把各同步后端、各启用来源、权限、升级提示汇成“一句话 + 明细”。
 *
 * 只读本地持久化状态（syncState / webdavSyncState / sourceBooks）与权限，不发网络请求，popup 每次打开都可调用。
 * 文案原则：给用户看得懂、能行动的中文；level 供 UI 选颜色，href 指向选项页对应位置。
 */

/** 严重程度排序（越前越严重），总 level 取最严重者 */
const LEVEL_ORDER: StatusLevel[] = ['error', 'busy', 'pending', 'never', 'ok', 'off'];

export function worstLevel(levels: StatusLevel[]): StatusLevel {
  let best = LEVEL_ORDER.length - 1;
  for (const l of levels) best = Math.min(best, LEVEL_ORDER.indexOf(l));
  return LEVEL_ORDER[best]!;
}

const SYNC_HREF = '#sync/sync';
const WEBDAV_HREF = '#sync/webdav';
const SOURCES_HREF = '#sources';

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** storage.sync 后端 → 状态项（纯函数，单测直接调用） */
export function storageSyncItem(st: SyncStatus): StatusItem {
  const base = { id: 'storage-sync', kind: 'backend' as const, name: '浏览器账号同步', href: SYNC_HREF, retryAt: st.retryAt };
  const lastSyncAt = Math.max(st.lastPushAt, st.lastPullAt);
  if (!st.enabled || st.phase === 'disabled') return { ...base, level: 'off', text: '未开启', lastSyncAt };
  if (st.phase === 'error') return { ...base, level: 'error', text: st.error || '同步失败', lastSyncAt };
  if (st.phase === 'syncing') return { ...base, level: 'busy', text: '正在同步…', lastSyncAt };
  if (st.phase === 'pending') return { ...base, level: 'pending', text: st.notice || '有改动等待同步', lastSyncAt };
  if (!lastSyncAt) return { ...base, level: 'never', text: '尚未同步', lastSyncAt };
  const usage = st.usage;
  if (!usage) return { ...base, level: 'ok', text: '已同步', lastSyncAt };
  const skipped = usage.segments.filter((s) => s.state === 'skipped').length;
  const reduced = usage.segments.filter((s) => s.state === 'reduced').length;
  const parts = [`已同步 · 已用 ${kb(usage.bytes)} / ${kb(usage.quotaBytes)}`];
  // 超配额取舍属于“行为和预期不同”，必须说清楚（但不是错误：设置和熟词本照常同步）
  if (skipped) parts.push(`${skipped} 本本地词书超出配额未同步`);
  else if (reduced) parts.push(`${reduced} 本本地词书只同步了单词（不含释义）`);
  return { ...base, level: 'ok', text: parts.join('，'), lastSyncAt };
}

/** WebDAV 后端 → 状态项（纯函数）；originGranted=false 表示服务器地址未授权 */
export function webdavItem(st: BackendSyncStatus, settings: Settings, originGranted?: boolean): StatusItem {
  const base = { id: 'webdav', kind: 'backend' as const, name: 'WebDAV', href: WEBDAV_HREF, retryAt: st.retryAt, lastSyncAt: st.lastSyncAt };
  const w = settings.sync.webdav;
  if (!w.enabled) return { ...base, level: 'off', text: '未开启' };
  if (!w.url.trim() || !w.username.trim() || !w.password) return { ...base, level: 'error', text: '请先填写服务器地址、用户名和密码' };
  if (originGranted === false) return { ...base, level: 'error', text: '未授权访问该服务器，请在选项页点击“测试连接”授权' };
  if (st.phase === 'error') return { ...base, level: 'error', text: st.error || '同步失败' };
  if (st.phase === 'syncing') return { ...base, level: 'busy', text: '正在同步…' };
  if (st.phase === 'pending') return { ...base, level: 'pending', text: st.notice || '等待同步' };
  if (!st.lastSyncAt) return { ...base, level: 'never', text: '尚未同步' };
  return { ...base, level: 'ok', text: st.remoteBytes ? `已同步 · 远端文件 ${kb(st.remoteBytes)}` : '已同步' };
}

/** 一个启用来源 → 状态项（纯函数）：按该来源下各书（不含已孤立的）汇总 */
export function sourceItem(providerId: string, name: string, index: SourceBookIndex): StatusItem {
  const books = Object.values(index.books).filter((b) => b.providerId === providerId && !b.orphaned);
  const lastSyncAt = Math.max(0, ...books.map((b) => b.lastSyncAt));
  const base = { id: `source:${providerId}`, kind: 'source' as const, name, href: SOURCES_HREF, lastSyncAt };
  if (books.some((b) => b.status === 'syncing')) return { ...base, level: 'busy', text: '正在同步…' };
  const listError = index.providers[providerId]?.error;
  const failed = books.filter((b) => b.status === 'error');
  // 从未成功同步过的来源（如默认启用有道但用户从没登录）失败时不算“出错”，显示为“尚未同步”并附原因，避免新用户一打开就看到红色错误；
  // 同步成功过之后再失败（登录过期、token 失效）才是需要处理的错误
  const failLevel: StatusLevel = lastSyncAt > 0 ? 'error' : 'never';
  // 列表刷新失败（未登录、token 失效、限流）时各书也会标 error，优先展示来源级原因
  if (listError && (books.length === 0 || failed.length === books.length)) return { ...base, level: failLevel, text: listError };
  if (failed.length) {
    const reason = failed[0]!.error || '同步失败';
    return { ...base, level: failLevel, text: failed.length === books.length ? reason : `${failed.length} 本同步失败：${reason}` };
  }
  if (!books.length || lastSyncAt === 0) return { ...base, level: 'never', text: '尚未同步，点“立即同步”拉取生词本' };
  const newBooks = books.filter((b) => b.role !== 'known' && b.lastSyncAt > 0);
  const knownBooks = books.filter((b) => b.role === 'known' && b.lastSyncAt > 0);
  const words = newBooks.reduce((n, b) => n + b.wordCount, 0);
  const parts = [`已同步 ${newBooks.length} 本生词本（${words} 词）`];
  if (knownBooks.length) parts.push(`${knownBooks.length} 本熟词本`);
  return { ...base, level: 'ok', text: parts.join('、') };
}

/** 总述文案（纯函数） */
export function summaryText(items: StatusItem[], level: StatusLevel): string {
  const on = items.filter((i) => i.level !== 'off');
  if (!on.length) return '未开启任何同步';
  const worst = on.filter((i) => i.level === level);
  switch (level) {
    case 'error':
      return worst.map((i) => `${i.name}：${i.text}`).join('；');
    case 'busy':
      return `正在同步${worst.map((i) => i.name).join('、')}…`;
    case 'pending':
    case 'never':
      return worst.map((i) => `${i.name}：${i.text}`).join('；');
    default:
      return on.length === 1 ? `${on[0]!.name}已同步` : '已全部同步';
  }
}

export function buildSummary(items: StatusItem[], permissions: PermissionStatus, updateNotice?: UpdateNotice, running?: SyncAllProgress): StatusSummary {
  const level = worstLevel(items.map((i) => i.level));
  return {
    level,
    text: summaryText(items, level),
    lastSyncAt: Math.max(0, ...items.map((i) => i.lastSyncAt)),
    items,
    permissions,
    updateNotice,
    ...(running ? { syncAll: running } : {}),
  };
}

export interface StatusSources {
  getStorageSync(): Promise<SyncStatus>;
  getWebDav(): Promise<BackendSyncStatus>;
}

/** 读取当前总状态 */
export async function getStatusSummary(src: StatusSources): Promise<StatusSummary> {
  const [settings, index, storageSync, webdav, stored] = await Promise.all([
    getSettings(),
    getSourceIndex(),
    src.getStorageSync(),
    src.getWebDav(),
    browser.storage.local.get(STORAGE_KEYS.updateNotice),
  ]);
  const w = settings.sync.webdav;
  // 权限检查失败（个别浏览器无 permissions API、地址不是合法 URL）按已授权处理，避免误报
  const granted = (check: () => Promise<boolean>) => Promise.resolve().then(check).catch(() => true);
  const allSites = await granted(hasAllSitesAccess);
  const webdavOrigin = w.enabled && w.url.trim() ? await granted(() => hasOriginAccess(w.url)) : undefined;
  const permissions: PermissionStatus = { allSites, webdavOrigin };
  if (!allSites) permissions.text = '未授权访问全部网站，只在已授权的网站上高亮';
  else if (webdavOrigin === false) permissions.text = '未授权访问 WebDAV 服务器，同步不会进行';

  const items: StatusItem[] = [storageSyncItem(storageSync), webdavItem(webdav, settings, webdavOrigin)];
  for (const info of SOURCE_PROVIDER_INFOS) {
    if (settings.sources[info.id]?.enabled) items.push(sourceItem(info.id, info.name, index));
  }
  return buildSummary(items, permissions, stored[STORAGE_KEYS.updateNotice] as UpdateNotice | undefined, syncAllProgress());
}

export interface SyncAllDeps extends StatusSources {
  syncStorage(): Promise<SyncStatus>;
  syncWebDav(): Promise<BackendSyncStatus>;
  syncSources(): Promise<SourceSyncResult[]>;
}

/** 退避/防抖等待时长 → “约 N 秒/分钟后”（无 retryAt 时用“稍后”） */
export function waitText(retryAt: number | undefined, now = Date.now()): string {
  if (!retryAt || retryAt <= now) return '稍后自动完成';
  const sec = Math.ceil((retryAt - now) / 1000);
  return sec < 60 ? `约 ${sec} 秒后自动完成` : `约 ${Math.ceil(sec / 60)} 分钟后自动完成`;
}

/**
 * syncAll 汇总（纯函数）：按状态分类成“已同步 / 等待同步 / 仍在同步 / 失败 / 未完成”，只要有启用项 message 就不为空。
 * ok = 没有失败与未完成；complete = ok 且没有等待/进行中（全部真正落盘）。
 */
export function summarizeSyncAll(
  summary: StatusSummary,
  sourcesError?: string,
  now = Date.now(),
): Pick<SyncAllResult, 'ok' | 'complete' | 'message'> {
  const active = summary.items.filter((i) => i.level !== 'off');
  if (!active.length) return { ok: true, complete: true, message: '未开启任何同步：可在选项页开启浏览器账号同步、WebDAV 或生词本来源' };
  const by = (level: StatusLevel) => active.filter((i) => i.level === level);
  const done = by('ok');
  const pending = by('pending');
  const busy = by('busy');
  const failed = by('error');
  // 同步后仍“从未同步”：来源从未成功过（未登录 / 没有远端生词本）
  const empty = by('never');
  const parts: string[] = [];
  if (done.length) parts.push(`已同步：${done.map((i) => i.name).join('、')}`);
  // pending = 已提交但还在防抖/退避，尚未写入云端，不能算“已同步”
  if (pending.length) parts.push(`等待同步：${pending.map((i) => `${i.name}（${waitText(i.retryAt, now)}）`).join('、')}`);
  if (busy.length) parts.push(`仍在同步：${busy.map((i) => i.name).join('、')}`);
  if (failed.length) parts.push(`失败：${failed.map((i) => `${i.name}（${i.text}）`).join('、')}`);
  if (empty.length) parts.push(`未完成：${empty.map((i) => `${i.name}（${i.text}）`).join('、')}`);
  if (sourcesError) parts.push(`生词本来源同步出错：${sourcesError}`);
  const ok = !failed.length && !empty.length && !sourcesError;
  return { ok, complete: ok && !pending.length && !busy.length, message: parts.join('；') };
}

/** 进行中的“立即同步全部”（同一 SW 内去重；SW 被回收后丢失，popup 轮询时 busy 项仍来自各后端持久化状态） */
let runningSyncAll: { startedAt: number; promise: Promise<SyncAllResult> } | undefined;
/** 最近一次完成的“立即同步全部”，供 popup 重新打开时展示结果 */
let lastSyncAll: SyncAllResult | undefined;

function syncAllProgress(): SyncAllProgress | undefined {
  if (runningSyncAll) return { running: true, startedAt: runningSyncAll.startedAt };
  if (lastSyncAll) return { running: false, startedAt: lastSyncAll.startedAt ?? 0, result: { ok: lastSyncAll.ok, complete: lastSyncAll.complete, message: lastSyncAll.message, finishedAt: lastSyncAll.finishedAt ?? 0 } };
  return undefined;
}

/** 单测复位模块级状态 */
export function resetSyncAllState(): void {
  runningSyncAll = undefined;
  lastSyncAll = undefined;
}

async function runSyncAll(deps: SyncAllDeps, startedAt: number): Promise<SyncAllResult> {
  const settings = await getSettings();
  const w = settings.sync.webdav;
  const [, , sourcesRes] = await Promise.allSettled([
    settings.sync.enabled ? deps.syncStorage() : Promise.resolve(undefined),
    w.enabled ? deps.syncWebDav() : Promise.resolve(undefined),
    deps.syncSources(),
  ]);
  const sources = sourcesRes.status === 'fulfilled' ? sourcesRes.value : [];
  const sourcesError = sourcesRes.status === 'rejected' ? (sourcesRes.reason instanceof Error ? sourcesRes.reason.message : String(sourcesRes.reason)) : undefined;
  // 汇总前先清掉“进行中”标记，避免 summary.syncAll 仍显示 running
  runningSyncAll = undefined;
  const summary = await getStatusSummary(deps);
  return { summary, sources, startedAt, finishedAt: Date.now(), ...summarizeSyncAll(summary, sourcesError) };
}

/**
 * 立即同步全部（popup “立即同步”）：已启用的同步后端与来源并行执行（不同服务器互不影响，来源内部按书串行避免限流），
 * 任何一项失败不影响其他项。同一 SW 内重复调用复用进行中的那一次。
 *
 * - 默认：等全部完成后返回最新总状态与汇总文案（开启欧路时可能要 1 分多钟）
 * - background=true：立即返回“已受理”（accepted=true，summary.syncAll.running=true），同步在后台继续；
 *   popup 关闭后不受影响，调用方轮询 getStatusSummary，summary.syncAll.result 出现即为完成
 */
export async function syncAll(deps: SyncAllDeps, opts: { background?: boolean } = {}): Promise<SyncAllResult> {
  if (!runningSyncAll) {
    const startedAt = Date.now();
    const promise = runSyncAll(deps, startedAt)
      .then((res) => (lastSyncAll = res))
      .finally(() => {
        if (runningSyncAll?.promise === promise) runningSyncAll = undefined;
      });
    runningSyncAll = { startedAt, promise };
  }
  if (!opts.background) return runningSyncAll.promise;
  // 先存到局部变量：下面 await getStatusSummary 期间同步可能已经结束（如全部同步项关闭时几乎立即完成），
  // runningSyncAll 会被 runSyncAll / finally 清空，await 之后不能再读它
  const { startedAt, promise } = runningSyncAll;
  // 后台模式不等待结果：失败只记日志（各项错误已写入各自的持久化状态，popup 轮询可见）
  promise.catch((e) => console.warn('[hnw] 立即同步全部失败', e));
  const summary = await getStatusSummary(deps);
  return { summary, sources: [], ok: true, complete: false, accepted: true, startedAt, message: '已开始同步，关闭弹窗也会在后台继续' };
}

/** onInstalled(reason=update)：记录升级提示，供 options/popup 首次打开时展示“更新说明”（同版本重载不提示） */
export async function recordUpdate(previousVersion: string | undefined): Promise<void> {
  const to = browser.runtime.getManifest().version;
  if (!previousVersion || previousVersion === to) return;
  const notice: UpdateNotice = { from: previousVersion, to, at: Date.now() };
  await browser.storage.local.set({ [STORAGE_KEYS.updateNotice]: notice });
}

export async function dismissUpdateNotice(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.updateNotice);
}
