import { browser } from 'wxt/browser';
import { getKnownData, getKnownWords, setKnownWords } from '@/core/known/store';
import { effectiveBookRole } from '@/core/known/sources';
import { PackagedDictionary } from '@/core/dict/packaged';
import type { Dictionary } from '@/core/dict/types';
import { createLemmatizer } from '@/core/lemma';
import type { Lemmatizer } from '@/core/lemma/types';
import type {
  AddWordResult,
  MarkKnownResult,
  RemoveWordResult,
  SourceDeleteReport,
  WordActionPreview,
  WordActionPreviewItem,
  WordTargetResult,
} from '@/core/messaging/protocol';
import { LOCAL_KNOWN_BOOK_ID, MY_WORDS_BOOK_ID, type BookId, type Settings } from '@/core/settings/schema';
import { getSettings, patchSettings } from '@/core/settings/store';
import { getProviderInfo } from '@/core/source/providers';
import { STORAGE_KEYS, localBookKey } from '@/core/storage/keys';
import { withStorageLock } from '@/core/storage/lock';
import { parseBookId } from '@/core/wordbook/ids';
import type { LocalBookData, LocalBookIndex, SourceBookIndex, UserWord } from '@/core/wordbook/types';
import { getLocalBook, getLocalIndex, getSourceBook, getSourceIndex, updateLocalIndex } from '@/core/wordbook/user-store';
import { findHomographForms, findInflectedForms } from './forms';
import { getSourceProvider } from './sources';
import {
  addToSourceBook,
  canDeleteFrom,
  deleteSourceEntries,
  errorMessage,
  restoreSourceWords,
  type RemovedSourceWords,
  type SourceRemovalTarget,
} from './sources/service';

/**
 * 单词操作（追加需求 v3 第 6–10 条）：标记熟词 / 撤销、加入生词本 / 移出、执行前预览。
 *
 * 目标配置见 settings.wordActions（schema.ts WordActionSettings）。所有“移除”都只处理屈折词形（forms.ts），
 * 绝不使用高亮匹配的派生候选链；来源词书的远端删除不可完全恢复，卡片应先调用 previewWordAction 让用户确认。
 */

/** background 共享的词形还原器（懒加载数据，init 幂等；init 失败时下次调用重试） */
let lemmatizerPromise: Promise<Lemmatizer> | undefined;
export function getLemmatizer(): Promise<Lemmatizer> {
  lemmatizerPromise ??= (async () => {
    const l = createLemmatizer();
    await l.init?.();
    return l;
  })().catch((e) => {
    lemmatizerPromise = undefined;
    throw e;
  });
  return lemmatizerPromise;
}

/** 同形异义判定用的打包词典（只在有远端删除时才加载对应首字母分片）；单测可注入 */
let homographDict: Dictionary | undefined;
export function setHomographDictionary(d: Dictionary | undefined): void {
  homographDict = d;
}
async function lookupForms(word: string): Promise<{ word: string }[] | undefined> {
  homographDict ??= new PackagedDictionary();
  return (await homographDict.lookup(word))?.forms;
}

const LOCAL_KNOWN_NAME = '本地熟词本';
const MY_WORDS_NAME = '我的生词本';

// ---------------- 撤销记录 ----------------

/** 撤销记录有效期：卡片上的“撤销”通常在几秒内点击，10 分钟足够且避免误恢复很久以前删除的词 */
export const KNOWN_UNDO_TTL_MS = 10 * 60 * 1000;

interface UndoRecord {
  at: number;
  /** 被删除的来源词条（撤销时加回） */
  sourceRemoved: RemovedSourceWords[];
  /** 被移除的本地词书词条（撤销时原样写回） */
  localRemoved: { bookId: BookId; words: UserWord[] }[];
  /** 从本地熟词本移除的词（撤销加入生词本时加回） */
  knownLocalRemoved: string[];
  /** 写入来源词书的词（撤销时从远端删除）：bookId -> 小写词 */
  sourceAdded: SourceRemovalTarget[];
}
/** key：`known:<lemma>` / `add:<lemma>` */
type UndoStore = Record<string, UndoRecord>;

/** 过期撤销记录的保留时长：只用于撤销时说明“撤销记录已失效”，之后清理 */
const UNDO_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * 撤销记录存在 storage.local（不是 session）：浏览器重启会清空 session，导致 10 分钟内撤销却加不回远端删除的词
 * 且没有任何说明（集成审核第 1 轮）。有效期仍由 KNOWN_UNDO_TTL_MS 控制。
 */
async function loadUndo(): Promise<UndoStore> {
  const res = await browser.storage.local.get(STORAGE_KEYS.knownUndo);
  return (res[STORAGE_KEYS.knownUndo] as UndoStore | undefined) ?? {};
}

async function saveUndo(store: UndoStore): Promise<void> {
  const now = Date.now();
  for (const [k, v] of Object.entries(store)) if (now - v.at > UNDO_KEEP_MS || !Array.isArray(v.sourceRemoved)) delete store[k];
  await browser.storage.local.set({ [STORAGE_KEYS.knownUndo]: store });
}

async function putUndo(key: string, record: UndoRecord): Promise<void> {
  const store = await loadUndo();
  store[key] = record;
  await saveUndo(store);
}

/** 取出并删除撤销记录：有效期内返回 record；已过期返回 expired（供说明哪些词没有加回）；没有记录或旧结构都返回空 */
async function takeUndo(key: string): Promise<{ record?: UndoRecord; expired?: UndoRecord }> {
  const store = await loadUndo();
  const record = store[key];
  if (!record) return {};
  delete store[key];
  await saveUndo(store);
  if (!Array.isArray(record.sourceRemoved)) return {};
  return Date.now() - record.at > KNOWN_UNDO_TTL_MS ? { expired: record } : { record };
}

// ---------------- 上下文与目标解析 ----------------

interface ActionContext {
  settings: Settings;
  sources: SourceBookIndex;
  locals: LocalBookIndex;
  lemmatizer: Lemmatizer;
}

async function loadContext(): Promise<ActionContext> {
  const [settings, sources, locals, lemmatizer] = await Promise.all([getSettings(), getSourceIndex(), getLocalIndex(), getLemmatizer()]);
  return { settings, sources, locals, lemmatizer };
}

/** 目标显示名：来源词书“有道词典 · 无标签”；本地词书用其名称 */
function targetName(id: BookId, ctx: ActionContext): string {
  if (id === LOCAL_KNOWN_BOOK_ID) return LOCAL_KNOWN_NAME;
  const parsed = parseBookId(id);
  if (parsed.kind === 'local') return ctx.locals.books[id]?.name ?? (id === MY_WORDS_BOOK_ID ? MY_WORDS_NAME : '已删除的本地词书');
  if (parsed.kind === 'source') {
    const state = ctx.sources.books[id];
    return `${getProviderInfo(parsed.providerId)?.name ?? parsed.providerId} · ${state?.name ?? parsed.remoteId}`;
  }
  return id;
}

/**
 * 标记熟词时要移除的生词本：
 * - 'auto'（默认，兼容旧开关）：“加入生词本”的本地目标（默认“我的生词本”）+ 启用的来源中开启 deleteOnKnown、
 *   支持删除的全部生词本（未孤立、角色为 new）
 * - 列表：用户在选项页选择的本地/来源生词本
 */
export function resolveKnownRemoveFrom(settings: Settings, sources: SourceBookIndex): BookId[] {
  const conf = settings.wordActions.knownRemoveFrom;
  if (conf !== 'auto') return [...new Set(conf)];
  // 本地“加入生词本”的目标（默认“我的生词本”）：认识后不再是生词，一并移出（本地移除可完整撤销），
  // 否则卡片会同时显示“已收藏”和“熟词”
  const localAddTargets = addTargetsOf(settings).filter((id) => parseBookId(id).kind === 'local');
  const sourceBooks = Object.values(sources.books)
    .filter((b) => {
      const src = settings.sources[b.providerId];
      return src?.enabled && src.deleteOnKnown && canDeleteFrom(b) && effectiveBookRole(b, settings) === 'new';
    })
    .map((b) => b.id);
  return [...new Set([...localAddTargets, ...sourceBooks])];
}

/** 移除计划中的一项：某本书中要移除的 key（屈折词形） */
interface RemovalItem {
  bookId: BookId;
  kind: 'known-local' | 'local' | 'source';
  keys: string[];
  /** 不能执行的原因（来源只读等）；有值时不执行，只在结果中说明 */
  blocked?: string;
  /** 来源词书中属于同形异义的词形（forms.ts#findHomographForms），未确认时不删除 */
  homographs?: string[];
}

/** 按配置规划移除：只读本地数据，不发请求；没有命中词形的书不列出 */
async function planRemoval(ids: BookId[], target: string, surface: string, ctx: ActionContext): Promise<RemovalItem[]> {
  const opts = { sameLemma: ctx.settings.wordActions.sameLemma, surface };
  const out: RemovalItem[] = [];
  for (const id of [...new Set(ids)]) {
    if (id === LOCAL_KNOWN_BOOK_ID) {
      const keys = findInflectedForms(target, Object.keys((await getKnownData()).words), ctx.lemmatizer, opts);
      if (keys.length) out.push({ bookId: id, kind: 'known-local', keys });
      continue;
    }
    const parsed = parseBookId(id);
    if (parsed.kind === 'local') {
      const data = await getLocalBook(id);
      const keys = data ? findInflectedForms(target, Object.keys(data.words), ctx.lemmatizer, opts) : [];
      if (keys.length) out.push({ bookId: id, kind: 'local', keys });
    } else if (parsed.kind === 'source') {
      const state = ctx.sources.books[id];
      const data = state && (await getSourceBook(id));
      const keys = data ? findInflectedForms(target, Object.keys(data.words), ctx.lemmatizer, opts) : [];
      if (!keys.length) continue;
      const blocked = canDeleteFrom(state) ? undefined : (state?.readOnlyReason ?? (state?.orphaned ? '远端已没有该生词本' : '该来源不支持删除'));
      const homographs = blocked ? [] : await findHomographForms(keys, target, surface, lookupForms);
      out.push({ bookId: id, kind: 'source', keys, blocked, ...(homographs.length ? { homographs } : {}) });
    }
  }
  return out;
}

/** 撤销能否把远端删除的词加回原书 */
function sourceUndoable(bookId: BookId, ctx: ActionContext): boolean {
  return sourceUndoTarget(bookId, ctx).mode === 'same';
}

/**
 * 撤销时远端删除的词加回到哪里（与 sources/service.ts#restoreSourceWords 的规则一致）：
 * same=原书；fallback=同来源可加词的生词本（如有道非默认分组只能加回“无标签”）；lost=无法加回（欧路 cookie 模式等）
 */
function sourceUndoTarget(bookId: BookId, ctx: ActionContext): { mode: 'same' | 'fallback' | 'lost'; to?: string } {
  const state = ctx.sources.books[bookId];
  if (!state || !getSourceProvider(state.providerId)?.addWords) return { mode: 'lost' };
  if (state.canAdd && !state.orphaned) return { mode: 'same' };
  const alt = Object.values(ctx.sources.books).find((b) => b.providerId === state.providerId && b.canAdd && !b.orphaned && (b.role ?? 'new') === 'new');
  return alt ? { mode: 'fallback', to: targetName(alt.id, ctx) } : { mode: 'lost' };
}

// ---------------- 本地词书读写 ----------------

/** 向本地词书加词；MY_WORDS_BOOK_ID 不存在时自动创建并加入启用列表（最前，优先级最高）；其他已删除的本地词书返回 false */
async function addLocalWords(id: BookId, words: UserWord[]): Promise<boolean> {
  const index = await getLocalIndex();
  const exists = !!index.books[id];
  if (!exists && id !== MY_WORDS_BOOK_ID) return false;
  const count = await withStorageLock(localBookKey(id), async () => {
    const data: LocalBookData = (await getLocalBook(id)) ?? { id, words: {} };
    for (const w of words) data.words[w.word.toLowerCase()] = { ...data.words[w.word.toLowerCase()], ...w };
    await browser.storage.local.set({ [localBookKey(id)]: data });
    return Object.keys(data.words).length;
  });
  const now = Date.now();
  await updateLocalIndex((idx) => {
    const prev = idx.books[id];
    idx.books[id] = prev
      ? { ...prev, wordCount: count, updatedAt: now }
      : { id, name: MY_WORDS_NAME, format: 'txt', wordCount: count, createdAt: now, updatedAt: now };
    delete idx.removed[id];
  });
  if (!exists) {
    const settings = await getSettings();
    if (!settings.books.enabled.includes(id)) await patchSettings({ books: { enabled: [id, ...settings.books.enabled] } });
  }
  return true;
}

/** 从本地词书移除指定 key，返回被移除的词条 */
async function removeLocalWords(id: BookId, keys: string[]): Promise<UserWord[]> {
  const removed: UserWord[] = [];
  const count = await withStorageLock(localBookKey(id), async () => {
    const data = await getLocalBook(id);
    if (!data) return undefined;
    for (const k of keys) {
      if (!data.words[k]) continue;
      removed.push(data.words[k]!);
      delete data.words[k];
    }
    if (removed.length) await browser.storage.local.set({ [localBookKey(id)]: data });
    return Object.keys(data.words).length;
  });
  if (removed.length && count !== undefined) {
    await updateLocalIndex((idx) => {
      const meta = idx.books[id];
      if (meta) idx.books[id] = { ...meta, wordCount: count, updatedAt: Date.now() };
    });
  }
  return removed;
}

// ---------------- 执行移除 ----------------

interface RemovalOutcome {
  results: WordTargetResult[];
  sourceReports: SourceDeleteReport[];
  sourceRemoved: RemovedSourceWords[];
  localRemoved: { bookId: BookId; words: UserWord[] }[];
  knownLocalRemoved: string[];
}

/** 执行移除计划：本地熟词本、本地词书直接改；来源词书统一走 deleteSourceEntries（跨书去重） */
async function executeRemoval(plan: RemovalItem[], ctx: ActionContext): Promise<RemovalOutcome> {
  const out: RemovalOutcome = { results: [], sourceReports: [], sourceRemoved: [], localRemoved: [], knownLocalRemoved: [] };
  const sourceTargets: SourceRemovalTarget[] = [];
  for (const item of plan) {
    const name = targetName(item.bookId, ctx);
    if (item.blocked) {
      out.results.push({ bookId: item.bookId, name, ok: false, words: item.keys, error: item.blocked, skipped: true });
    } else if (item.kind === 'known-local') {
      await setKnownWords(item.keys, false);
      out.knownLocalRemoved.push(...item.keys);
      out.results.push({ bookId: item.bookId, name, ok: true, words: item.keys });
    } else if (item.kind === 'local') {
      const words = await removeLocalWords(item.bookId, item.keys);
      if (words.length) out.localRemoved.push({ bookId: item.bookId, words });
      out.results.push({ bookId: item.bookId, name, ok: true, words: words.map((w) => w.word.toLowerCase()) });
    } else {
      sourceTargets.push({ bookId: item.bookId, keys: item.keys });
    }
  }
  if (sourceTargets.length) {
    out.sourceReports = await deleteSourceEntries(sourceTargets, out.sourceRemoved);
    for (const r of out.sourceReports) {
      out.results.push({
        bookId: r.bookId,
        name: targetName(r.bookId, ctx),
        ok: r.failed.length === 0,
        words: r.deleted,
        ...(r.failed.length ? { error: `${r.failed.map((f) => f.word).join('、')} 删除失败（已保留）：${r.failed[0]!.error}` } : {}),
      });
    }
  }
  return out;
}

/** 结果列表 -> 简短中文说明：成功“从“有道词典 · 无标签”删除 run、runs”，失败/跳过附原因 */
function describe(results: WordTargetResult[], verb: (name: string, words: string) => string): string[] {
  const parts: string[] = [];
  for (const r of results) {
    if (r.words.length && r.ok) parts.push(verb(r.name, r.words.join('、')));
    else if (!r.ok) parts.push(`“${r.name}”${r.skipped ? '未处理' : '失败'}：${r.error ?? '未知错误'}`);
  }
  return parts;
}
const removedFrom = (name: string, words: string) => `已从“${name}”删除 ${words}`;
const addedTo = (name: string, words: string) => `已加入“${name}”：${words}`;

// ---------------- 标记熟词 ----------------

/**
 * 标记熟词：
 * 1. 写入 knownTargets（本地熟词本；可写的来源熟词本调用 addWords；只读的如欧路“已掌握”跳过并说明）。
 *    没有任何目标写入成功时兜底写本地熟词本，保证“认识”一定生效
 * 2. 从 knownRemoveFrom（'auto' = 各来源 deleteOnKnown）移除该词的屈折词形（sameLemma 关闭时只移除当前词形与原形本身）
 * 3. 记录撤销信息
 */
export async function markKnown(word: string, lemma: string, opts: { confirmed?: boolean } = {}): Promise<MarkKnownResult> {
  const target = lemma.trim().toLowerCase();
  const surface = word.trim().toLowerCase() || target;
  const ctx = await loadContext();
  const written: WordTargetResult[] = [];
  const sourceAdded: SourceRemovalTarget[] = [];
  for (const id of [...new Set(ctx.settings.wordActions.knownTargets)]) {
    const name = targetName(id, ctx);
    if (id === LOCAL_KNOWN_BOOK_ID) {
      await setKnownWords([target], true);
      written.push({ bookId: id, name, ok: true, words: [target] });
      continue;
    }
    const state = ctx.sources.books[id];
    if (!state || effectiveBookRole(state, ctx.settings) !== 'known') {
      written.push({ bookId: id, name, ok: false, words: [], error: '不是熟词本', skipped: true });
      continue;
    }
    if (!state.canAdd) {
      written.push({ bookId: id, name, ok: false, words: [], error: state.readOnlyReason ?? '该熟词本不支持写入', skipped: true });
      continue;
    }
    try {
      const added = await addToSourceBook(id, [{ word: target }]);
      const keys = added.map((w) => w.word.toLowerCase());
      sourceAdded.push({ bookId: id, keys });
      written.push({ bookId: id, name, ok: true, words: keys });
    } catch (e) {
      written.push({ bookId: id, name, ok: false, words: [], error: errorMessage(e) });
    }
  }
  if (!written.some((w) => w.ok)) {
    await setKnownWords([target], true);
    written.push({ bookId: LOCAL_KNOWN_BOOK_ID, name: LOCAL_KNOWN_NAME, ok: true, words: [target] });
  }

  const plan = (await planRemoval(resolveKnownRemoveFrom(ctx.settings, ctx.sources), target, surface, ctx)).filter((p) => p.kind !== 'known-local');
  // 后台层保护：同形异义词形（lie→lay、find→found）的远端删除必须经用户确认（confirmed），否则保留并在结果中列出
  const withheld: NonNullable<MarkKnownResult['withheld']> = [];
  if (!opts.confirmed) {
    for (const item of plan) {
      if (!item.homographs?.length) continue;
      withheld.push({ bookId: item.bookId, name: targetName(item.bookId, ctx), words: item.homographs });
      item.keys = item.keys.filter((k) => !item.homographs!.includes(k));
    }
  }
  const removal = await executeRemoval(
    plan.filter((p) => p.keys.length),
    ctx,
  );
  if (removal.sourceRemoved.length || removal.localRemoved.length || sourceAdded.length) {
    await putUndo(`known:${target}`, { at: Date.now(), sourceRemoved: removal.sourceRemoved, localRemoved: removal.localRemoved, knownLocalRemoved: [], sourceAdded });
  }
  const fullyUndoable = removal.sourceRemoved.every((r) => sourceUndoable(r.bookId, ctx));
  console.log('[hnw] 标记熟词', word, '->', target, removal.results, withheld);

  const parts = ['已标记为熟词', ...describe(written.filter((w) => !w.ok), addedTo), ...describe(removal.results, removedFrom)];
  // 撤销说明与 unmarkKnown 的实际行为一致：能加回原书的不提示；只能加回同来源其他分组的说明去向；确实加不回的才说“不会恢复”
  for (const r of removal.sourceRemoved) {
    if (!r.words.length) continue;
    const undo = sourceUndoTarget(r.bookId, ctx);
    const words = r.words.map((w) => w.word.toLowerCase()).join('、');
    if (undo.mode === 'fallback') parts.push(`撤销时 ${words} 会加回“${undo.to}”（“${targetName(r.bookId, ctx)}”不支持加词）`);
    else if (undo.mode === 'lost') parts.push(`注意：撤销不会恢复已从“${targetName(r.bookId, ctx)}”删除的 ${words}`);
  }
  for (const w of withheld) parts.push(`${w.words.join('、')} 也是独立的单词，未从“${w.name}”删除（确认后才会删除）`);
  return {
    ok: true,
    lemma: target,
    deleted: removal.sourceReports,
    message: parts.join('；'),
    written,
    removedLocal: removal.results.filter((r) => parseBookId(r.bookId).kind === 'local'),
    fullyUndoable,
    ...(withheld.length ? { withheld } : {}),
  };
}

/** 撤销熟词：移出本地熟词本（记墓碑）；有效期内撤回 markKnown 的远端写入，并恢复移除的本地/来源词条 */
export async function unmarkKnown(lemma: string): Promise<{ ok: boolean; restored?: string[]; message?: string }> {
  const target = lemma.trim().toLowerCase();
  await setKnownWords([target], false);
  const { record, expired } = await takeUndo(`known:${target}`);
  const notes: string[] = [];
  if (expired) {
    // 超过 10 分钟不再自动加回（避免误恢复很久以前删除的词），但要说清楚哪些词没有回来
    const lost = [...new Set([...expired.sourceRemoved, ...expired.localRemoved].flatMap((r) => r.words.map((w) => w.word.toLowerCase())))];
    if (lost.length) notes.push(`已从熟词本移除，但撤销记录已失效（超过 10 分钟），认识时从生词本删除的 ${lost.join('、')} 未加回`);
  }
  const restored: string[] = [];
  if (record) {
    // 写入过的来源熟词本：删除刚加入的词（能删才删）
    if (record.sourceAdded.length) await deleteSourceEntries(record.sourceAdded);
    for (const { bookId, words } of record.localRemoved) {
      if (await addLocalWords(bookId, words)) restored.push(...words.map((w) => w.word.toLowerCase()));
    }
    const res = await restoreSourceWords(record.sourceRemoved);
    restored.push(...res.restored);
    for (const f of res.fallback) notes.push(`“${f.from}”不支持加词，已加回“${f.to}”`);
    if (res.lost.length) notes.push(`${[...new Set(res.lost)].join('、')} 已从来源删除，无法自动加回`);
  }
  // 仍在启用的来源熟词本中（如欧路“已掌握”）时提醒：本地撤销后仍不会高亮
  if ((await getKnownWords()).has(target)) notes.push('该词仍在启用的来源熟词本中，依然不会高亮');
  const uniq = [...new Set(restored)];
  const message = ['已撤销', ...(uniq.length ? [`已加回 ${uniq.join('、')}`] : []), ...notes].join('；');
  return { ok: true, restored: uniq, message };
}

// ---------------- 加入 / 移出生词本 ----------------

/** addTargets 为空时退回“我的生词本” */
function addTargetsOf(settings: Settings): BookId[] {
  const ids = [...new Set(settings.wordActions.addTargets)];
  return ids.length ? ids : [MY_WORDS_BOOK_ID];
}

/**
 * 卡片传入的 targets 只保留已知的生词本：存在的本地词书（“我的生词本”不存在时会自动创建，也保留）、
 * 已登记的来源词书；本地熟词本与未知 id 过滤掉。只读来源（如欧路“已掌握”）保留，写入时跳过并在结果中说明。
 */
function knownAddTargets(targets: BookId[], ctx: ActionContext): BookId[] {
  return [...new Set(targets)].filter((id) => {
    if (id === LOCAL_KNOWN_BOOK_ID) return false;
    const kind = parseBookId(id).kind;
    if (kind === 'local') return id === MY_WORDS_BOOK_ID || !!ctx.locals.books[id];
    if (kind === 'source') return !!ctx.sources.books[id];
    return false;
  });
}

/**
 * 加入生词本：写入 addTargets（或卡片传入的 targets）（本地直接写；来源调用 addWords，只读的跳过并说明），
 * 再从 addRemoveFromKnown 移除该词（同原形开关控制是否移除屈折词形）。
 */
export async function addWord(data: {
  word: string;
  lemma: string;
  trans?: string;
  phonetic?: string;
  targets?: BookId[];
}): Promise<AddWordResult> {
  const target = data.lemma.trim().toLowerCase();
  const surface = data.word.trim().toLowerCase() || target;
  const ctx = await loadContext();
  // 卡片临时选择的目标（含“撤销后重新加入”）完全取代默认 addTargets；空数组视为非法，不回退默认目标
  let writeIds: BookId[];
  if (data.targets) {
    writeIds = knownAddTargets(data.targets, ctx);
    if (!writeIds.length) {
      const message = data.targets.length ? '所选生词本已不存在，未加入' : '未选择写入目标，未加入';
      return { ok: false, lemma: target, added: [], removedKnown: [], message };
    }
  } else {
    writeIds = addTargetsOf(ctx.settings);
  }
  const entry: UserWord = { word: target, ...(data.trans ? { trans: data.trans } : {}), ...(data.phonetic ? { phonetic: data.phonetic } : {}) };
  const added: WordTargetResult[] = [];
  const sourceAdded: SourceRemovalTarget[] = [];
  const localAdded: { bookId: BookId; words: UserWord[] }[] = [];
  for (const id of writeIds) {
    const name = targetName(id, ctx);
    const kind = parseBookId(id).kind;
    if (kind === 'local') {
      const ok = await addLocalWords(id, [entry]);
      if (ok) localAdded.push({ bookId: id, words: [entry] });
      added.push(ok ? { bookId: id, name, ok, words: [target] } : { bookId: id, name, ok, words: [], error: '该本地词书已删除', skipped: true });
    } else if (kind === 'source') {
      const state = ctx.sources.books[id];
      if (!state?.canAdd) {
        added.push({ bookId: id, name, ok: false, words: [], error: state?.readOnlyReason ?? '该生词本不支持加词', skipped: true });
        continue;
      }
      try {
        // 带上卡片的释义/音标：远端只收单词，本地缓存据此保留释义（已有缓存词条的释义也会保留，见 addToSourceBook）
        const res = await addToSourceBook(id, [entry]);
        const keys = res.map((w) => w.word.toLowerCase());
        sourceAdded.push({ bookId: id, keys });
        added.push({ bookId: id, name, ok: true, words: keys });
      } catch (e) {
        added.push({ bookId: id, name, ok: false, words: [], error: errorMessage(e) });
      }
    }
  }
  const plan = await planRemoval(ctx.settings.wordActions.addRemoveFromKnown, target, surface, ctx);
  const removal = await executeRemoval(plan, ctx);
  await putUndo(`add:${target}`, {
    at: Date.now(),
    sourceRemoved: removal.sourceRemoved,
    localRemoved: [],
    knownLocalRemoved: removal.knownLocalRemoved,
    sourceAdded,
  });
  const ok = added.some((a) => a.ok);
  const parts = [ok ? `已加入${added.filter((a) => a.ok).map((a) => `“${a.name}”`).join('、')}` : '加入失败'];
  parts.push(...describe(added.filter((a) => !a.ok), addedTo), ...describe(removal.results, removedFrom));
  if ((await getKnownWords()).has(target)) parts.push('该词仍在启用的熟词本中，不会高亮（可在选项页调整熟词本）');
  return { ok, lemma: target, added, removedKnown: removal.results, message: parts.join('；') };
}

/** 移出生词本（收藏取消 / 撤销加入）：只处理该原形本身；有效期内把加入时移出的熟词加回 */
export async function removeWord(data: { lemma: string; bookIds?: BookId[] }): Promise<RemoveWordResult> {
  const target = data.lemma.trim().toLowerCase();
  const ctx = await loadContext();
  const ids = data.bookIds ?? addTargetsOf(ctx.settings);
  const plan: RemovalItem[] = [];
  for (const id of ids) {
    const kind = parseBookId(id).kind;
    if (kind === 'local' && (await getLocalBook(id))?.words[target]) plan.push({ bookId: id, kind: 'local', keys: [target] });
    if (kind === 'source' && (await getSourceBook(id))?.words[target]) {
      const state = ctx.sources.books[id];
      plan.push({ bookId: id, kind: 'source', keys: [target], blocked: canDeleteFrom(state) ? undefined : (state?.readOnlyReason ?? '该来源不支持删除') });
    }
  }
  const removal = await executeRemoval(plan, ctx);
  const { record } = await takeUndo(`add:${target}`);
  if (record?.knownLocalRemoved.length) await setKnownWords(record.knownLocalRemoved, true);
  if (record?.sourceRemoved.length) await restoreSourceWords(record.sourceRemoved);
  const ok = removal.results.every((r) => r.ok);
  const parts = removal.results.length ? describe(removal.results, removedFrom) : ['生词本中没有该单词'];
  return { ok, removed: removal.results, message: parts.join('；') };
}

// ---------------- 预览与状态 ----------------

/** addWord / markKnown 执行前预览：列出写入目标与各书中将被移除的词形（只读本地缓存） */
export async function previewWordAction(data: { action: 'add' | 'known'; word: string; lemma: string }): Promise<WordActionPreview> {
  const target = data.lemma.trim().toLowerCase();
  const surface = data.word.trim().toLowerCase() || target;
  const ctx = await loadContext();
  const writeIds = data.action === 'add' ? addTargetsOf(ctx.settings) : [...new Set(ctx.settings.wordActions.knownTargets)];
  const write: WordActionPreviewItem[] = writeIds.map((id) => {
    const name = targetName(id, ctx);
    const remote = parseBookId(id).kind === 'source';
    const state = ctx.sources.books[id];
    const supported = !remote || (!!state?.canAdd && (data.action === 'add' || effectiveBookRole(state, ctx.settings) === 'known'));
    return { bookId: id, name, ok: supported, words: [target], remote, undoable: true, ...(supported ? {} : { error: state?.readOnlyReason ?? '不支持写入', skipped: true }) };
  });
  const removeIds = data.action === 'add' ? ctx.settings.wordActions.addRemoveFromKnown : resolveKnownRemoveFrom(ctx.settings, ctx.sources);
  const plan = await planRemoval(removeIds, target, surface, ctx);
  const remove: WordActionPreviewItem[] = plan
    .filter((p) => data.action === 'add' || p.kind !== 'known-local')
    .map((p) => {
      const remote = p.kind === 'source';
      return {
        bookId: p.bookId,
        name: targetName(p.bookId, ctx),
        ok: !p.blocked,
        words: p.keys,
        remote,
        undoable: !remote || sourceUndoable(p.bookId, ctx),
        ...(p.homographs?.length ? { homographs: p.homographs } : {}),
        ...(p.blocked ? { error: p.blocked, skipped: true } : {}),
      };
    });
  return { action: data.action, lemma: target, write, remove, needsConfirm: remove.some((r) => r.remote && r.ok) };
}

/** 单词状态：是否在 addTargets 的某本书中（收藏按钮）、是否为熟词（含启用的来源熟词本） */
export async function getWordState(lemma: string): Promise<{ collected: boolean; collectedIn: BookId[]; known: boolean }> {
  const target = lemma.trim().toLowerCase();
  const settings = await getSettings();
  const collectedIn: BookId[] = [];
  for (const id of addTargetsOf(settings)) {
    const kind = parseBookId(id).kind;
    const words = kind === 'local' ? (await getLocalBook(id))?.words : kind === 'source' ? (await getSourceBook(id))?.words : undefined;
    if (words?.[target]) collectedIn.push(id);
  }
  return { collected: collectedIn.length > 0, collectedIn, known: (await getKnownWords()).has(target) };
}
