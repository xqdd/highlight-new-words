import type { CardStyle, MarkStyle } from '../theme/themes';

/**
 * 设置契约（存储于 chrome.storage.local 的 `settings` 键，单对象）。
 *
 * 大体积数据不放在 settings 中，另存独立键（见 core/storage/keys.ts）：
 * - `sourceBooks` + `srcBook:<id>`：来源（有道/欧路…）生词本
 * - `localBooks` + `localBook:<id>`：本地导入词书
 * - `knownWords`：熟词本
 *
 * 扩展字段规则：新增字段必须在 DEFAULT_SETTINGS 中给默认值；
 * 不兼容的结构调整需递增 SETTINGS_SCHEMA_VERSION 并在 migrate.ts 追加迁移步骤。
 */
export const SETTINGS_SCHEMA_VERSION = 3;

/** 词书 id：内置为 catalog id（如 cet4）；来源词书 `src:<provider>:<remoteId>`；本地导入 `local:<uuid>`（见 wordbook/ids.ts） */
export type BookId = string;

/**
 * v3 开发期（schemaVersion 2）的单一云端生词本 id，已废弃，仅迁移使用（见 migrate.ts 的 migrateSettingsV2）。
 */
export const LEGACY_CLOUD_BOOK_ID = 'cloud';

/** 单个来源（provider）的用户配置，按 provider id 存在 settings.sources 中 */
export interface SourceSettings {
  /** 启用该来源（关闭后不自动同步，UI 折叠） */
  enabled: boolean;
  /** 每天自动同步一次该来源下的全部生词本（旧 autoSync） */
  autoSync: boolean;
  /** 标记熟词时同步删除该来源生词本中原形相同的所有词形（默认关闭；provider 不支持删除时忽略） */
  deleteOnKnown: boolean;
  /** 可选 API token（如欧路 OpenAPI），仅本机保存，不参与 storage.sync */
  apiToken?: string;
}

/** 可经 storage.sync 跨设备同步的数据类别 */
export type SyncDataKind = 'settings' | 'knownWords' | 'localBooks';

/** storage.sync 同步开关（本机设置，本身不参与同步） */
export interface SyncSettings {
  enabled: boolean;
  include: Record<SyncDataKind, boolean>;
}

/** 行内翻译模式：关闭 / 单词后括注 / 单词上方注音式(ruby) */
export type InlineTranslationMode = 'off' | 'after' | 'ruby';

/** 扩展页面（popup/options）界面配色：auto 跟随系统 */
export type UiTheme = 'auto' | 'light' | 'dark';

/** 卡片触发方式：auto=桌面悬停+移动端点按 */
export type CardTrigger = 'auto' | 'hover' | 'click';

export interface BookStyleOverride {
  /** 为该词书单独指定主题 id；不填则用全局 themeId */
  themeId?: string;
  /** 在主题基础上覆盖部分高亮样式 */
  mark?: Partial<MarkStyle>;
}

export interface Settings {
  schemaVersion: number;
  /** 最近一次修改时间 ms（saveSettings 自动维护），多设备同步时按此做 LWW */
  updatedAt: number;
  /** 总开关（旧 toggle） */
  enabled: boolean;
  books: {
    /** 启用的词书 id，可组合；顺序即优先级（一个词命中多本书时第一本决定样式） */
    enabled: BookId[];
  };
  style: {
    /** 全局主题 id，见 BUILTIN_THEMES；'custom' 表示使用 custom 颜色 */
    themeId: string;
    /** 自定义颜色（旧 highlightBackground/highlightText/bubbleBackground/bubbleText 迁移至此） */
    custom: { mark: MarkStyle; card: CardStyle };
    /** 按词书覆盖样式 */
    perBook: Record<BookId, BookStyleOverride>;
  };
  inlineTranslation: {
    mode: InlineTranslationMode;
  };
  card: {
    trigger: CardTrigger;
  };
  tts: {
    /** 打开卡片时自动发音（旧 ttsToggle） */
    enabled: boolean;
    /** chrome.tts.speak 的选项子集（旧 ttsVoices，默认 {lang:'en'}） */
    voice: { voiceName?: string; lang?: string; extensionId?: string };
    rate: number;
  };
  /** 按来源 provider id 的配置；未知 provider 的项保留不动（便于新增来源） */
  sources: Record<string, SourceSettings>;
  /** storage.sync 跨设备同步 */
  sync: SyncSettings;
  /** 扩展页面界面偏好（options 分片新增；旧数据由 normalizeSettings 按默认值补齐） */
  ui: {
    theme: UiTheme;
  };
  sites: {
    /** 禁用高亮的站点 hostname 列表（精确匹配或后缀匹配，见 isSiteDisabled） */
    disabled: string[];
  };
}

export type { MarkStyle, CardStyle };
