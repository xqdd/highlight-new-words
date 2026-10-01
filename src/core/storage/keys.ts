import type { BookId } from '../settings/schema';

/**
 * chrome.storage.local 顶层键约定（所有模块共享，新增键在此登记）。
 * 大数据按“索引键 + 每本书一个数据键”拆分，避免单个大对象整体读写。
 */
export const STORAGE_KEYS = {
  /** Settings 对象，见 core/settings/schema.ts */
  settings: 'settings',
  /** 熟词本：KnownWordsData（词 -> 加入时间 + 删除墓碑），见 core/known/types.ts */
  knownWords: 'knownWords',
  /** 来源词书索引：SourceBookIndex（各书同步元数据），见 core/wordbook/types.ts */
  sourceBooks: 'sourceBooks',
  /** 本地导入词书索引：LocalBookIndex（名称/格式/词数 + 删除墓碑） */
  localBooks: 'localBooks',
  /** storage.sync 同步状态：SyncStatus（用量/错误/时间），见 core/sync/types.ts；仅 background 写 */
  syncState: 'syncState',
} as const;

/** 单本来源词书数据键前缀：`srcBook:<bookId>` -> SourceBookData */
export const SOURCE_BOOK_KEY_PREFIX = 'srcBook:';
/** 单本本地词书数据键前缀：`localBook:<bookId>` -> LocalBookData */
export const LOCAL_BOOK_KEY_PREFIX = 'localBook:';

export function sourceBookKey(id: BookId): string {
  return SOURCE_BOOK_KEY_PREFIX + id;
}
export function localBookKey(id: BookId): string {
  return LOCAL_BOOK_KEY_PREFIX + id;
}

/**
 * v3 开发期（未发布）使用过的键，仅迁移使用：
 * - `cloudBook`：单一云端生词本 { provider: 'youdao'|'eudic'|'xml', words, updatedAt }
 */
export const DEV_LEGACY_KEYS = { cloudBook: 'cloudBook' } as const;

/** chrome.storage.session 键：各标签页已高亮的不同单词，用于徽章计数（SW 重启后可恢复） */
export const SESSION_KEYS = {
  tabWords: 'tabWords',
  /** 标记熟词时 deleteOnKnown 删除的来源词条（lemma -> 记录），供 10 分钟内撤销时加回，见 background/known.ts */
  knownUndo: 'knownUndo',
} as const;

/**
 * 旧版（v2.x，jQuery 版）使用的 chrome.storage.local 键，仅供迁移使用。
 */
export const LEGACY_KEYS = [
  'toggle',
  'ttsToggle',
  'ttsVoices',
  'highlightBackground',
  'highlightText',
  'bubbleBackground',
  'bubbleText',
  'dictionaryType',
  'autoSync',
  'cookie',
  'syncTime',
  'newWords',
] as const;
