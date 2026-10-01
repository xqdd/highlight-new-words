import { CARD_HOVER_DELAYS, LEGACY_CLOUD_BOOK_ID, SETTINGS_SCHEMA_VERSION, type Settings } from './schema';
import { createDefaultSettings, createDefaultSourceSettings } from './defaults';
import { CUSTOM_THEME_ID } from '../theme/themes';
import { EUDIC_PROVIDER_ID, LEGACY_REMOTE_BOOK_ID, YOUDAO_PROVIDER_ID } from '../source/providers';
import { localBookId, sourceBookId } from '../wordbook/ids';
import type { LocalBookMeta, SourceBookState, UserWord, UserWordMap } from '../wordbook/types';

/** 旧版 chrome.storage.local 内容（v2.x jQuery 版） */
export interface LegacyStorage {
  toggle?: boolean;
  ttsToggle?: boolean;
  ttsVoices?: { voiceName?: string; lang?: string; extensionId?: string; [k: string]: unknown };
  highlightBackground?: string;
  highlightText?: string;
  bubbleBackground?: string;
  bubbleText?: string;
  /** 生词本类型，0有道,1欧路 */
  dictionaryType?: number | string;
  autoSync?: boolean;
  cookie?: string | false | null;
  syncTime?: number;
  newWords?: { wordInfos?: Record<string, LegacyWordInfo> };
}

/** 旧版 wordInfos 值：有道为接口原始条目，欧路为 {phonetic, trans, word, link}，XML 导入为 {word, trans, phonetic} */
export interface LegacyWordInfo {
  word?: string;
  phonetic?: string;
  trans?: string;
  itemId?: string | number;
  link?: string;
  [k: string]: unknown;
}

/** 迁移产出的来源词书（索引项 + 数据） */
export interface MigratedSourceBook {
  state: SourceBookState;
  words: UserWordMap;
}

/** 迁移产出的本地词书（v3 开发期 XML 导入的 cloudBook） */
export interface MigratedLocalBook {
  meta: LocalBookMeta;
  words: UserWordMap;
}

export interface MigrationResult {
  settings: Settings;
  /** 旧版有生词数据时生成；否则 undefined */
  sourceBook?: MigratedSourceBook;
  localBook?: MigratedLocalBook;
}

/** 构造迁移来的来源词书（status=ok，lastSyncAt 沿用旧同步时间） */
function makeSourceBook(providerId: string, words: UserWordMap, syncTime: number): MigratedSourceBook {
  const remoteId = LEGACY_REMOTE_BOOK_ID[providerId] ?? 'default';
  const count = Object.keys(words).length;
  return {
    state: {
      id: sourceBookId(providerId, remoteId),
      providerId,
      remoteId,
      name: providerId === EUDIC_PROVIDER_ID ? '全部生词' : '单词本',
      status: count > 0 ? 'ok' : 'empty',
      lastSyncAt: syncTime,
      lastAttemptAt: syncTime,
      wordCount: count,
    },
    words,
  };
}

/** 只启用一个来源（旧版单选 dictionaryType / cloud.provider） */
function enableOnlySource(settings: Settings, providerId: string, autoSync: boolean): void {
  for (const id of Object.keys(settings.sources)) settings.sources[id]!.enabled = false;
  settings.sources[providerId] = { ...(settings.sources[providerId] ?? createDefaultSourceSettings()), enabled: true, autoSync };
}

/** 是否存在旧版数据（以 ttsVoices / newWords / toggle 任一存在为准，旧版 initSettings 必写 ttsVoices） */
export function hasLegacyData(legacy: LegacyStorage): boolean {
  return legacy.ttsVoices !== undefined || legacy.newWords !== undefined || legacy.toggle !== undefined;
}

const LEGACY_DEFAULT_HIGHLIGHT_BG = '#FFFF0010';
const LEGACY_DEFAULT_BUBBLE_BG = '#FFE4C4';

/**
 * 旧版（v2.x）存储 -> 新结构（纯函数，便于单测）。
 * - 旧用户只用云端生词本：迁移为对应来源（dictionaryType 0=有道 1=欧路）的一本来源词书，且只启用这本，保持原有高亮行为
 * - 旧 cookie 键仅为记录用途（请求由浏览器自动携带 cookie），不再迁移
 * - 旧用户改过颜色则主题切为 custom，否则使用新默认主题
 */
export function migrateLegacy(legacy: LegacyStorage): MigrationResult {
  const settings = createDefaultSettings();
  if (typeof legacy.toggle === 'boolean') settings.enabled = legacy.toggle;
  if (typeof legacy.ttsToggle === 'boolean') settings.tts.enabled = legacy.ttsToggle;
  if (legacy.ttsVoices && typeof legacy.ttsVoices === 'object') {
    const { voiceName, lang, extensionId } = legacy.ttsVoices;
    settings.tts.voice = { voiceName, lang, extensionId };
  }
  const provider = Number(legacy.dictionaryType) === 1 ? EUDIC_PROVIDER_ID : YOUDAO_PROVIDER_ID;
  enableOnlySource(settings, provider, typeof legacy.autoSync === 'boolean' ? legacy.autoSync : true);
  const syncTime = typeof legacy.syncTime === 'number' ? legacy.syncTime : 0;

  // 颜色：旧版文字色为空串表示继承
  const custom = settings.style.custom;
  if (legacy.highlightBackground !== undefined) custom.mark.background = legacy.highlightBackground;
  if (legacy.highlightText !== undefined) custom.mark.color = legacy.highlightText.trim();
  if (legacy.bubbleBackground !== undefined) custom.card.background = legacy.bubbleBackground;
  if (legacy.bubbleText !== undefined) custom.card.color = legacy.bubbleText.trim();
  const colorCustomized =
    (legacy.highlightBackground !== undefined && legacy.highlightBackground !== LEGACY_DEFAULT_HIGHLIGHT_BG) ||
    (legacy.bubbleBackground !== undefined && legacy.bubbleBackground !== LEGACY_DEFAULT_BUBBLE_BG) ||
    !!legacy.highlightText?.trim() ||
    !!legacy.bubbleText?.trim();
  if (colorCustomized) settings.style.themeId = CUSTOM_THEME_ID;

  // 来源词书总是创建（即使旧版无生词），保证 books.enabled 中的 id 有对应索引，用户点同步即可拉取
  const words: UserWordMap = {};
  for (const [key, info] of Object.entries(legacy.newWords?.wordInfos ?? {})) {
    words[key.toLowerCase()] = normalizeLegacyWord(key, info, provider);
  }
  const sourceBook = makeSourceBook(provider, words, syncTime);
  settings.books.enabled = [sourceBook.state.id];
  settings.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return { settings, sourceBook };
}

/**
 * 旧版词条 -> UserWord。
 * 欧路旧版存 {word: uuid(即单词), link: 远端单词原文}，删除接口使用远端单词原文；有道删除使用 itemId。
 */
function normalizeLegacyWord(key: string, info: LegacyWordInfo, provider: string): UserWord {
  const word: UserWord = { word: typeof info.word === 'string' && info.word ? info.word : key };
  if (info.phonetic) word.phonetic = String(info.phonetic);
  if (info.trans) word.trans = String(info.trans);
  if (provider === YOUDAO_PROVIDER_ID && info.itemId !== undefined && info.itemId !== null) word.ref = String(info.itemId);
  if (provider === EUDIC_PROVIDER_ID) word.ref = word.word;
  return word;
}

/** v3 开发期 settings（schemaVersion 2）中的单一云端生词本配置 */
interface DevV2Settings {
  schemaVersion?: number;
  cloud?: { provider?: string; autoSync?: boolean; syncTime?: number };
  books?: { enabled?: string[] };
  [k: string]: unknown;
}

/** v3 开发期 cloudBook 键结构 */
export interface DevV2CloudBook {
  provider: 'youdao' | 'eudic' | 'xml';
  words: Record<string, { word: string; phonetic?: string; trans?: string; itemId?: string; display?: string }>;
  updatedAt: number;
}

/**
 * v3 开发期（schemaVersion 2，未发布）-> schemaVersion 3：
 * - settings.cloud -> settings.sources[provider]（只启用该来源）
 * - cloudBook（provider=youdao/eudic）-> 对应来源词书；provider=xml（手动导入）-> 本地导入词书
 * - books.enabled 中的 'cloud' 替换为新词书 id（位置不变，保持优先级）
 */
export function migrateSettingsV2(raw: DevV2Settings, cloudBook: DevV2CloudBook | undefined): MigrationResult {
  const { cloud, ...rest } = raw;
  const settings = normalizeSettings(rest);
  const provider = cloud?.provider === EUDIC_PROVIDER_ID ? EUDIC_PROVIDER_ID : YOUDAO_PROVIDER_ID;
  enableOnlySource(settings, provider, cloud?.autoSync ?? true);
  const result: MigrationResult = { settings };
  let replacement: string | undefined;
  if (cloudBook?.provider === 'xml') {
    const id = localBookId();
    const words: UserWordMap = {};
    for (const [k, w] of Object.entries(cloudBook.words)) words[k] = { word: w.word, phonetic: w.phonetic, trans: w.trans };
    result.localBook = {
      meta: { id, name: '导入的生词本', format: 'youdao-xml', wordCount: Object.keys(words).length, createdAt: cloudBook.updatedAt, updatedAt: cloudBook.updatedAt },
      words,
    };
    replacement = id;
  } else {
    const p = cloudBook?.provider ?? provider;
    const words: UserWordMap = {};
    for (const [k, w] of Object.entries(cloudBook?.words ?? {})) {
      words[k] = { word: w.word, phonetic: w.phonetic, trans: w.trans, ref: p === YOUDAO_PROVIDER_ID ? w.itemId : (w.display ?? w.word) };
    }
    result.sourceBook = makeSourceBook(p, words, cloud?.syncTime ?? cloudBook?.updatedAt ?? 0);
    replacement = result.sourceBook.state.id;
  }
  settings.books.enabled = settings.books.enabled.flatMap((id) => (id === LEGACY_CLOUD_BOOK_ID ? [replacement] : [id]));
  return result;
}

/**
 * 把存储中读出的（可能缺字段/旧版本的）settings 补齐为完整 Settings。
 * 以默认值为底做深合并，数组整体替换。未来 schemaVersion 升级在此追加分支。
 */
export function normalizeSettings(raw: unknown): Settings {
  const defaults = createDefaultSettings();
  if (!raw || typeof raw !== 'object') return defaults;
  const merged = deepMerge(defaults, raw as Record<string, unknown>) as Settings;
  merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
  // 悬停弹卡延迟只允许固定档位：被写坏或来自未来版本的值按默认处理（缺省时 deepMerge 已补齐）
  if (!CARD_HOVER_DELAYS.includes(merged.card.hoverDelay)) merged.card.hoverDelay = defaults.card.hoverDelay;
  return merged;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：以 base 为结构，override 中同类型值覆盖；perBook 这类自由 key 的对象也会保留 override 的额外 key */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    if (override === undefined) return base;
    if (Array.isArray(base)) return (Array.isArray(override) ? override : base) as T;
    // base 是对象而 override 不是对象（被写坏）时保留默认结构；其余原始值直接覆盖（如 cookie: false -> 'a=b'）
    if (isPlainObject(base)) return base;
    return override as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}
