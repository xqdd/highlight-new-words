import { describe, expect, it } from 'vitest';
import { hasLegacyData, migrateLegacy, migrateSettingsV2, normalizeSettings } from '@/core/settings/migrate';
import { createDefaultSettings } from '@/core/settings/defaults';
import { CUSTOM_THEME_ID } from '@/core/theme/themes';

describe('migrateLegacy', () => {
  it('迁移旧版有道用户的设置与生词', () => {
    const { settings, sourceBook } = migrateLegacy({
      toggle: false,
      ttsToggle: false,
      ttsVoices: { lang: 'en-US', voiceName: 'Google US English' },
      highlightBackground: '#e8f5e9',
      highlightText: '#1b5e20',
      bubbleBackground: '#e8f5e9',
      bubbleText: '#1b5e20',
      dictionaryType: 0,
      autoSync: false,
      cookie: 'a=1',
      syncTime: 123,
      newWords: { wordInfos: { Manipulate: { word: 'manipulate', trans: 'vt. 操纵', phonetic: '[x]', itemId: 42 } } },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.tts.enabled).toBe(false);
    expect(settings.tts.voice).toEqual({ lang: 'en-US', voiceName: 'Google US English', extensionId: undefined });
    expect(settings.style.themeId).toBe(CUSTOM_THEME_ID);
    expect(settings.style.custom.mark).toMatchObject({ background: '#e8f5e9', color: '#1b5e20' });
    expect(settings.sources.youdao).toEqual({ enabled: true, autoSync: false, deleteOnKnown: false });
    expect(settings.sources.eudic?.enabled).toBe(false);
    expect(settings.books.enabled).toEqual(['src:youdao:default']);
    expect(sourceBook?.state).toMatchObject({ id: 'src:youdao:default', providerId: 'youdao', status: 'ok', lastSyncAt: 123, wordCount: 1 });
    expect(sourceBook?.words.manipulate).toEqual({ word: 'manipulate', trans: 'vt. 操纵', phonetic: '[x]', ref: '42' });
  });

  it('欧路：dictionaryType=1，迁移为 src:eudic:-1，删除句柄为远端单词；默认颜色不切换为自定义主题', () => {
    const { settings, sourceBook } = migrateLegacy({
      ttsVoices: { lang: 'en' },
      highlightBackground: '#FFFF0010',
      highlightText: '',
      bubbleBackground: '#FFE4C4',
      bubbleText: '',
      dictionaryType: '1',
      newWords: { wordInfos: { apple: { word: 'apple', link: 'Apple', phonetic: 'ˈæpl', trans: 'n. 苹果' } } },
    });
    expect(settings.sources.eudic?.enabled).toBe(true);
    expect(settings.sources.youdao?.enabled).toBe(false);
    expect(settings.style.themeId).not.toBe(CUSTOM_THEME_ID);
    expect(settings.books.enabled).toEqual(['src:eudic:-1']);
    expect(sourceBook?.words.apple).toMatchObject({ word: 'apple', ref: 'apple', trans: 'n. 苹果' });
  });

  it('无旧数据', () => {
    expect(hasLegacyData({})).toBe(false);
  });

  it('新安装默认不启用任何云端来源，默认词书不变', () => {
    const d = createDefaultSettings();
    expect(Object.values(d.sources).every((src) => !src.enabled)).toBe(true);
    expect(d.books.enabled).toEqual(['cet6']);
  });

  it('旧版有道用户只同步过（syncTime>0）但生词本为空：仍启用有道，保留同步时间供每天自动同步', () => {
    const { settings, sourceBook } = migrateLegacy({ ttsVoices: { lang: 'en' }, dictionaryType: 0, syncTime: 456, newWords: { wordInfos: {} } });
    expect(settings.sources.youdao).toMatchObject({ enabled: true, autoSync: true });
    expect(settings.sources.eudic?.enabled).toBe(false);
    expect(settings.books.enabled).toEqual(['src:youdao:default']);
    expect(sourceBook?.state).toMatchObject({ status: 'empty', lastSyncAt: 456 });
  });

  it('旧版从未用过云端生词本（无生词、syncTime=0）：与新安装一致不启用来源，沿用默认词书', () => {
    const { settings, sourceBook } = migrateLegacy({ toggle: true, ttsVoices: { lang: 'en' }, dictionaryType: 0, autoSync: false, syncTime: 0 });
    expect(Object.values(settings.sources).every((src) => !src.enabled)).toBe(true);
    // 旧版的自动同步偏好保留，用户日后开启来源时沿用
    expect(settings.sources.youdao?.autoSync).toBe(false);
    expect(settings.books.enabled).toEqual(createDefaultSettings().books.enabled);
    expect(sourceBook).toBeUndefined();
  });
});

describe('migrateSettingsV2（v3 开发期结构）', () => {
  it('cloud + cloudBook(eudic) -> 来源词书，books.enabled 中 cloud 原位替换', () => {
    const { settings, sourceBook, localBook } = migrateSettingsV2(
      { schemaVersion: 2, books: { enabled: ['cet6', 'cloud', 'gre'] }, cloud: { provider: 'eudic', autoSync: false, syncTime: 9 } },
      { provider: 'eudic', words: { apple: { word: 'apple', display: 'Apple' } }, updatedAt: 9 },
    );
    expect(settings.books.enabled).toEqual(['cet6', 'src:eudic:-1', 'gre']);
    expect(settings.sources.eudic).toMatchObject({ enabled: true, autoSync: false });
    expect('cloud' in settings).toBe(false);
    expect(sourceBook?.words.apple).toEqual({ word: 'apple', ref: 'Apple', phonetic: undefined, trans: undefined });
    expect(localBook).toBeUndefined();
  });
  it('cloudBook(xml) -> 本地导入词书', () => {
    const { settings, localBook } = migrateSettingsV2(
      { schemaVersion: 2, books: { enabled: ['cloud'] }, cloud: { provider: 'youdao' } },
      { provider: 'xml', words: { apple: { word: 'apple', trans: 'n. 苹果' } }, updatedAt: 5 },
    );
    expect(localBook?.meta).toMatchObject({ format: 'youdao-xml', wordCount: 1 });
    expect(settings.books.enabled).toEqual([localBook!.meta.id]);
    expect(localBook!.meta.id.startsWith('local:')).toBe(true);
  });
});

describe('normalizeSettings', () => {
  it('补齐缺失字段、保留自由 key 与数组', () => {
    const s = normalizeSettings({
      enabled: false,
      books: { enabled: ['gre'] },
      style: { perBook: { gre: { themeId: 'rose' } } },
      sources: { youdao: { deleteOnKnown: true }, future: { enabled: true, autoSync: false, deleteOnKnown: false } },
    });
    const d = createDefaultSettings();
    expect(s.enabled).toBe(false);
    expect(s.books.enabled).toEqual(['gre']);
    expect(s.style.perBook.gre).toEqual({ themeId: 'rose' });
    expect(s.style.themeId).toBe(d.style.themeId);
    // 只写了 deleteOnKnown：其余字段按默认值补齐（云端来源默认关闭）
    expect(s.sources.youdao).toEqual({ enabled: false, autoSync: true, deleteOnKnown: true });
    expect(s.sources.future?.enabled).toBe(true);
    expect(s.tts).toEqual(d.tts);
  });
  it('已启用的来源升级后仍是启用状态，不被新默认值（关闭）覆盖', () => {
    const s = normalizeSettings({ sources: { youdao: { enabled: true, autoSync: true, deleteOnKnown: false }, eudic: { enabled: true, autoSync: false, deleteOnKnown: true } } });
    expect(s.sources.youdao).toEqual({ enabled: true, autoSync: true, deleteOnKnown: false });
    expect(s.sources.eudic).toEqual({ enabled: true, autoSync: false, deleteOnKnown: true });
  });
  it('非对象输入返回默认值', () => {
    expect(normalizeSettings(undefined)).toEqual(createDefaultSettings());
  });
});
