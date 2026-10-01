import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createDefaultSettings } from '@/core/settings/defaults';
import { LOCAL_KNOWN_BOOK_ID, MY_WORDS_BOOK_ID } from '@/core/settings/schema';
import { resolveMarkStyle } from '@/core/theme/resolve';
import { BUILTIN_THEMES, CUSTOM_THEME_ID } from '@/core/theme/themes';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';
import { applyCustomMark, applyPreset, bookStyleMode, presetGroups, retintPerBook, saveStyle, setBookColor, setBookStyle } from '@/entrypoints/options/lib/appearance';
import { RELEASE_NOTES_VERSION, shouldShowReleaseNotes } from '@/entrypoints/options/lib/release-notes';
import { resolveAutoKnownRemoveFrom, setSourceBookRole, toggleTarget, wordActionOptions } from '@/entrypoints/options/lib/word-actions';
import { markPrimaryColor, tintMark } from '@/ui/components/palette';

const book = (o: Partial<SourceBookState> & Pick<SourceBookState, 'id' | 'providerId' | 'name'>): SourceBookState => ({
  remoteId: o.id.split(':')[2]!, status: 'ok', lastSyncAt: 1, lastAttemptAt: 1, wordCount: 1, ...o,
});
const YD0 = book({ id: 'src:youdao:0', providerId: 'youdao', name: '无标签', canAdd: true, canDelete: true });
const YD12 = book({ id: 'src:youdao:12', providerId: 'youdao', name: '考研', canAdd: false, canDelete: true, readOnlyReason: '只能加入默认分组' });
const MASTERED = book({ id: 'src:eudic:mastered', providerId: 'eudic', name: '已掌握单词', role: 'known', canAdd: false, canDelete: false, readOnlyReason: '没有写入接口' });
const EU1 = book({ id: 'src:eudic:1', providerId: 'eudic', name: '测试', canAdd: true, canDelete: true });
const STATES = [YD0, YD12, MASTERED, EU1];

describe('options：单词操作目标', () => {
  it('按角色与能力列出目标：只读熟词本置灰并给出原因，“我的生词本”未创建时也可选', () => {
    const s = createDefaultSettings();
    // 欧路默认关闭；来源关闭时的置灰说明见 options-fix.test.ts（O6），这里先打开以校验能力相关的原因
    s.sources.eudic!.enabled = true;
    const o = wordActionOptions(s, [] as BookMeta[], STATES);
    expect(o.addTargets.map((x) => x.id)).toEqual([MY_WORDS_BOOK_ID, YD0.id, YD12.id, EU1.id]);
    expect(o.addTargets.find((x) => x.id === YD12.id)).toMatchObject({ disabled: true, note: '只能加入默认分组' });
    expect(o.knownTargets.map((x) => x.id)).toEqual([LOCAL_KNOWN_BOOK_ID, MASTERED.id]);
    expect(o.knownTargets[1]).toMatchObject({ disabled: true, note: '没有写入接口' });
    // 有道非默认分组可以删词：作为“认识时移除”的目标可选
    expect(o.knownRemoveFrom.find((x) => x.id === YD12.id)?.disabled).toBe(false);
    expect(o.addRemoveFromKnown.find((x) => x.id === MASTERED.id)?.disabled).toBe(true);
  });

  it('auto 移除目标 = 加入目标中的本地书 + 开启 deleteOnKnown 的来源可删生词本', () => {
    const s = createDefaultSettings();
    expect(resolveAutoKnownRemoveFrom(s, STATES)).toEqual([MY_WORDS_BOOK_ID]);
    s.sources.youdao!.deleteOnKnown = true;
    expect(resolveAutoKnownRemoveFrom(s, STATES)).toEqual([MY_WORDS_BOOK_ID, YD0.id, YD12.id]);
  });

  it('改变来源词书角色：熟词本移出高亮与生词目标，改回生词本时移出熟词目标', () => {
    const s = createDefaultSettings();
    s.books.enabled = ['cet6', EU1.id];
    s.wordActions.addTargets = toggleTarget(s.wordActions.addTargets, EU1.id, true);
    setSourceBookRole(s, EU1, 'known');
    expect(s.knownBooks.roles[EU1.id]).toBe('known');
    expect(s.knownBooks.enabled).toContain(EU1.id);
    expect(s.books.enabled).toEqual(['cet6']);
    expect(s.wordActions.addTargets).not.toContain(EU1.id);
    s.wordActions.knownTargets = [LOCAL_KNOWN_BOOK_ID, EU1.id];
    setSourceBookRole(s, EU1, 'new');
    // 与 provider 声明一致时删除覆盖项
    expect(s.knownBooks.roles[EU1.id]).toBeUndefined();
    expect(s.knownBooks.enabled).not.toContain(EU1.id);
    expect(s.wordActions.knownTargets).toEqual([LOCAL_KNOWN_BOOK_ID]);
  });

  it('改回生词本时重新启用高亮（不重复），并返回被移除的单词操作目标供提示', () => {
    const s = createDefaultSettings();
    s.books.enabled = ['cet6', EU1.id];
    s.wordActions.addTargets = [MY_WORDS_BOOK_ID, EU1.id];
    s.wordActions.knownRemoveFrom = [EU1.id];
    expect(setSourceBookRole(s, EU1, 'known').removedTargets).toEqual(['加入生词本时写入', '标记熟词时移除']);
    expect(s.books.enabled).toEqual(['cet6']);
    expect(setSourceBookRole(s, EU1, 'new').removedTargets).toEqual([]);
    expect(s.books.enabled).toEqual(['cet6', EU1.id]);
    setSourceBookRole(s, EU1, 'new');
    expect(s.books.enabled.filter((id) => id === EU1.id)).toHaveLength(1);
    expect(s.knownBooks.enabled).not.toContain(EU1.id);
  });
});

describe('options：v5 样式', () => {
  it('tintMark 保持形态只换色：马克笔/边框/双线等新维度保留，背景+文字色组合保留文字色', () => {
    const marker = BUILTIN_THEMES.find((t) => t.id === 'highlighter')!.mark;
    const m = tintMark(marker, '#2563eb');
    expect(m.backgroundKind).toBe('marker');
    expect(m.background.startsWith('#2563eb')).toBe(true);
    const box = tintMark(BUILTIN_THEMES.find((t) => t.id === 'dashed-box')!.mark, '#ef4444');
    expect(box).toMatchObject({ border: 'dashed', borderColor: '#ef4444' });
    const legacy = tintMark(BUILTIN_THEMES.find((t) => t.id === 'legacy-red')!.mark, '#2563eb');
    expect(legacy.color).toBe('#bf360c');
    for (const t of BUILTIN_THEMES) expect(markPrimaryColor(t.mark)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('选带译文的预设会同时打开对应译文模式；预设分组覆盖全部内置预设', () => {
    const s = createDefaultSettings();
    applyPreset(s, 'gloss-only');
    expect(s.inlineTranslation.mode).toBe('after');
    const g = presetGroups();
    expect(g.combos.length).toBeGreaterThanOrEqual(10);
    expect(g.combos.length + g.singles.length + g.legacy.length).toBe(BUILTIN_THEMES.length);
  });

  it('按词书：只换颜色随全局形态重新着色，独立样式不受全局影响', () => {
    const s = createDefaultSettings();
    s.books.enabled = ['cet6', 'ielts', 'gre'];
    setBookColor(s, 'ielts', '#2563eb');
    setBookStyle(s, 'gre', BUILTIN_THEMES.find((t) => t.id === 'pill')!.mark);
    expect(bookStyleMode(s, 'cet6')).toBe('follow');
    expect(bookStyleMode(s, 'ielts')).toBe('tint');
    expect(bookStyleMode(s, 'gre')).toBe('own');
    applyCustomMark(s, { background: '', color: '', underline: 'wavy', underlineColor: '#10b981' });
    retintPerBook(s);
    expect(resolveMarkStyle(s, 'ielts')).toMatchObject({ underline: 'wavy', underlineColor: '#2563eb' });
    expect(resolveMarkStyle(s, 'gre').backgroundKind).toBe('pill');
    expect(s.style.themeId).toBe(CUSTOM_THEME_ID);
  });

  it('另存样式同名覆盖', () => {
    const s = createDefaultSettings();
    const id = saveStyle(s, 'A', resolveMarkStyle(s));
    saveStyle(s, 'A', { background: '', color: '#ff0000', underline: 'none', underlineColor: '' });
    expect(s.style.saved).toHaveLength(1);
    expect(s.style.saved![0]).toMatchObject({ id, mark: { color: '#ff0000' } });
  });
});

describe('options：更新说明', () => {
  beforeEach(() => fakeBrowser.reset());
  it('全新安装不弹并记为已读；升级用户弹一次', async () => {
    expect(await shouldShowReleaseNotes(0, false)).toBe(false);
    expect((await fakeBrowser.storage.local.get('uiNotesSeen')).uiNotesSeen).toBe(RELEASE_NOTES_VERSION);
    await fakeBrowser.storage.local.clear();
    expect(await shouldShowReleaseNotes(1, false)).toBe(true);
  });
});

describe('options：更新说明与 background 升级提示', () => {
  beforeEach(() => fakeBrowser.reset());
  it('有 updateNotice 时即使已读旧版本也显示', async () => {
    await fakeBrowser.storage.local.set({ uiNotesSeen: RELEASE_NOTES_VERSION, updateNotice: { from: '2.0.1', to: '3.0.0', at: 1 } });
    expect(await shouldShowReleaseNotes(5, false)).toBe(true);
  });
});
