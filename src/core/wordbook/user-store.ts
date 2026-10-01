import { browser } from 'wxt/browser';
import type { ImportFormat } from '../import/types';
import type { BookId } from '../settings/schema';
import { STORAGE_KEYS, localBookKey, sourceBookKey } from '../storage/keys';
import { withStorageLock } from '../storage/lock';
import { localBookId } from './ids';
import type {
  LocalBookData,
  LocalBookIndex,
  LocalBookMeta,
  SourceBookData,
  SourceBookIndex,
  SourceBookState,
  UserWord,
  UserWordMap,
} from './types';

/**
 * 用户词书存储（来源词书 + 本地导入词书）。
 * 结构：一个小的索引键（元数据/同步状态） + 每本书一个数据键，内容脚本只读取启用的书。
 *
 * 写入方约定：
 * - 来源词书：只由 background 写（同步、删词），扩展页面通过消息触发
 * - 本地词书：由扩展页面（options 导入/重命名/删除）直接写；background 的 sync 层合并远端时也会写
 * 所有读改写走 withStorageLock，避免并发覆盖。
 */

// ---------------- 来源词书 ----------------

export async function getSourceIndex(): Promise<SourceBookIndex> {
  const res = await browser.storage.local.get(STORAGE_KEYS.sourceBooks);
  const raw = res[STORAGE_KEYS.sourceBooks] as Partial<SourceBookIndex> | undefined;
  return { books: raw?.books ?? {}, providers: raw?.providers ?? {} };
}

/** 带锁更新来源词书索引，返回更新后的索引 */
export function updateSourceIndex(mutate: (index: SourceBookIndex) => void): Promise<SourceBookIndex> {
  return withStorageLock(STORAGE_KEYS.sourceBooks, async () => {
    const index = await getSourceIndex();
    mutate(index);
    await browser.storage.local.set({ [STORAGE_KEYS.sourceBooks]: index });
    return index;
  });
}

/** 合并更新单本来源词书状态（不存在则创建） */
export function patchSourceBookState(
  base: Pick<SourceBookState, 'id' | 'providerId' | 'remoteId' | 'name'>,
  patch: Partial<SourceBookState>,
): Promise<SourceBookIndex> {
  return updateSourceIndex((index) => {
    const prev: SourceBookState = index.books[base.id] ?? { ...base, status: 'never', lastSyncAt: 0, lastAttemptAt: 0, wordCount: 0 };
    index.books[base.id] = { ...prev, ...patch };
  });
}

export async function getSourceBook(id: BookId): Promise<SourceBookData | undefined> {
  const key = sourceBookKey(id);
  return (await browser.storage.local.get(key))[key] as SourceBookData | undefined;
}

export async function saveSourceBook(data: SourceBookData): Promise<void> {
  await browser.storage.local.set({ [sourceBookKey(data.id)]: data });
}

/** 删除来源词书的本地缓存与索引项（不影响远端） */
export async function removeSourceBook(id: BookId): Promise<void> {
  await updateSourceIndex((index) => void delete index.books[id]);
  await browser.storage.local.remove(sourceBookKey(id));
}

// ---------------- 本地导入词书 ----------------

export async function getLocalIndex(): Promise<LocalBookIndex> {
  const res = await browser.storage.local.get(STORAGE_KEYS.localBooks);
  const raw = res[STORAGE_KEYS.localBooks] as Partial<LocalBookIndex> | undefined;
  return { books: raw?.books ?? {}, removed: raw?.removed ?? {} };
}

export function updateLocalIndex(mutate: (index: LocalBookIndex) => void): Promise<LocalBookIndex> {
  return withStorageLock(STORAGE_KEYS.localBooks, async () => {
    const index = await getLocalIndex();
    mutate(index);
    await browser.storage.local.set({ [STORAGE_KEYS.localBooks]: index });
    return index;
  });
}

export async function getLocalBook(id: BookId): Promise<LocalBookData | undefined> {
  const key = localBookKey(id);
  return (await browser.storage.local.get(key))[key] as LocalBookData | undefined;
}

export function toWordMap(words: Iterable<UserWord>): UserWordMap {
  const map: UserWordMap = {};
  for (const w of words) map[w.word.toLowerCase()] = w;
  return map;
}

export interface SaveLocalBookInput {
  /** 覆盖导入时传已有 id；不传则新建 */
  id?: BookId;
  name: string;
  format: ImportFormat;
  fileName?: string;
  words: UserWord[];
}

/** 新建或覆盖导入本地词书（覆盖时保留 createdAt），返回元数据 */
export async function saveLocalBook(input: SaveLocalBookInput): Promise<LocalBookMeta> {
  const id = input.id ?? localBookId();
  const words = toWordMap(input.words);
  const now = Date.now();
  let meta!: LocalBookMeta;
  await updateLocalIndex((index) => {
    meta = {
      id,
      name: input.name,
      format: input.format,
      fileName: input.fileName,
      wordCount: Object.keys(words).length,
      createdAt: index.books[id]?.createdAt ?? now,
      updatedAt: now,
    };
    index.books[id] = meta;
    delete index.removed[id];
  });
  await browser.storage.local.set({ [localBookKey(id)]: { id, words } satisfies LocalBookData });
  return meta;
}

export async function renameLocalBook(id: BookId, name: string): Promise<void> {
  await updateLocalIndex((index) => {
    const meta = index.books[id];
    if (meta) index.books[id] = { ...meta, name, updatedAt: Date.now() };
  });
}

/** 删除本地词书：数据键删除，索引留墓碑（多设备同步不复活）；调用方负责从 settings.books.enabled 移除 */
export async function deleteLocalBook(id: BookId): Promise<void> {
  await updateLocalIndex((index) => {
    delete index.books[id];
    index.removed[id] = Date.now();
  });
  await browser.storage.local.remove(localBookKey(id));
}
