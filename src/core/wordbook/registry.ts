import { MY_WORDS_BOOK_ID, type BookId } from '../settings/schema';
import { fetchPackagedJson } from '../dict/packaged';
import { getProviderInfo } from '../source/providers';
import { parseBookId } from './ids';
import type {
  BookCatalog,
  BookDataFile,
  BookMeta,
  CatalogBookMeta,
  LocalBookData,
  LocalBookIndex,
  LocalBookMeta,
  SourceBookData,
  SourceBookIndex,
  SourceBookState,
  WordBook,
  WordBookRegistry,
} from './types';
import { createUserWordBook } from './user-book';
import { getLocalBook, getLocalIndex, getSourceBook, getSourceIndex } from './user-store';

/** 注册表数据加载器：抽象出来便于单测注入内存数据 */
export interface RegistryLoaders {
  catalog(): Promise<BookCatalog>;
  book(id: BookId): Promise<BookDataFile>;
  sourceIndex(): Promise<SourceBookIndex>;
  sourceBook(id: BookId): Promise<SourceBookData | undefined>;
  localIndex(): Promise<LocalBookIndex>;
  localBook(id: BookId): Promise<LocalBookData | undefined>;
}

/** 由 Set 构造 WordBook */
export function createSetWordBook(meta: BookMeta, words: Iterable<string>): WordBook {
  const set = new Set<string>();
  for (const w of words) set.add(w.toLowerCase());
  return { meta: { ...meta, size: set.size }, has: (w) => set.has(w), size: set.size, words: () => set };
}

/** 来源词书元数据：名称为“来源名 · 远端生词本名” */
export function sourceBookMeta(state: SourceBookState): BookMeta {
  const provider = getProviderInfo(state.providerId)?.name ?? state.providerId;
  return {
    id: state.id,
    kind: 'source',
    name: `${provider} · ${state.name}`,
    nameEn: state.name,
    // 短标签（popup 本页生词的来源标签）：名称太长时用来源名（“欧路”），不用泛称“生词本”，避免与本地“我的生词本”混淆
    short: state.name.length <= 4 ? state.name : provider.replace(/词典$/, ''),
    category: 'user',
    level: 0,
    size: state.wordCount,
    source: provider,
    providerId: state.providerId,
    remoteId: state.remoteId,
    sync: state,
    updatedAt: state.lastSyncAt || undefined,
  };
}

/** 本地导入词书元数据 */
export function localBookMeta(meta: LocalBookMeta): BookMeta {
  return {
    id: meta.id,
    kind: 'local',
    name: meta.name,
    nameEn: meta.name,
    // “我的生词本”是卡片加词时自动创建的，不是导入的，短标签用“本地”
    short: meta.id === MY_WORDS_BOOK_ID ? '本地' : meta.name.length <= 4 ? meta.name : '导入',
    category: 'user',
    level: 1,
    size: meta.wordCount,
    source: meta.fileName ? `导入自 ${meta.fileName}` : '手动导入',
    importFormat: meta.format,
    updatedAt: meta.updatedAt,
  };
}

function builtinMeta(meta: CatalogBookMeta): BookMeta {
  return { ...meta, kind: 'builtin' };
}

/**
 * 默认词书注册表：统一管理三类词书（id 规则见 ids.ts）。
 * - 内置：扩展包 data/books/ 懒加载（每本书一个文件）
 * - 来源 / 本地导入：storage 索引 + 每本书一个数据键
 * 加载结果按 id 缓存；用户词书数据变化后调用方新建 registry（内容脚本在 storage 变化时整体重建）。
 */
export class DefaultWordBookRegistry implements WordBookRegistry {
  private catalogPromise?: Promise<BookCatalog>;
  private cache = new Map<BookId, Promise<WordBook | undefined>>();
  /** 内置词书数据文件缓存：同时启用 B2 与 C1 时，被 extends 共享的 cefr-c2 等文件只加载一次 */
  private bookFiles = new Map<BookId, Promise<BookDataFile>>();

  constructor(private readonly loaders: RegistryLoaders) {}

  private catalog(): Promise<BookCatalog> {
    this.catalogPromise ??= this.loaders.catalog().catch((e) => {
      console.warn('[hnw] 词书目录加载失败', e);
      return { version: 0, books: [] };
    });
    return this.catalogPromise;
  }

  async list(): Promise<BookMeta[]> {
    const [catalog, sources, locals] = await Promise.all([this.catalog(), this.loaders.sourceIndex(), this.loaders.localIndex()]);
    return [
      ...Object.values(sources.books).map(sourceBookMeta),
      ...Object.values(locals.books)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(localBookMeta),
      ...catalog.books.map(builtinMeta),
    ];
  }

  load(id: BookId): Promise<WordBook | undefined> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.loadUncached(id).catch((e) => {
        console.warn('[hnw] 词书加载失败', id, e);
        return undefined;
      });
      this.cache.set(id, p);
    }
    return p;
  }

  private async loadUncached(id: BookId): Promise<WordBook | undefined> {
    const parsed = parseBookId(id);
    if (parsed.kind === 'source') {
      const [index, data] = await Promise.all([this.loaders.sourceIndex(), this.loaders.sourceBook(id)]);
      const state = index.books[id];
      return state && data ? createUserWordBook(sourceBookMeta(state), data.words) : undefined;
    }
    if (parsed.kind === 'local') {
      const [index, data] = await Promise.all([this.loaders.localIndex(), this.loaders.localBook(id)]);
      const meta = index.books[id];
      return meta && data ? createUserWordBook(localBookMeta(meta), data.words) : undefined;
    }
    const meta = (await this.catalog()).books.find((b) => b.id === id);
    if (!meta) return undefined;
    return createSetWordBook(builtinMeta(meta), await this.builtinWords(id, new Set()));
  }

  /**
   * 内置词书的全部词：本文件 words + 递归合并 extends 指向的词书文件（级别/词频书是包含关系，只存差集）。
   * extends 指向的书即使不在 catalog 中也按文件加载；visiting 防止数据错误导致的循环引用。
   */
  private async builtinWords(id: BookId, visiting: Set<BookId>): Promise<string[]> {
    if (visiting.has(id)) return [];
    visiting.add(id);
    let file = this.bookFiles.get(id);
    if (!file) {
      file = this.loaders.book(id);
      this.bookFiles.set(id, file);
    }
    const data = await file;
    if (!data.extends?.length) return data.words;
    const parents = await Promise.all(data.extends.map((p) => this.builtinWords(p, visiting)));
    return [...data.words, ...parents.flat()];
  }
}

/** 扩展运行时使用的 loaders（任意上下文可用：内置词书 fetch 扩展包，用户词书读 storage.local） */
export function createExtensionLoaders(): RegistryLoaders {
  return {
    catalog: () => fetchPackagedJson<BookCatalog>('data/books/index.json'),
    book: (id) => fetchPackagedJson<BookDataFile>(`data/books/${id}.json`),
    sourceIndex: getSourceIndex,
    sourceBook: getSourceBook,
    localIndex: getLocalIndex,
    localBook: getLocalBook,
  };
}
