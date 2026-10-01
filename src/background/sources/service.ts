import { findWordFormsOfLemma } from '@/core/match/forms';
import type { Lemmatizer } from '@/core/lemma/types';
import type { DeleteWordsResult, SourceDeleteReport, SourceSyncResult } from '@/core/messaging/protocol';
import { createDefaultSourceSettings } from '@/core/settings/defaults';
import type { BookId } from '@/core/settings/schema';
import { getSettings, patchSettings } from '@/core/settings/store';
import { SourceError, type SourceContext } from '@/core/source/types';
import { sourceBookKey } from '@/core/storage/keys';
import { withStorageLock } from '@/core/storage/lock';
import { sourceBookId } from '@/core/wordbook/ids';
import type { SourceBookState, UserWord } from '@/core/wordbook/types';
import { getSourceBook, getSourceIndex, patchSourceBookState, saveSourceBook, updateSourceIndex } from '@/core/wordbook/user-store';
import { getSourceProvider, listSourceProviders } from './index';

/**
 * 来源词书服务：列表刷新、逐本同步、删词、撤销恢复。每本书独立的状态/错误，互不影响。
 *
 * 关键约定：
 * - 按来源同步（providerId / 全部来源）总是先刷新远端生词本列表，发现新书、标记消失的书为 orphaned
 * - 列表刷新失败（未登录、限流）时不再逐本请求，直接把该来源下各书标为 error，避免无效请求
 * - 同一本书同一时刻只有一个同步任务（重复点击/自动同步复用同一 Promise）
 * - SW 被回收会让状态停在 syncing，启动时 recoverInterruptedSyncs 复位为 error
 */

export const MSG_EMPTY = '同步成功，但生词本无内容，若实际有内容，请尝试重新登录';
export const MSG_EMPTY_VERIFIED = '同步成功，该生词本为空';
export const MSG_NETWORK = '网络错误或服务器出错，请检查网络后再试或重新登录';
const MSG_INTERRUPTED = '同步被中断，请重试';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 自动同步失败后的重试间隔：避免 SW 每次唤醒都重复请求失败的来源 */
const AUTO_RETRY_MS = 60 * 60 * 1000;

async function contextOf(providerId: string): Promise<SourceContext> {
  const settings = await getSettings();
  return { settings: settings.sources[providerId] ?? createDefaultSourceSettings() };
}

/** 给用户看的错误文案：SourceError 用其 message，其余（fetch 失败、JSON 异常）统一为网络错误 */
export function errorMessage(e: unknown): string {
  return e instanceof SourceError ? e.message : MSG_NETWORK;
}

function booksOf(index: { books: Record<string, SourceBookState> }, providerId: string): SourceBookState[] {
  return Object.values(index.books).filter((b) => b.providerId === providerId);
}

/** 刷新列表的内部实现：成功返回该来源全部书；失败记录 providers[id].error 并返回错误文案 */
async function refreshList(providerId: string): Promise<{ books: SourceBookState[]; error?: string }> {
  const provider = getSourceProvider(providerId);
  if (!provider) throw new Error(`未知来源：${providerId}`);
  try {
    const remote = await provider.listRemoteBooks(await contextOf(providerId));
    const index = await updateSourceIndex((idx) => {
      const seen = new Set<string>();
      for (const rb of remote) {
        const id = sourceBookId(providerId, rb.remoteId);
        seen.add(id);
        const prev = idx.books[id];
        idx.books[id] = prev
          ? { ...prev, name: rb.name, orphaned: false }
          : { id, providerId, remoteId: rb.remoteId, name: rb.name, status: 'never', lastSyncAt: 0, lastAttemptAt: 0, wordCount: 0 };
      }
      for (const b of booksOf(idx, providerId)) if (!seen.has(b.id)) b.orphaned = true;
      idx.providers[providerId] = { lastListAt: Date.now() };
    });
    return { books: booksOf(index, providerId) };
  } catch (e) {
    console.warn('[hnw] 刷新来源生词本列表失败', providerId, e);
    const error = errorMessage(e);
    const index = await updateSourceIndex((idx) => void (idx.providers[providerId] = { lastListAt: Date.now(), error }));
    return { books: booksOf(index, providerId), error };
  }
}

/** 刷新某来源的远端生词本列表：新书登记为 never，消失的书标记 orphaned（保留本地缓存） */
export async function refreshSourceBooks(providerId: string): Promise<SourceBookState[]> {
  return (await refreshList(providerId)).books;
}

/**
 * 首次同步成功的书自动启用：若同来源有已启用的孤儿书（如迁移来的“全部单词”被分组取代），插到它的位置以保持优先级；否则放最前。
 */
async function enableNewSourceBook(state: SourceBookState): Promise<void> {
  const settings = await getSettings();
  const enabled = settings.books.enabled;
  if (enabled.includes(state.id)) return;
  const index = await getSourceIndex();
  const orphanPos = enabled.findIndex((id) => {
    const b = index.books[id];
    return b?.providerId === state.providerId && b.orphaned;
  });
  const next = [...enabled];
  next.splice(orphanPos >= 0 ? orphanPos : 0, 0, state.id);
  await patchSettings({ books: { enabled: next } });
}

/**
 * 来源列表刷新后，若该来源已有新书同步成功并启用，则把已启用的孤儿书移出启用列表（本地缓存保留，UI 可删除），
 * 避免“全部单词”与各分组重复高亮。
 */
async function retireEnabledOrphans(providerId: string): Promise<void> {
  const settings = await getSettings();
  const index = await getSourceIndex();
  const enabled = settings.books.enabled;
  const hasLiveEnabled = enabled.some((id) => {
    const b = index.books[id];
    return b?.providerId === providerId && !b.orphaned && b.status === 'ok';
  });
  if (!hasLiveEnabled) return;
  const next = enabled.filter((id) => {
    const b = index.books[id];
    return !(b?.providerId === providerId && b.orphaned);
  });
  if (next.length !== enabled.length) await patchSettings({ books: { enabled: next } });
}

const inflight = new Map<BookId, Promise<SourceSyncResult>>();

/** 同步单本来源词书；首次同步成功的书自动加入启用列表。同一本书并发调用复用同一任务 */
export function syncSourceBook(bookId: BookId): Promise<SourceSyncResult> {
  let task = inflight.get(bookId);
  if (!task) {
    task = doSyncSourceBook(bookId).finally(() => inflight.delete(bookId));
    inflight.set(bookId, task);
  }
  return task;
}

async function doSyncSourceBook(bookId: BookId): Promise<SourceSyncResult> {
  const state = (await getSourceIndex()).books[bookId];
  const provider = state && getSourceProvider(state.providerId);
  if (!state || !provider) return { bookId, ok: false, message: '未知的来源生词本' };
  const now = Date.now();
  await patchSourceBookState(state, { status: 'syncing', lastAttemptAt: now });
  try {
    const words = await provider.fetchWords(state.remoteId, await contextOf(state.providerId));
    const count = Object.keys(words).length;
    if (count === 0) {
      // 沿用旧版：空结果不覆盖本地缓存（可能是登录失效导致的假空）；能确认登录的 provider 直接提示为空
      const message = provider.verifiesLoginOnEmpty ? MSG_EMPTY_VERIFIED : MSG_EMPTY;
      await patchSourceBookState(state, { status: 'empty', error: message });
      return { bookId, ok: false, message, count: 0 };
    }
    await withStorageLock(sourceBookKey(bookId), () => saveSourceBook({ id: bookId, words, updatedAt: now }));
    await patchSourceBookState(state, { status: 'ok', lastSyncAt: now, wordCount: count, error: undefined });
    if (state.lastSyncAt === 0) await enableNewSourceBook(state);
    return { bookId, ok: true, message: '同步成功', count };
  } catch (e) {
    console.warn('[hnw] 同步失败', bookId, e);
    const message = errorMessage(e);
    await patchSourceBookState(state, { status: 'error', error: message });
    return { bookId, ok: false, message };
  }
}

/** 同步一个来源：刷新列表 -> 逐本同步未孤立的书 -> 退役被取代的孤儿书 */
async function syncProvider(providerId: string): Promise<SourceSyncResult[]> {
  const { books, error } = await refreshList(providerId);
  const live = books.filter((b) => !b.orphaned);
  if (error) {
    // 列表都拿不到（多为未登录/限流），逐本请求只会得到同样的错误
    for (const b of live) await patchSourceBookState(b, { status: 'error', error, lastAttemptAt: Date.now() });
    return live.length > 0 ? live.map((b) => ({ bookId: b.id, ok: false, message: error })) : [{ bookId: `src:${providerId}:`, ok: false, message: error }];
  }
  const results: SourceSyncResult[] = [];
  for (const b of live) results.push(await syncSourceBook(b.id));
  await retireEnabledOrphans(providerId);
  return results;
}

/**
 * 批量同步：bookIds 优先（只同步这些书，不刷新列表）；否则按来源（providerId 或全部启用来源）刷新列表后同步全部书。
 * 按来源、按书串行（避免同一站点并发请求触发限流）。
 */
export async function syncSourceBooks(opts: { bookIds?: BookId[]; providerId?: string }): Promise<SourceSyncResult[]> {
  if (opts.bookIds) {
    const results: SourceSyncResult[] = [];
    for (const id of opts.bookIds) results.push(await syncSourceBook(id));
    return results;
  }
  const settings = await getSettings();
  const providerIds = opts.providerId
    ? [opts.providerId]
    : listSourceProviders().map((p) => p.id).filter((id) => settings.sources[id]?.enabled);
  const results: SourceSyncResult[] = [];
  for (const pid of providerIds) results.push(...(await syncProvider(pid)));
  return results;
}

/** SW 启动时把停在 syncing 的书（上次 SW 被回收导致中断）复位为 error */
export async function recoverInterruptedSyncs(): Promise<void> {
  const index = await getSourceIndex();
  if (!Object.values(index.books).some((b) => b.status === 'syncing')) return;
  await updateSourceIndex((idx) => {
    for (const b of Object.values(idx.books)) if (b.status === 'syncing') Object.assign(b, { status: 'error', error: MSG_INTERRUPTED });
  });
}

let autoSyncRunning: Promise<void> | undefined;

/**
 * 每天自动同步（旧版逻辑：autoSync 开启且距上次同步超过 24 小时）。SW 每次启动都会调用，条件不满足时不发请求：
 * - 来源启用且 autoSync；该来源至少有一本书成功同步过（从未同步过的来源不自动请求，避免未登录用户反复报错）
 * - 有书距上次成功同步超过 24 小时，且距上次尝试超过 1 小时（失败后不在每次唤醒时重试）
 */
export function autoSyncIfDue(now = Date.now()): Promise<void> {
  autoSyncRunning ??= (async () => {
    const settings = await getSettings();
    const index = await getSourceIndex();
    for (const provider of listSourceProviders()) {
      const src = settings.sources[provider.id];
      if (!src?.enabled || !src.autoSync) continue;
      const books = booksOf(index, provider.id).filter((b) => !b.orphaned);
      const due = books.some((b) => b.lastSyncAt > 0 && now - b.lastSyncAt > DAY_MS && now - b.lastAttemptAt > AUTO_RETRY_MS);
      if (!due) continue;
      const results = await syncProvider(provider.id);
      console.log('[hnw] 自动同步', provider.id, results.map((r) => `${r.bookId}: ${r.message}`));
    }
  })().finally(() => (autoSyncRunning = undefined));
  return autoSyncRunning;
}

/** 删除时被移除的词条（用于撤销熟词时恢复） */
export interface RemovedSourceWords {
  bookId: BookId;
  words: UserWord[];
}

/**
 * 从来源词书删除单词（远端 + 本地缓存）。
 * - bookIds 不传：所有包含该词（或其词形）且 provider 支持删除的来源词书
 * - forms=true：按原形删除全部词形（借助 Lemmatizer + WordMatcher，见 findWordFormsOfLemma）
 * 远端删除失败的词保留在本地缓存中，与远端保持一致；provider 抛错（未登录/限流）时该书全部记为失败。
 * removed 输出被删除的完整词条，供 markKnown 记录撤销信息。
 */
export async function deleteFromSources(
  word: string,
  opts: { bookIds?: BookId[]; forms: boolean; lemmatizer: Lemmatizer; removed?: RemovedSourceWords[] },
): Promise<DeleteWordsResult> {
  const index = await getSourceIndex();
  const target = word.toLowerCase();
  const books = (opts.bookIds ?? Object.keys(index.books)).map((id) => index.books[id]).filter((b): b is SourceBookState => !!b);
  const reports: SourceDeleteReport[] = [];
  for (const state of books) {
    const provider = getSourceProvider(state.providerId);
    if (!provider?.capabilities.delete) continue;
    const report = await withStorageLock(sourceBookKey(state.id), async () => {
      const data = await getSourceBook(state.id);
      if (!data) return undefined;
      const keys = opts.forms ? findWordFormsOfLemma(target, Object.keys(data.words), opts.lemmatizer) : data.words[target] ? [target] : [];
      if (keys.length === 0) return undefined;
      const entries = keys.map((k) => data.words[k]!);
      let res;
      try {
        res = await provider.deleteWords(state.remoteId, entries, await contextOf(state.providerId));
      } catch (e) {
        const error = errorMessage(e);
        return { bookId: state.id, deleted: [], failed: entries.map((w) => ({ word: w.word.toLowerCase(), error })), count: Object.keys(data.words).length };
      }
      const deleted = res.deleted.map((w) => w.toLowerCase());
      const removedEntries: UserWord[] = [];
      for (const k of deleted) {
        if (data.words[k]) removedEntries.push(data.words[k]!);
        delete data.words[k];
      }
      if (deleted.length > 0) {
        await saveSourceBook({ ...data, updatedAt: Date.now() });
        opts.removed?.push({ bookId: state.id, words: removedEntries });
      }
      return { bookId: state.id, deleted, failed: res.failed, count: Object.keys(data.words).length };
    });
    if (!report) continue;
    await patchSourceBookState(state, { wordCount: report.count });
    reports.push({ bookId: report.bookId, deleted: report.deleted, failed: report.failed });
  }
  const deleted = reports.reduce((n, r) => n + r.deleted.length, 0);
  const failed = reports.reduce((n, r) => n + r.failed.length, 0);
  if (reports.length === 0) return { ok: false, message: '生词本中没有该单词', reports };
  if (failed === 0) return { ok: true, message: '删除成功', reports };
  const firstError = reports.flatMap((r) => r.failed)[0]?.error ?? '';
  return { ok: false, message: deleted ? `已删除 ${deleted} 个，${failed} 个删除失败：${firstError}` : `删除失败：${firstError}`, reports };
}

/**
 * 把之前删除的词条加回来源生词本（撤销熟词）：provider 支持 addWords 时先加回远端，成功的词再写回本地缓存。
 * 返回恢复成功的单词（小写）。
 */
export async function restoreSourceWords(removed: RemovedSourceWords[]): Promise<string[]> {
  const index = await getSourceIndex();
  const restored: string[] = [];
  for (const { bookId, words } of removed) {
    const state = index.books[bookId];
    const provider = state && getSourceProvider(state.providerId);
    if (!state || !provider?.addWords || words.length === 0) continue;
    let added: UserWord[];
    try {
      added = await provider.addWords(state.remoteId, words, await contextOf(state.providerId));
    } catch (e) {
      console.warn('[hnw] 恢复来源单词失败', bookId, e);
      continue;
    }
    if (added.length === 0) continue;
    const count = await withStorageLock(sourceBookKey(bookId), async () => {
      const data = (await getSourceBook(bookId)) ?? { id: bookId, words: {}, updatedAt: 0 };
      for (const w of added) data.words[w.word.toLowerCase()] = w;
      await saveSourceBook({ ...data, updatedAt: Date.now() });
      return Object.keys(data.words).length;
    });
    await patchSourceBookState(state, { wordCount: count });
    restored.push(...added.map((w) => w.word.toLowerCase()));
  }
  return restored;
}
