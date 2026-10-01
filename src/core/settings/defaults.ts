import { DEFAULT_THEME_ID } from '../theme/themes';
import { EUDIC_PROVIDER_ID, YOUDAO_PROVIDER_ID } from '../source/providers';
import { SETTINGS_SCHEMA_VERSION, type Settings, type SourceSettings } from './schema';

/**
 * 新安装用户的默认词书：六级（data 分片确定最终 id 后可调整）。
 * 来源词书在首次同步成功时由 background 自动加入启用列表（见 background/sources/service.ts）。
 */
export const DEFAULT_ENABLED_BOOKS = ['cet6'];

/** 新来源的默认配置：不自动删除远端单词 */
export function createDefaultSourceSettings(enabled = false): SourceSettings {
  return { enabled, autoSync: true, deleteOnKnown: false };
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
    inlineTranslation: { mode: 'off' },
    card: { trigger: 'auto' },
    tts: { enabled: true, voice: { lang: 'en' }, rate: 1 },
    // 旧版默认来源为有道
    sources: {
      [YOUDAO_PROVIDER_ID]: createDefaultSourceSettings(true),
      [EUDIC_PROVIDER_ID]: createDefaultSourceSettings(false),
    },
    sync: { enabled: true, include: { settings: true, knownWords: true, localBooks: true } },
    ui: { theme: 'auto' },
    sites: { disabled: [] },
  };
}
