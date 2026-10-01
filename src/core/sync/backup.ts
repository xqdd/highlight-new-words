import { browser } from 'wxt/browser';
import { getKnownData, saveKnownData } from '../known/store';
import { mergeKnownWords, normalizeKnown } from '../known/merge';
import type { KnownWordsData } from '../known/types';
import { normalizeSettings } from '../settings/migrate';
import type { Settings } from '../settings/schema';
import { getSettings, saveSettings } from '../settings/store';
import { STORAGE_KEYS, localBookKey, sourceBookKey } from '../storage/keys';
import { withStorageLock } from '../storage/lock';
import { getOwn, hasOwnKey, setOwn } from '../storage/own-record';
import { getLocalBook, getLocalIndex, getSourceBook, getSourceIndex, updateLocalIndex, updateSourceIndex } from '../wordbook/user-store';
import type { LocalBookMeta, UserWordMap } from '../wordbook/types';
import { base64ToBytes, bytesToBase64, stableStringify } from './codec';
import { credentialDigest, credentialsFor, mergeRemoteCredentials, readCredential, type CredentialBundle } from './credentials';
import { mergeSyncedSettings, pickSyncedSettings, planLocalBooksMerge, type LocalBookSegment, type SyncedSettings } from './merge';
import { applyLocalBooks, applySourceBook, type SourceBookSegment } from './snapshot';
import {
  BACKUP_FORMAT,
  type BackupDiffCount,
  type BackupExport,
  type BackupImportMode,
  type BackupImportPreview,
  type BackupImportResult,
} from './types';

/**
 * 手动备份导入导出（追加需求 v4 第 11 条“手动导入导出”）。
 *
 * 备份文件是可读的单个 JSON（BackupFile），可选 gzip 压缩（CompressionStream，文件名 .json.gz）。内容：
 * 设置（去掉本机字段 sync 与 apiToken）、本地熟词本（含墓碑）、本地词书（含删除墓碑）、可选来源词书缓存、
 * 以及勾选“随同步上传”的凭据（与同步后端一致：不勾选就不导出）。
 *
 * 导入两种方式，合并规则与同步完全相同（复用 merge.ts / known/merge.ts / snapshot.ts）：
 * - merge 合并：设置按 updatedAt 较新者；熟词并集 + 墓碑；本地词书逐本按 updatedAt + 墓碑；来源缓存较新者
 * - overwrite 覆盖：本机数据换成备份内容；本机有而备份没有的熟词/本地词书记删除墓碑（会同步删除到其他设备），
 *   覆盖写入的数据时间戳记为导入时刻，保证经同步传播时胜出。来源词书缓存只覆盖备份中有的书（缓存可重新拉取）
 * 导入前先 previewBackupImport 得到新增/删除/更新/冲突计数，用户确认后 importBackup 执行。
 */

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  v: 1;
  exportedAt: number;
  device?: string;
  settings: SyncedSettings;
  knownWords: KnownWordsData;
  localBooks: { removed: Record<string, number>; books: { meta: LocalBookMeta; words: UserWordMap }[] };
  sourceBooks?: SourceBookSegment[];
  credentials?: CredentialBundle;
}

/** 收集本机数据为备份对象 */
/**
 * 构造备份文件。凭据（勾选“随同步上传”的来源 token、WebDAV 密码）在备份文件里是明文，
 * 默认不放进备份，只有调用方显式传 includeCredentials=true（用户在导出时确认）才包含。
 */
export async function buildBackup(opts: { includeSourceBooks?: boolean; includeCredentials?: boolean; device?: string } = {}): Promise<BackupFile> {
  const settings = await getSettings();
  const index = await getLocalIndex();
  const books: BackupFile['localBooks']['books'] = [];
  for (const meta of Object.values(index.books)) {
    const data = await getLocalBook(meta.id);
    if (data) books.push({ meta, words: data.words });
  }
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    v: 1,
    exportedAt: Date.now(),
    ...(opts.device ? { device: opts.device } : {}),
    settings: pickSyncedSettings(settings),
    knownWords: await getKnownData(),
    localBooks: { removed: index.removed, books },
  };
  if (opts.includeSourceBooks) {
    const src = await getSourceIndex();
    file.sourceBooks = [];
    for (const state of Object.values(src.books)) {
      const data = await getSourceBook(state.id);
      if (data) file.sourceBooks.push({ state: { ...state, status: 'ok', error: undefined }, data });
    }
  }
  if (opts.includeCredentials) {
    const creds = await credentialsFor(settings, 'backup');
    if (Object.keys(creds).length) file.credentials = creds;
  }
  return file;
}

async function gzip(text: string): Promise<Uint8Array> {
  const body = new Response(new TextEncoder().encode(text) as BufferSource).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const body = new Response(bytes as BufferSource).body!.pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await new Response(body).arrayBuffer());
}

/** 导出：compress=true 时 gzip 后 base64（options 解码为二进制下载 .json.gz） */
export async function exportBackup(opts: { includeSourceBooks?: boolean; includeCredentials?: boolean; compress?: boolean; device?: string } = {}): Promise<BackupExport> {
  const file = await buildBackup(opts);
  const json = JSON.stringify(file);
  const d = new Date(file.exportedAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const counts = {
    knownWords: Object.keys(file.knownWords.words).length,
    localBooks: file.localBooks.books.length,
    sourceBooks: file.sourceBooks?.length ?? 0,
    credentials: Object.keys(file.credentials ?? {}).length,
    // 勾选了上传但因未确认 includeCredentials 而没放进备份的凭据数（options 可提示“凭据未包含”）
    skippedCredentials: opts.includeCredentials ? 0 : Object.keys(await credentialsFor(await getSettings(), 'backup')).length,
  };
  const bytes = new TextEncoder().encode(json).length;
  if (opts.compress) {
    return { fileName: `hnw-backup-${stamp}.json.gz`, mime: 'application/gzip', encoding: 'gzip-base64', content: bytesToBase64(await gzip(json)), bytes, counts };
  }
  return { fileName: `hnw-backup-${stamp}.json`, mime: 'application/json', encoding: 'json', content: json, bytes, counts };
}

/**
 * 解析备份内容：JSON 文本，或 gzip 文件的 base64（options 读文件后统一转字符串传给 background）。
 * 不是本扩展备份时抛出中文错误。
 */
export async function parseBackup(content: string): Promise<BackupFile> {
  const text = content.trimStart();
  let json: string;
  if (text.startsWith('{')) json = text;
  else {
    try {
      json = await gunzip(base64ToBytes(text.trim()));
    } catch {
      throw new Error('无法识别的备份文件：不是 JSON，也不是 gzip 压缩的备份');
    }
  }
  let raw: Partial<BackupFile>;
  try {
    raw = JSON.parse(json) as Partial<BackupFile>;
  } catch {
    throw new Error('备份文件已损坏：JSON 解析失败');
  }
  if (raw.format !== BACKUP_FORMAT || raw.v !== 1) throw new Error('不是本扩展导出的备份文件（缺少格式标识）');
  return {
    format: BACKUP_FORMAT,
    v: 1,
    exportedAt: Number(raw.exportedAt) || 0,
    device: raw.device,
    settings: raw.settings as SyncedSettings,
    knownWords: normalizeKnown(raw.knownWords),
    localBooks: { removed: raw.localBooks?.removed ?? {}, books: Array.isArray(raw.localBooks?.books) ? raw.localBooks.books.filter((b) => b?.meta?.id && b.words) : [] },
    ...(Array.isArray(raw.sourceBooks) ? { sourceBooks: raw.sourceBooks.filter((b) => b?.state?.id && b.data?.words) } : {}),
    ...(raw.credentials ? { credentials: raw.credentials } : {}),
  };
}

const zero = (): BackupDiffCount => ({ added: 0, removed: 0, updated: 0, conflicts: 0 });

/** 设置内容比较时忽略 updatedAt */
function settingsBody(s: SyncedSettings): string {
  const { updatedAt: _u, ...rest } = s;
  return stableStringify(normalizeSettings({ ...rest, updatedAt: 0 }));
}

/** 计算导入差异（只读） */
export async function previewBackup(file: BackupFile, mode: BackupImportMode): Promise<BackupImportPreview> {
  const settings = await getSettings();
  const localSynced = pickSyncedSettings(settings);
  const changed = !!file.settings && settingsBody(localSynced) !== settingsBody(file.settings);
  const settingsPreview = {
    changed,
    willApply: changed && (mode === 'overwrite' || (file.settings.updatedAt ?? 0) > settings.updatedAt),
    conflict: changed,
  };

  // 熟词
  const local = await getKnownData();
  const known = zero();
  if (mode === 'merge') {
    const merged = mergeKnownWords(local, file.knownWords);
    for (const w of Object.keys(merged.words)) if (!(w in local.words)) known.added++;
    for (const w of Object.keys(local.words)) if (!(w in merged.words)) known.removed++;
    // 冲突：一边是熟词、另一边有删除记录（按时间取较新者）
    for (const w of Object.keys(local.words)) if (w in file.knownWords.removed) known.conflicts++;
    for (const w of Object.keys(file.knownWords.words)) if (w in local.removed) known.conflicts++;
  } else {
    for (const w of Object.keys(file.knownWords.words)) if (!(w in local.words)) known.added++;
    for (const w of Object.keys(local.words)) if (!(w in file.knownWords.words)) known.removed++;
  }

  // 本地词书
  const index = await getLocalIndex();
  const books = zero();
  const fileIds = new Set(file.localBooks.books.map((b) => b.meta.id));
  for (const b of file.localBooks.books) {
    const mine = index.books[b.meta.id];
    if (!mine) continue;
    const mineWords = (await getLocalBook(b.meta.id))?.words ?? {};
    if (mine.updatedAt !== b.meta.updatedAt || mine.name !== b.meta.name || stableStringify(mineWords) !== stableStringify(b.words)) books.conflicts++;
  }
  if (mode === 'merge') {
    const plan = planLocalBooksMerge(
      index,
      file.localBooks.books.map((b): LocalBookSegment => ({ meta: b.meta, words: b.words })),
      file.localBooks.removed,
    );
    for (const seg of plan.upsert) {
      if (index.books[seg.meta.id]) books.updated++;
      else books.added++;
    }
    books.removed = plan.remove.length;
  } else {
    for (const b of file.localBooks.books) {
      if (!index.books[b.meta.id]) books.added++;
    }
    books.updated = books.conflicts;
    books.removed = Object.keys(index.books).filter((id) => !fileIds.has(id)).length;
    books.conflicts = 0;
  }

  // 来源词书缓存
  let sourceBooks: BackupDiffCount | undefined;
  if (file.sourceBooks) {
    sourceBooks = zero();
    for (const seg of file.sourceBooks) {
      const mine = await getSourceBook(seg.data.id);
      if (!mine) sourceBooks.added++;
      else if (mode === 'overwrite' ? stableStringify(mine.words) !== stableStringify(seg.data.words) : seg.data.updatedAt > mine.updatedAt) sourceBooks.updated++;
    }
  }

  // 凭据（只采用本机勾选上传的；合并看时间，覆盖时只要不同就采用）
  const credentials =
    mode === 'merge'
      ? await mergeRemoteCredentials(file.credentials ?? {}, { dryRun: true })
      : Object.entries(file.credentials ?? {})
          .filter(([id, e]) => settings.credentialSync[id] && credentialDigest(readCredential(settings, id)) !== credentialDigest(e.v))
          .map(([id]) => id);

  const total = zero();
  for (const c of [known, books, ...(sourceBooks ? [sourceBooks] : [])]) {
    total.added += c.added;
    total.removed += c.removed;
    total.updated += c.updated;
    total.conflicts += c.conflicts;
  }
  if (settingsPreview.willApply) total.updated++;
  if (mode === 'merge' && settingsPreview.conflict) total.conflicts++;

  const parts = [
    `熟词 +${known.added} −${known.removed}`,
    `本地词书 新增 ${books.added}、更新 ${books.updated}、删除 ${books.removed}`,
    ...(sourceBooks ? [`来源词书缓存 新增 ${sourceBooks.added}、更新 ${sourceBooks.updated}`] : []),
    settingsPreview.willApply ? '设置将被替换为备份中的版本' : settingsPreview.changed ? '设置保留本机版本（本机较新）' : '设置相同',
    ...(credentials.length ? [`凭据 ${credentials.length} 项`] : []),
  ];
  if (mode === 'merge' && total.conflicts) parts.push(`冲突 ${total.conflicts} 处（按修改时间取较新者）`);
  return {
    mode,
    exportedAt: file.exportedAt,
    device: file.device,
    settings: settingsPreview,
    knownWords: known,
    localBooks: books,
    ...(sourceBooks ? { sourceBooks } : {}),
    credentials,
    total,
    summary: parts.join('；'),
  };
}

export async function previewBackupImport(content: string, mode: BackupImportMode): Promise<BackupImportPreview> {
  return previewBackup(await parseBackup(content), mode);
}

/** 执行导入，返回导入前计算的预览与说明 */
export async function importBackup(content: string, mode: BackupImportMode): Promise<BackupImportResult> {
  const file = await parseBackup(content);
  const preview = await previewBackup(file, mode);
  if (mode === 'merge') await importMerge(file);
  else await importOverwrite(file);
  return { ok: true, preview, message: `导入完成（${mode === 'merge' ? '合并' : '覆盖'}）：${preview.summary}` };
}

async function importMerge(file: BackupFile): Promise<void> {
  const settings = await getSettings();
  const merged = file.settings && mergeSyncedSettings(settings, file.settings);
  if (merged) await saveSettings(merged, { keepUpdatedAt: true });
  if (file.credentials) await mergeRemoteCredentials(file.credentials);
  await withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const local = await getKnownData();
    const next = mergeKnownWords(local, file.knownWords);
    if (stableStringify(next) !== stableStringify(local)) await saveKnownData(next);
  });
  await applyLocalBooks(
    file.localBooks.books.map((b) => ({ meta: b.meta, words: b.words })),
    file.localBooks.removed,
  );
  for (const seg of file.sourceBooks ?? []) await applySourceBook(seg);
}

async function importOverwrite(file: BackupFile): Promise<void> {
  const now = Date.now();
  // 设置：换成备份内容；本机字段（同步配置、未随备份提供的 token）保留；updatedAt=现在，经同步传播时胜出
  const local = await getSettings();
  if (file.settings) {
    const next: Settings = normalizeSettings(file.settings);
    next.sync = structuredClone(local.sync);
    for (const [id, src] of Object.entries(next.sources)) {
      const token = local.sources[id]?.apiToken;
      if (token) src.apiToken = token;
    }
    await saveSettings(next);
  }
  if (file.credentials) {
    // 覆盖模式：备份中勾选上传的凭据一律采用（时间戳记为现在）
    const forced: CredentialBundle = Object.fromEntries(Object.entries(file.credentials).map(([id, e]) => [id, { v: e.v, at: now }]));
    await mergeRemoteCredentials(forced);
  }
  // 熟词：备份中的熟词保留原加入时间（不早于其在本机的删除时间时才会生效，所以统一不早于 now 之前的墓碑）；本机多出的记墓碑
  await withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const cur = await getKnownData();
    const next: KnownWordsData = { words: {}, removed: { ...file.knownWords.removed } };
    for (const [w, t] of Object.entries(file.knownWords.words)) {
      const removedAt = getOwn(cur.removed, w);
      setOwn(next.words, w, removedAt !== undefined && removedAt >= t ? now : t);
      delete next.removed[w];
    }
    for (const w of Object.keys(cur.words)) if (!hasOwnKey(next.words, w)) setOwn(next.removed, w, now);
    await saveKnownData(next);
  });
  // 本地词书：备份中的书写入（updatedAt=现在）；本机多出的删除并记墓碑
  const index = await getLocalIndex();
  const fileIds = new Set(file.localBooks.books.map((b) => b.meta.id));
  const items: Record<string, unknown> = {};
  for (const b of file.localBooks.books) items[localBookKey(b.meta.id)] = { id: b.meta.id, words: b.words };
  if (Object.keys(items).length) await browser.storage.local.set(items);
  const drop = Object.keys(index.books).filter((id) => !fileIds.has(id));
  if (drop.length) await browser.storage.local.remove(drop.map(localBookKey));
  await updateLocalIndex((idx) => {
    for (const b of file.localBooks.books) {
      idx.books[b.meta.id] = { ...b.meta, wordCount: Object.keys(b.words).length, updatedAt: now };
      delete idx.removed[b.meta.id];
    }
    for (const id of drop) {
      delete idx.books[id];
      idx.removed[id] = now;
    }
  });
  // 来源词书缓存：备份中有的书直接覆盖缓存与展示状态
  for (const seg of file.sourceBooks ?? []) {
    await browser.storage.local.set({ [sourceBookKey(seg.data.id)]: seg.data });
    await updateSourceIndex((idx) => {
      const prev = idx.books[seg.state.id];
      idx.books[seg.state.id] = prev ? { ...prev, wordCount: seg.state.wordCount, entryCount: seg.state.entryCount, lastSyncAt: seg.state.lastSyncAt } : { ...seg.state, status: 'ok' };
    });
  }
}
