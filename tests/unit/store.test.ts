import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getKnownData, getKnownWords, importKnownWords, replaceKnownWords, setKnownWords, exportKnownWords } from '@/core/known/store';
import { getSettings, isSiteDisabled, patchSettings, runMigrationIfNeeded } from '@/core/settings/store';
import { DefaultWordBookRegistry, createExtensionLoaders } from '@/core/wordbook/registry';
import { deleteLocalBook, getLocalIndex, getSourceBook, getSourceIndex, renameLocalBook, saveLocalBook } from '@/core/wordbook/user-store';

describe('settings store（fake browser）', () => {
  beforeEach(() => fakeBrowser.reset());

  it('迁移 v2.0.1 旧键为来源词书并删除旧数据，再次运行不重复迁移', async () => {
    await fakeBrowser.storage.local.set({
      toggle: true,
      ttsVoices: { lang: 'en' },
      dictionaryType: 1,
      newWords: { wordInfos: { apple: { word: 'apple', trans: 'n. 苹果', link: 'Apple' } } },
    });
    expect(await runMigrationIfNeeded()).toBe(true);
    const s = await getSettings();
    expect(s.sources.eudic?.enabled).toBe(true);
    expect(s.books.enabled).toEqual(['src:eudic:-1']);
    expect((await getSourceBook('src:eudic:-1'))?.words.apple?.trans).toBe('n. 苹果');
    expect((await getSourceIndex()).books['src:eudic:-1']?.wordCount).toBe(1);
    expect(await fakeBrowser.storage.local.get('newWords')).toEqual({});
    expect(await runMigrationIfNeeded()).toBe(false);
  });

  it('迁移 v3 开发期 settings.cloud + cloudBook，并删除 cloudBook 键', async () => {
    await fakeBrowser.storage.local.set({
      settings: { schemaVersion: 2, books: { enabled: ['cloud', 'cet6'] }, cloud: { provider: 'youdao', autoSync: true, syncTime: 1 } },
      cloudBook: { provider: 'youdao', words: { run: { word: 'run', itemId: '7' } }, updatedAt: 1 },
    });
    expect(await runMigrationIfNeeded()).toBe(true);
    const s = await getSettings();
    expect(s.books.enabled).toEqual(['src:youdao:default', 'cet6']);
    expect((await getSourceBook('src:youdao:default'))?.words.run?.ref).toBe('7');
    expect(await fakeBrowser.storage.local.get('cloudBook')).toEqual({});
    expect(await runMigrationIfNeeded()).toBe(false);
  });

  it('patchSettings 深合并并刷新 updatedAt', async () => {
    await patchSettings({ inlineTranslation: { mode: 'ruby' }, sites: { disabled: ['example.com'] } });
    const s = await getSettings();
    expect(s.inlineTranslation.mode).toBe('ruby');
    expect(s.updatedAt).toBeGreaterThan(0);
    expect(isSiteDisabled(s, 'www.example.com')).toBe(true);
    expect(isSiteDisabled(s, 'notexample.com')).toBe(false);
  });
});

describe('熟词本存储', () => {
  beforeEach(() => fakeBrowser.reset());

  it('加入/撤销留墓碑，替换与导入导出', async () => {
    await setKnownWords(['Apple', 'run'], true);
    expect([...(await getKnownWords())].sort()).toEqual(['apple', 'run']);
    await setKnownWords(['run'], false);
    const data = await getKnownData();
    expect(Object.keys(data.words)).toEqual(['apple']);
    expect(data.removed.run).toBeGreaterThan(0);
    expect(await importKnownWords(['apple', 'zebra'])).toBe(1);
    await replaceKnownWords(['zebra']);
    expect([...(await getKnownWords())]).toEqual(['zebra']);
    expect(Object.keys((await getKnownData()).removed).sort()).toEqual(['apple', 'run']);
    expect(await exportKnownWords('txt')).toBe('zebra\n');
  });
});

describe('本地导入词书 + WordBookRegistry', () => {
  beforeEach(() => fakeBrowser.reset());

  it('新建、覆盖导入、重命名、删除；registry 统一列出并加载', async () => {
    const meta = await saveLocalBook({ name: 'A', format: 'txt', words: [{ word: 'Apple', trans: 'n. 苹果' }] });
    await saveLocalBook({ id: meta.id, name: 'A', format: 'csv', words: [{ word: 'pear' }, { word: 'fig' }] });
    await renameLocalBook(meta.id, '水果');
    const loaders = { ...createExtensionLoaders(), catalog: async () => ({ version: 1, books: [] }) };
    const reg = new DefaultWordBookRegistry(loaders);
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: meta.id, kind: 'local', name: '水果', size: 2, category: 'user', importFormat: 'csv' });
    const book = await reg.load(meta.id);
    expect(book?.has('pear')).toBe(true);
    expect(book?.has('apple')).toBe(false);
    await deleteLocalBook(meta.id);
    const index = await getLocalIndex();
    expect(index.books).toEqual({});
    expect(index.removed[meta.id]).toBeGreaterThan(0);
    expect(await new DefaultWordBookRegistry(loaders).load(meta.id)).toBeUndefined();
  });
});
