import type { CardStyle, InlineTranslationMode, MarkStyle, TranslationStyle } from '../theme/themes';

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

/**
 * 词书角色：new=生词本（高亮其中的词）；known=熟词本（其中的词不高亮，优先于生词）。
 * 来源词书的默认角色由 provider 声明（如欧路“已掌握”为 known），用户可在 knownBooks.roles 中覆盖。
 */
export type BookRole = 'new' | 'known';

/** 本地熟词本（storage `knownWords`）在“写入/移除目标”配置中的虚拟 id，不是 registry 中的词书 */
export const LOCAL_KNOWN_BOOK_ID = 'known:local';
/** “加入生词本”默认写入的本地词书（首次加入时由 background 自动创建并启用，名称“我的生词本”） */
export const MY_WORDS_BOOK_ID = 'local:mine';

/** 熟词本（多来源）配置：本地熟词本始终生效；来源熟词本（role=known 的来源词书）按 enabled 取并集 */
export interface KnownBooksSettings {
  /** 启用的来源熟词本 id（src:…）；首次同步成功的 known 角色书由 background 自动加入 */
  enabled: BookId[];
  /** 用户为来源词书指定的角色，覆盖 provider 声明（如把欧路某个自建分组当作熟词本） */
  roles: Record<BookId, BookRole>;
}

/**
 * 单词操作（卡片“加入生词本 / 认识”）的目标配置。目标 id 可以是本地词书 `local:…`、来源词书 `src:…`
 * 或本地熟词本 LOCAL_KNOWN_BOOK_ID；来源词书需要 provider 支持对应能力（canAdd / delete），不支持的目标被跳过并在结果中说明。
 */
export interface WordActionSettings {
  /**
   * 同原形处理：移除操作（加入生词本时移出熟词本、标记熟词时移出生词本）是否处理原形相同的所有屈折词形
   * （run/runs/ran/running；不含 runner、careful 这类派生词）。关闭时只处理当前词形与其原形本身。
   */
  sameLemma: boolean;
  /** “加入生词本”写入的生词本（本地或来源，可多选）；来源词书调用 provider.addWords 同步写入远端 */
  addTargets: BookId[];
  /** “加入生词本”时同时从这些熟词本移除该词（本地熟词本 / 来源熟词本） */
  addRemoveFromKnown: BookId[];
  /** “认识”（标记熟词）写入的熟词本：本地熟词本和/或支持写入的来源熟词本（欧路“已掌握”只读，不能作为目标） */
  knownTargets: BookId[];
  /**
   * “认识”时从这些生词本移除该词（本地或来源）。'auto' = 沿用旧开关：各来源 `deleteOnKnown` 开启时，移除该来源全部生词本中的该词。
   */
  knownRemoveFrom: BookId[] | 'auto';
}

/** 可经 storage.sync 跨设备同步的数据类别 */
export type SyncDataKind = 'settings' | 'knownWords' | 'localBooks';

/**
 * WebDAV 同步后端配置（本机设置，在 settings.sync 中，不进入任何同步数据；
 * 只有用户勾选 credentialSync.webdav 时，连接信息才作为凭据随 chrome.storage.sync 上传，见 core/sync/credentials.ts）。
 * 文件位置：`<url>/<dir>/hnw-sync.json`。
 */
export interface WebDavSettings {
  enabled: boolean;
  /** 服务器地址，如坚果云 `https://dav.jianguoyun.com/dav/`、Nextcloud `https://host/remote.php/dav/files/<user>/` */
  url: string;
  username: string;
  /** 密码或应用密码（坚果云需在“安全选项”生成应用密码） */
  password: string;
  /** 远端目录（相对 url，可多级，不存在时自动 MKCOL 创建） */
  dir: string;
  /** 同步的数据类别；sourceBooks=来源词书缓存（storage.sync 不同步，WebDAV 可选） */
  include: Record<SyncDataKind, boolean> & { sourceBooks: boolean };
  /** 自动同步：本机数据变化后防抖同步、启动时同步、定时同步（分钟，0=关闭；SW 唤醒时检查是否到期） */
  autoSync: { onChange: boolean; onStartup: boolean; intervalMinutes: number };
}

/**
 * 同步设置（本机设置，本身不参与同步）。
 * enabled/include 为 chrome.storage.sync 后端（向后兼容的字段名）；webdav 为 WebDAV 后端（background 第 3 轮新增）。
 * 手动备份导入导出没有持久配置，走 background 消息 exportBackup / importBackup。
 */
export interface SyncSettings {
  enabled: boolean;
  include: Record<SyncDataKind, boolean>;
  webdav: WebDavSettings;
}

/**
 * 可随同步上传的凭据 id：`token:<providerId>`（来源 API token，如欧路 OpenAPI token）、`webdav`（WebDAV 连接信息含密码）。
 * 清单与说明见 core/sync/credentials.ts 的 listSyncCredentials。
 */
export type CredentialId = string;

/**
 * 代码块中标注生词（v8，engine 第二阶段新增，默认关闭）。
 * 作用于 pre、code（含行内 code）与常见语法高亮容器；在线编辑器（Monaco/CodeMirror/Ace 等）与可编辑区始终跳过。
 * 代码中永远不插入占位的行内译文（词后括注/ruby），标识符按 camelCase/snake_case 等拆词后匹配。
 */
export interface CodeBlockSettings {
  enabled: boolean;
  /** 范围：comments=只处理注释和字符串（按语法高亮类名识别，识别不了的代码不处理；行内 code 不处理）；all=全部代码文本 */
  scope: 'comments' | 'all';
  /** 代码中的译文：hover=不显示，仅悬停/点按看卡片；float=单词上方浮动小标注（绝对定位，不占位） */
  display: 'hover' | 'float';
}

/**
 * YouTube 字幕（v9，floatball 模块负责）：只作用于主播放器 #movie_player 内的字幕，控件文字、章节标题、自动字幕提示不标注。
 * 旧数据由 normalizeSettings 按默认值补齐。
 */
export interface YouTubeSettings {
  /** 字幕中标注生词（默认开）；关闭后字幕保持原样，页面其他文字照常标注 */
  captions: boolean;
  /**
   * 悬停字幕自动暂停（仅桌面鼠标，默认关，由用户自行开启）：鼠标进入字幕即暂停，离开字幕与卡片 300ms 后继续；
   * 只恢复由扩展发起的暂停。手机端改用悬浮球打开“当前字幕面板”（见 FloatBallSettings）
   */
  hoverPause: boolean;
  /**
   * 字幕内生词译文：above=单词上方小注解（默认，字幕窗向上长高，不改变宽度）；below=单词下方小注解（同 above 对称）；after=词后小字（字幕行不折行、居中，
   * 放不下时该条字幕自动改用上方注解）；off=只高亮。自动生成字幕（逐词滚动、窗口高度固定）始终只高亮
   */
  captionTranslation: 'off' | 'above' | 'below' | 'after';
}

/**
 * 通用悬浮球（v10，floatball 模块新增）：只在触屏/手机端显示（(hover: none) and (pointer: coarse)），PC 端不显示。
 * 点按展开底部抽屉（取词模式、本页生词、快捷设置、同步状态、完整设置）；YouTube 视频页点按直接打开“当前字幕面板”。
 * 位置按设备记在 storage.local `floatBallPos`，不参与同步
 */
export interface FloatBallSettings {
  /** 全局开关（默认开） */
  enabled: boolean;
  /** 隐藏悬浮球的站点（规则同 sites.disabled：含子域名） */
  hiddenSites: string[];
}

/**
 * 加载性能相关选项（engine 第 3 轮新增；旧设置由 normalizeSettings 按默认值补齐）。
 */
export interface PerformanceSettings {
  /**
   * 加载时先隐藏页面，避免首屏译文插入造成跳动（默认关）：开启后由 background 动态注册 document_start 的隐藏样式，
   * 首屏标注与译文写完（或 600ms 兜底）后显示。代价是首次绘制推迟，见 content/engine/prehide.ts
   */
  prehide: boolean;
}

/** 扩展页面（popup/options）界面配色：auto 跟随系统 */
export type UiTheme = 'auto' | 'light' | 'dark';

/**
 * 卡片触发方式（只影响 PC 端鼠标；触屏/手机端始终点按，见 card/trigger.ts）：
 * - `auto` / `hover`：悬停（默认；`auto` 为旧默认值，与 `hover` 行为相同）
 * - `modifier`：按住 `card.modifier` 指定的修饰键 + 悬停（v11 card 新增；旧版本收到该值时按悬停处理）
 * - `click`：点击；链接中的单词第一次点击弹卡，再点一次或带修饰键点击才跳转
 */
export type CardTrigger = 'auto' | 'hover' | 'click' | 'modifier';

/**
 * 卡片修饰键（v11 card 新增）：alt=Alt/⌥、ctrl=Ctrl/⌃、shift=Shift/⇧、meta=⌘（只在 macOS 提供；
 * 其他系统收到 meta 时按 Ctrl 处理，见 card/trigger-config.ts `effectiveModifier`）
 */
export type CardModifierKey = 'alt' | 'ctrl' | 'shift' | 'meta';

/**
 * PC 端悬停弹卡延迟（ms，card 修复轮新增）：指针在单词上停留满该时长才弹卡，防止扫过段落时误触。
 * 100 灵敏 / 250 标准（默认）/ 400 稳妥；悬停与“修饰键 + 悬停”移入单词时生效，指针已在单词上再按修饰键的延迟不受影响
 */
export type CardHoverDelay = 100 | 250 | 400;
/** 可选的悬停弹卡延迟档位（options 设置 UI 与 normalizeSettings 校验共用） */
export const CARD_HOVER_DELAYS: readonly CardHoverDelay[] = [100, 250, 400];

/** 用户另存的样式（Settings.style.saved 的一项） */
export interface SavedMarkStyle {
  id: string;
  name: string;
  mark: MarkStyle;
}

export interface BookStyleOverride {
  /** 为该词书单独指定主题 id；不填则用全局 themeId */
  themeId?: string;
  /** 在主题基础上覆盖部分高亮样式 */
  mark?: Partial<MarkStyle>;
}

/** 发音来源，见 Settings.tts.source */
export type TtsSource = 'system' | 'youdao-us' | 'youdao-uk' | 'eudic-us' | 'eudic-uk';

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
    /**
     * 用户另存的样式（options 第二阶段新增，可选）：在预设或自定义基础上微调后“另存为”，出现在预设画廊“我的样式”中。
     * 只是样式库：选用时把 mark 复制到 custom（全局）或 perBook（词书），渲染不读取本字段。
     */
    saved?: SavedMarkStyle[];
  };
  /** 行内译文：模式 + 样式（v5 新增 blur/color/opacity/fontScale，可选，见 TranslationStyle） */
  inlineTranslation: {
    mode: InlineTranslationMode;
    /** 同一段落里重复出现的词只在第一次显示译文；缺省视为开启（旧设置没有此字段） */
    oncePerParagraph?: boolean;
  } & TranslationStyle;
  /** 代码块中标注生词（v8，engine 新增） */
  code: CodeBlockSettings;
  /** YouTube 字幕标注、字幕内译文与悬停暂停（v9，floatball 模块负责） */
  youtube: YouTubeSettings;
  /** 通用悬浮球（v10，floatball 模块新增） */
  floatBall: FloatBallSettings;
  card: {
    trigger: CardTrigger;
    /** trigger='modifier' 时按住的修饰键（v11 card 新增，默认 alt；旧设置由 normalizeSettings 补齐） */
    modifier: CardModifierKey;
    /** 悬停弹卡延迟 ms（card 修复轮新增，默认 250；旧设置由 normalizeSettings 补齐，非法值按 250） */
    hoverDelay: CardHoverDelay;
    /** 卡片上显示生词本自带的释义（与词典不同时另起一行）；缺省视为开启（旧设置没有此字段） */
    showUserTrans?: boolean;
    /** 手机、平板上点按生词打开卡片；关闭后点按照常交给页面（链接跳转），仍可用悬浮球取词查词。缺省视为开启 */
    tapOpen?: boolean;
  };
  tts: {
    /** 打开卡片时自动发音（旧 ttsToggle） */
    enabled: boolean;
    /** chrome.tts.speak 的选项子集（旧 ttsVoices，默认 {lang:'en'}） */
    voice: { voiceName?: string; lang?: string; extensionId?: string };
    rate: number;
    /**
     * 发音来源：system 浏览器/系统语音（默认）；youdao-* / eudic-* 有道、欧路真人发音（美音/英音，需联网，
     * 朗读的单词会发给对应词典；失败时自动退回系统语音）。缺省视为 system
     */
    source?: TtsSource;
  };
  /** 按来源 provider id 的配置；未知 provider 的项保留不动（便于新增来源） */
  sources: Record<string, SourceSettings>;
  /** 熟词本多来源（background 分片新增，旧数据由 normalizeSettings 按默认值补齐） */
  knownBooks: KnownBooksSettings;
  /** 加入生词本 / 标记熟词的写入与移除目标（background 分片新增） */
  wordActions: WordActionSettings;
  /** 跨设备同步（本机设置，不参与同步） */
  sync: SyncSettings;
  /**
   * 凭据是否随同步上传（默认全部不上传）。本字段本身参与同步，所以各设备的选择一致；
   * 同步后端自身的凭据不会写进它自己的数据（WebDAV 密码只可能随 chrome.storage.sync 或手动备份上传）。
   */
  credentialSync: Record<CredentialId, boolean>;
  /** 加载性能选项（engine 第 3 轮新增）：首屏预隐藏开关 */
  performance: PerformanceSettings;
  /** 扩展页面界面偏好（options 分片新增；旧数据由 normalizeSettings 按默认值补齐） */
  ui: {
    theme: UiTheme;
  };
  sites: {
    /** 禁用高亮的站点 hostname 列表（精确匹配或后缀匹配，见 isSiteDisabled） */
    disabled: string[];
  };
}

export type { MarkStyle, CardStyle, InlineTranslationMode, TranslationStyle };
