import { findInflectedForms } from '../forms';
import type { Lemmatizer } from '@/core/lemma/types';
import type { DeleteWordsResult, SourceDeleteReport, SourceSyncResult } from '@/core/messaging/protocol';
import { createDefaultSourceSettings } from '@/core/settings/defaults';
import type { BookId } from '@/core/settings/schema';
import { getSettings, patchSettings } from '@/core/settings/store';
import { SourceError, type SourceContext } from '@/core/source/types';
import { sourceBookKey } from '@/core/storage/keys';
import { withStorageLock } from '@/core/storage/lock';
import { getOwn, setOwn } from '@/core/storage/own-record';
import { sourceBookId } from '@/core/wordbook/ids';
import type { SourceBookState, UserWord, UserWordMap } from '@/core/wordbook/types';
import { getSourceBook, getSourceIndex, patchSourceBookState, saveSourceBook, updateSourceIndex } from '@/core/wordbook/user-store';
import { effectiveBookRole } from '@/core/known/sources';
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

export const MSG_EMPTY = '同步完成，但生词本无内容，若实际有内容，请尝试重新登录';
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
        // 能力/角色以 provider 最新声明为准（如欧路配置 token 后分类变为可加词）
        const meta = {
          name: rb.name,
          role: rb.role ?? 'new',
          canAdd: !!rb.canAdd,
          canDelete: rb.canDelete ?? provider.capabilities.delete,
          readOnlyReason: rb.readOnlyReason,
        } satisfies Partial<SourceBookState>;
        idx.books[id] = prev
          ? { ...prev, ...meta, orphaned: false }
          : { id, providerId, remoteId: rb.remoteId, ...meta, status: 'never', lastSyncAt: 0, lastAttemptAt: 0, wordCount: 0 };
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
  // 熟词本角色的书（如欧路“已掌握”）启用为熟词来源，绝不能进高亮词书列表
  if (effectiveBookRole(state, settings) === 'known') {
    if (!settings.knownBooks.enabled.includes(state.id)) await patchSettings({ knownBooks: { enabled: [...settings.knownBooks.enabled, state.id] } });
    return;
  }
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
      // 沿用旧版：空结果不覆盖本地缓存（可能是登录失效导致的假空）；能确认登录的 provider 直接提示为空。
      // 请求本身成功，所以 ok=true + empty=true（UI 按 empty 显示“为空”，不当作失败）
      const message = provider.verifiesLoginOnEmpty ? MSG_EMPTY_VERIFIED : MSG_EMPTY;
      await patchSourceBookState(state, { status: 'empty', error: message, lastAttemptAt: now });
      return { bookId, ok: true, empty: true, message, count: 0 };
    }
    // 远端条目数：同一单词大小写不同的多个条目（有道 refs）各算一条，与网页显示的词数一致
    const entryCount = entryCountOf(words);
    await withStorageLock(sourceBookKey(bookId), () => saveSourceBook({ id: bookId, words, updatedAt: now }));
    await patchSourceBookState(state, { status: 'ok', lastSyncAt: now, wordCount: count, entryCount, error: undefined });
    if (state.lastSyncAt === 0) await enableNewSourceBook((await getSourceIndex()).books[bookId] ?? state);
    const dup = entryCount - count;
    return { bookId, ok: true, message: dup > 0 ? `同步成功（${entryCount} 个条目，其中 ${dup} 个是大小写不同的重复条目，已合并为 ${count} 个单词）` : '同步成功', count };
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
 * - 来源启用且 autoSync
 * - 只对用户真正连接过的来源生效：至少有一本书成功同步过（lastSyncAt > 0，含旧版迁移来的 syncTime）。
 *   从未同步成功的来源（新用户、开着但从未登录）不在后台自动请求，由用户在选项页开启来源（开启即同步一次）或手动同步
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

/** 删除时被移除的词条（用于撤销时恢复） */
export interface RemovedSourceWords {
  bookId: BookId;
  words: UserWord[];
}

/** 一本来源词书中要删除的词条 key（小写，必须是该书缓存中的 key） */
export interface SourceRemovalTarget {
  bookId: BookId;
  keys: string[];
}

/** 词条的全部删除句柄（refs 优先；旧缓存只有 ref；欧路无 ref 时用单词原文） */
function refsOf(w: UserWord): string[] {
  return w.refs?.length ? w.refs : [w.ref ?? w.word];
}

/** 远端条目数：同一单词大小写不同的多个条目（有道 refs）各算一条 */
function entryCountOf(words: UserWordMap): number {
  return Object.values(words).reduce((n, w) => n + Math.max(1, w.refs?.length ?? 1), 0);
}

/** 某本来源词书是否可以删词：provider 支持删除、书未孤立（远端分组已不存在时请求无意义）、书未声明只读 */
export function canDeleteFrom(state: SourceBookState | undefined): boolean {
  if (!state || state.orphaned || state.canDelete === false) return false;
  return !!getSourceProvider(state.providerId)?.capabilities.delete;
}

/**
 * 删除来源词书中的指定词条（远端 + 本地缓存），所有删除路径（卡片删除、标记熟词、加入生词本时移出来源熟词本）共用。
 *
 * 保护规则：
 * - 只对 canDeleteFrom 的书发请求；孤儿书（如迁移来的“全部单词”被分组取代后）不发请求
 * - provider.globalRefs（有道 itemId 全局唯一）时按 (来源, 句柄) 去重：同一 itemId 本轮只删一次，
 *   成功后同时清理同来源其他书缓存（含孤儿书）中的该条目，避免同一 itemId 被请求两次
 * - 一个词条有多个句柄（有道大小写重复条目）时全部删除成功才移除缓存；否则保留并报告失败
 * - provider 抛错（未登录/限流）时该书全部记为失败，缓存不动
 * removed 输出被删除的完整词条，供撤销时加回。
 */
export async function deleteSourceEntries(targets: SourceRemovalTarget[], removed?: RemovedSourceWords[]): Promise<SourceDeleteReport[]> {
  const index = await getSourceIndex();
  const reports: SourceDeleteReport[] = [];
  /** 全局句柄的删除结果：`<providerId>\n<ref>` -> 错误信息（undefined = 成功） */
  const doneRefs = new Map<string, string | undefined>();
  const refKey = (providerId: string, ref: string) => `${providerId}\n${ref}`;

  for (const target of targets) {
    const state = index.books[target.bookId];
    const provider = state && getSourceProvider(state.providerId);
    if (!state || !provider || !canDeleteFrom(state) || target.keys.length === 0) continue;
    const report = await withStorageLock(sourceBookKey(state.id), async () => {
      const data = await getSourceBook(state.id);
      if (!data) return undefined;
      const keys = [...new Set(target.keys)].filter((k) => getOwn(data.words, k));
      if (keys.length === 0) return undefined;
      const deleted: string[] = [];
      const failed: { word: string; error: string }[] = [];
      // 已在本轮其他书中删过的全局句柄不再请求，只发剩余句柄
      const pending: UserWord[] = [];
      const pendingKey = new Map<UserWord, string>();
      for (const k of keys) {
        const entry = getOwn(data.words, k)!;
        if (!provider.globalRefs) {
          pending.push(entry);
          pendingKey.set(entry, k);
          continue;
        }
        const refs = refsOf(entry);
        const prevErr = refs.map((r) => doneRefs.get(refKey(state.providerId, r))).find((e) => e !== undefined);
        if (prevErr) failed.push({ word: k, error: prevErr });
        const rest = refs.filter((r) => !doneRefs.has(refKey(state.providerId, r)));
        if (prevErr) continue;
        if (rest.length === 0) deleted.push(k);
        else {
          const partial = { ...entry, ref: rest[0], refs: rest };
          pending.push(partial);
          pendingKey.set(partial, k);
        }
      }
      if (pending.length > 0) {
        try {
          const res = await provider.deleteWords(state.remoteId, pending, await contextOf(state.providerId));
          const ok = new Set(res.deleted.map((w) => w.toLowerCase()));
          const errs = new Map(res.failed.map((f) => [f.word.toLowerCase(), f.error]));
          for (const entry of pending) {
            const k = pendingKey.get(entry)!;
            const lw = entry.word.toLowerCase();
            const error = ok.has(lw) ? undefined : (errs.get(lw) ?? '删除结果未知，请重新同步后再试');
            if (provider.globalRefs) for (const r of refsOf(entry)) doneRefs.set(refKey(state.providerId, r), error);
            if (error === undefined) deleted.push(k);
            else failed.push({ word: k, error });
          }
        } catch (e) {
          const error = errorMessage(e);
          for (const entry of pending) {
            if (provider.globalRefs) for (const r of refsOf(entry)) doneRefs.set(refKey(state.providerId, r), error);
            failed.push({ word: pendingKey.get(entry)!, error });
          }
        }
      }
      const removedEntries: UserWord[] = [];
      for (const k of deleted) {
        removedEntries.push(getOwn(data.words, k)!);
        delete data.words[k];
      }
      if (deleted.length > 0) {
        await saveSourceBook({ ...data, updatedAt: Date.now() });
        removed?.push({ bookId: state.id, words: removedEntries });
      }
      return { bookId: state.id, deleted, failed, count: Object.keys(data.words).length, entries: entryCountOf(data.words) };
    });
    if (!report) continue;
    await patchSourceBookState(state, { wordCount: report.count, entryCount: report.entries });
    reports.push({ bookId: report.bookId, deleted: report.deleted, failed: report.failed });
  }

  // 全局句柄已删除：清理同来源其他书（未作为目标的书、孤儿书）缓存中持有这些句柄的条目（只改本地，不发请求）
  const deletedRefs = [...doneRefs].filter(([, err]) => err === undefined).map(([k]) => k);
  if (deletedRefs.length > 0) await purgeDeletedRefs(new Set(deletedRefs), new Set(targets.map((t) => t.bookId)));
  return reports;
}

/** 从同来源其他缓存书中移除已被删除的全局句柄对应的条目（多句柄条目只去掉被删的句柄） */
async function purgeDeletedRefs(deleted: Set<string>, skip: Set<BookId>): Promise<void> {
  const index = await getSourceIndex();
  for (const state of Object.values(index.books)) {
    if (skip.has(state.id) || !getSourceProvider(state.providerId)?.globalRefs) continue;
    const count = await withStorageLock(sourceBookKey(state.id), async () => {
      const data = await getSourceBook(state.id);
      if (!data) return undefined;
      let changed = false;
      for (const [k, w] of Object.entries(data.words)) {
        const refs = refsOf(w);
        const left = refs.filter((r) => !deleted.has(`${state.providerId}\n${r}`));
        if (left.length === refs.length) continue;
        changed = true;
        if (left.length === 0) delete data.words[k];
        else setOwn(data.words, k, { ...w, ref: left[0], refs: left });
      }
      if (!changed) return undefined;
      await saveSourceBook({ ...data, updatedAt: Date.now() });
      return { wordCount: Object.keys(data.words).length, entryCount: entryCountOf(data.words) };
    });
    if (count) await patchSourceBookState(state, count);
  }
}

/** 删除结果汇总为给用户看的文案；deleted/failed 按单词去重 */
export function summarizeDelete(reports: SourceDeleteReport[]): DeleteWordsResult {
  const deleted = new Set(reports.flatMap((r) => r.deleted));
  const failed = reports.flatMap((r) => r.failed);
  if (reports.length === 0) return { ok: false, message: '生词本中没有该单词', reports };
  if (failed.length === 0) return { ok: true, message: `删除成功：${[...deleted].join('、')}`, reports };
  const firstError = failed[0]?.error ?? '';
  return {
    ok: false,
    message: deleted.size ? `已删除 ${[...deleted].join('、')}；${failed.length} 个删除失败（本地缓存已保留）：${firstError}` : `删除失败（本地缓存已保留）：${firstError}`,
    reports,
  };
}

/**
 * 从来源词书删除单词（卡片“从生词本删除”）。
 * - bookIds 不传：所有可删除（canDeleteFrom）的来源词书
 * - forms=true：删除 target 的屈折词形（见 background/forms.ts，不含派生词）；false 只删该词本身
 */
export async function deleteFromSources(
  word: string,
  opts: { bookIds?: BookId[]; forms: boolean; lemmatizer: Lemmatizer; removed?: RemovedSourceWords[] },
): Promise<DeleteWordsResult> {
  const index = await getSourceIndex();
  const target = word.toLowerCase();
  const targets: SourceRemovalTarget[] = [];
  for (const id of opts.bookIds ?? Object.keys(index.books)) {
    const state = index.books[id];
    if (!canDeleteFrom(state)) continue;
    const data = await getSourceBook(id);
    if (!data) continue;
    const keys = findInflectedForms(target, Object.keys(data.words), opts.lemmatizer, { sameLemma: opts.forms });
    if (keys.length) targets.push({ bookId: id, keys });
  }
  return summarizeDelete(await deleteSourceEntries(targets, opts.removed));
}

/**
 * 向来源词书加词（远端 + 本地缓存）：只对 canAdd 的书调用 provider.addWords，成功的词写入缓存（带新句柄）。
 * 抛出 SourceError 时由调用方转成提示；一个词都没加成功（provider 返回空）也抛 SourceError。
 */
export async function addToSourceBook(bookId: BookId, words: UserWord[]): Promise<UserWord[]> {
  const state = (await getSourceIndex()).books[bookId];
  const provider = state && getSourceProvider(state.providerId);
  if (!state || !provider) throw new SourceError('未知的来源生词本', 'unknown');
  if (!provider.addWords || !state.canAdd || state.orphaned) throw new SourceError(state.readOnlyReason ?? `“${state.name}”不支持加词`, 'unsupported');
  // 远端只收单词（欧路/有道加词接口都不接受释义）：只把单词与句柄交给 provider，释义/音标在下面写缓存时合并，
  // 这样 provider 回传的词条里有释义就一定来自远端
  const added = await provider.addWords(
    state.remoteId,
    words.map((w) => ({ word: w.word, ...(w.ref ? { ref: w.ref } : {}) })),
    await contextOf(state.providerId),
  );
  // provider 一个都没加进去却没抛错时也按失败处理，调用方（addWord/markKnown）据此写 ok=false，不能提示“已加入”
  if (words.length > 0 && added.length === 0) throw new SourceError(`加入“${state.name}”失败`, 'unknown');
  const count = await withStorageLock(sourceBookKey(bookId), async () => {
    const data = (await getSourceBook(bookId)) ?? { id: bookId, words: {}, updatedAt: 0 };
    for (const w of added) {
      const key = w.word.toLowerCase();
      // 句柄以 provider 返回的为准；provider 不回传释义/音标（欧路只回传单词、有道只补 itemId）时，
      // 依次沿用该书已有缓存（从来源同步来的，最贴近远端）与调用方传入的（撤销加回时是删除前缓存的词条，卡片加入时是卡片释义），
      // 避免冷僻词（打包词典没有）丢失来源释义直到下次全量同步（集成审核第 1 轮：卡片“加入”不带释义时覆盖了同步来的 trans/phonetic）
      const input = words.find((x) => x.word.toLowerCase() === key);
      const prev = getOwn(data.words, key);
      const merged: UserWord = { ...w };
      const phonetic = w.phonetic ?? prev?.phonetic ?? input?.phonetic;
      const trans = w.trans ?? prev?.trans ?? input?.trans;
      if (phonetic) merged.phonetic = phonetic;
      else delete merged.phonetic;
      if (trans) merged.trans = trans;
      else delete merged.trans;
      setOwn(data.words, key, merged);
    }
    await saveSourceBook({ ...data, updatedAt: Date.now() });
    return Object.keys(data.words).length;
  });
  await patchSourceBookState(state, { wordCount: count });
  return added;
}

/**
 * 把之前删除的词条加回来源生词本（撤销）：原书可加词时加回原书；原书不可加词时（如有道非默认分组）加回同来源的可写书
 * （有道默认分组“无标签”），并在 fallbackTo 中说明。返回加回成功的单词。
 */
export async function restoreSourceWords(removed: RemovedSourceWords[]): Promise<{ restored: string[]; fallback: { from: string; to: string }[]; lost: string[] }> {
  const index = await getSourceIndex();
  const restored: string[] = [];
  const fallback: { from: string; to: string }[] = [];
  const lost: string[] = [];
  for (const { bookId, words } of removed) {
    const state = index.books[bookId];
    if (!state || words.length === 0) continue;
    const writable = state.canAdd && !state.orphaned ? state : booksOf(index, state.providerId).find((b) => b.canAdd && !b.orphaned && (b.role ?? 'new') === 'new');
    if (!writable) {
      lost.push(...words.map((w) => w.word.toLowerCase()));
      continue;
    }
    try {
      // 旧句柄已失效，加回时去掉 ref/refs（欧路用单词原文，provider 会补回）
      const added = await addToSourceBook(writable.id, words.map((w) => ({ word: w.word, phonetic: w.phonetic, trans: w.trans })));
      restored.push(...added.map((w) => w.word.toLowerCase()));
      if (writable.id !== state.id && added.length) fallback.push({ from: state.name, to: writable.name });
    } catch (e) {
      console.warn('[hnw] 恢复来源单词失败', bookId, e);
      lost.push(...words.map((w) => w.word.toLowerCase()));
    }
  }
  return { restored, fallback, lost };
}
