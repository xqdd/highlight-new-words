import { DEFAULT_THEME_ID } from '../theme/themes';
import { EUDIC_PROVIDER_ID, YOUDAO_PROVIDER_ID } from '../source/providers';
import { LOCAL_KNOWN_BOOK_ID, MY_WORDS_BOOK_ID, SETTINGS_SCHEMA_VERSION, type Settings, type SourceSettings, type WordActionSettings } from './schema';

/**
 * 新安装用户的默认词书：六级（data 分片确定最终 id 后可调整）。
 * 来源词书在首次同步成功时由 background 自动加入启用列表（见 background/sources/service.ts）。
 */
export const DEFAULT_ENABLED_BOOKS = ['cet6'];

/** 新来源的默认配置：不自动删除远端单词 */
export function createDefaultSourceSettings(enabled = false): SourceSettings {
  return { enabled, autoSync: true, deleteOnKnown: false };
}

/** 单词操作默认配置：加入“我的生词本”并移出本地熟词本；认识时写本地熟词本，移除目标沿用各来源 deleteOnKnown 开关 */
export function createDefaultWordActions(): WordActionSettings {
  return {
    sameLemma: true,
    addTargets: [MY_WORDS_BOOK_ID],
    addRemoveFromKnown: [LOCAL_KNOWN_BOOK_ID],
    knownTargets: [LOCAL_KNOWN_BOOK_ID],
    knownRemoveFrom: 'auto',
  };
}

/**
 * 默认设置。返回新对象，调用方可放心修改。
 * 旧版默认值：高亮背景 #FFFF0010、气泡背景 #FFE4C4、ttsVoices {lang:'en'}、autoSync true。
 */
export function createDefaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    updatedAt: 0,
    enabled: true,
    books: { enabled: [...DEFAULT_ENABLED_BOOKS] },
    style: {
      themeId: DEFAULT_THEME_ID,
      custom: {
        mark: { background: '#FFFF0010', color: '', underline: 'none', underlineColor: '' },
        card: { background: '#FFE4C4', color: '', accent: '#b45309' },
      },
      perBook: {},
    },
    inlineTranslation: { mode: 'off', blur: false, color: '' },
    code: { enabled: false, scope: 'comments', display: 'hover' },
    youtube: { captions: true, hoverPause: false, captionTranslation: 'above' },
    floatBall: { enabled: true, hiddenSites: [] },
    card: { trigger: 'auto', modifier: 'alt', hoverDelay: 250 },
    tts: { enabled: true, voice: { lang: 'en' }, rate: 1 },
    // 云端来源默认全部关闭：新用户安装后不向任何第三方（有道、欧路）发请求，由用户在选项页主动连接（开启即同步一次）；
    // 旧版用过云端生词本的用户由 migrateLegacy 按旧数据启用对应来源，不受此默认值影响
    sources: {
      [YOUDAO_PROVIDER_ID]: createDefaultSourceSettings(false),
      [EUDIC_PROVIDER_ID]: createDefaultSourceSettings(false),
    },
    knownBooks: { enabled: [], roles: {} },
    wordActions: createDefaultWordActions(),
    sync: {
      enabled: true,
      include: { settings: true, knownWords: true, localBooks: true },
      webdav: {
        enabled: false,
        url: '',
        username: '',
        password: '',
        dir: 'highlight-new-words',
        include: { settings: true, knownWords: true, localBooks: true, sourceBooks: false },
        autoSync: { onChange: true, onStartup: true, intervalMinutes: 60 },
      },
    },
    credentialSync: {},
    ui: { theme: 'auto' },
    // 首屏预隐藏默认关：隐藏会推迟首次绘制（维基桌面约 +300ms），由用户按需开启
    performance: { prehide: false },
    sites: { disabled: [] },
  };
}
