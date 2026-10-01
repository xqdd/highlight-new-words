import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { countPhraseEntries, isPhraseEntry, parseWordList, phraseNotice } from '@/core/import/parse';
import { createDefaultSettings } from '@/core/settings/defaults';
import { CARD_HOVER_DELAYS, LOCAL_KNOWN_BOOK_ID, type CardModifierKey } from '@/core/settings/schema';
import { getSettings } from '@/core/settings/store';
import type { SourceBookState } from '@/core/wordbook/types';
import { CARD_TRIGGER_MODES, HOVER_DELAY_OPTIONS, modifierKeyNote, showsHoverDelay } from '@/entrypoints/options/lib/card-trigger';
import { prehideApplies, prehideNote, setPrehide } from '@/entrypoints/options/lib/performance';
import { SOURCE_OFF_REMOVE_NOTE, SOURCE_OFF_WRITE_NOTE, wordActionOptions } from '@/entrypoints/options/lib/word-actions';

/**
 * options 修复轮（O1–O8）的回归：纯函数直接断言，组件接入点用源码静态断言（vitest 未配置 .vue 编译）。
 * 界面行为（切换修饰键副标题不变、悬停延迟写回与演示延迟、锚点定位）在构建产物上用 Playwright 验证（修复轮脚本 /tmp/gauntlet/options-fix/verify.mjs）。
 */

const KEY_NAMES = /Alt|Ctrl|Shift|Control|Option|Command|⌥|⌃|⌘|⇧/;

describe('O1 加载时先隐藏页面（performance.prehide）', () => {
  beforeEach(() => fakeBrowser.reset());

  it('切换开关调用 patchSettings({performance:{prehide}})，并同步本页设置', async () => {
    const s = createDefaultSettings();
    const patch = vi.fn().mockResolvedValue(s);
    await setPrehide(s, true, patch);
    expect(patch).toHaveBeenCalledWith({ performance: { prehide: true } });
    expect(s.performance.prehide).toBe(true);
    await setPrehide(s, false, patch);
    expect(patch).toHaveBeenLastCalledWith({ performance: { prehide: false } });
  });

  it('写入 storage，重新读取（刷新页面）后开关状态保持', async () => {
    const s = createDefaultSettings();
    expect(s.performance.prehide).toBe(false);
    await setPrehide(s, true);
    expect((await getSettings()).performance.prehide).toBe(true);
    await setPrehide(s, false);
    expect((await getSettings()).performance.prehide).toBe(false);
  });

  it('只在词后/词上译文或粗体/斜体样式时起作用，其他情况注明', () => {
    const s = createDefaultSettings();
    expect(prehideApplies(s)).toBe(false);
    expect(prehideNote(s)).toContain('当前设置下不会隐藏页面');
    expect(prehideNote(s)).toContain('粗体/斜体');
    s.inlineTranslation.mode = 'after';
    expect(prehideApplies(s)).toBe(true);
    expect(prehideNote(s)).toContain('当前设置会起作用');
    s.inlineTranslation.mode = 'hover';
    expect(prehideApplies(s)).toBe(false);
  });

  it('开关放在外观页“行内译文”的高级区', () => {
    const src = readFileSync('src/entrypoints/options/pages/AppearancePage.vue', 'utf8');
    const inline = src.slice(src.indexOf('<SettingsSection id="inline"'), src.indexOf('<SettingsSection id="card"'));
    expect(inline).toContain('<summary>高级</summary>');
    expect(inline).toContain('加载时先隐藏页面，避免译文插入造成跳动（会让页面稍晚显示）');
    expect(inline).toContain('setPrehide(settings, v)');
  });
});

describe('O2/O4 修饰键文案', () => {
  it('选项副标题是固定文案，不含任何键名', () => {
    for (const m of CARD_TRIGGER_MODES) expect(m.desc).not.toMatch(KEY_NAMES);
    expect(CARD_TRIGGER_MODES.find((m) => m.value === 'modifier')?.desc).toBe('按住所选修饰键时才弹出，平时移动鼠标不打扰阅读');
  });

  it('mac ⌃ 单独说明右键菜单，不再说新标签打开', () => {
    const t = modifierKeyNote('ctrl', true);
    expect(t).toContain('⌃+点击会弹出右键菜单');
    expect(t).toContain('按住 ⌃ 悬停');
    expect(t).not.toContain('新标签');
  });

  it('Win/Linux Ctrl 与 mac ⌘：新标签打开，只需按住悬停', () => {
    expect(modifierKeyNote('ctrl', false)).toBe('Ctrl+点击链接会在新标签打开。查词只需按住 Ctrl 悬停、不要点击，链接不受影响。');
    expect(modifierKeyNote('meta', true)).toBe('⌘+点击链接会在新标签打开。查词只需按住 ⌘ 悬停、不要点击，链接不受影响。');
  });

  it('Alt/⌥：按住悬停、不要点击（会下载），不再“推荐”', () => {
    expect(modifierKeyNote('alt', true)).toBe('按住 ⌥ 悬停即可，不要点击（⌥+点击链接会下载）。');
    const win = modifierKeyNote('alt', false);
    expect(win).toContain('按住 Alt 悬停即可，不要点击（Alt+点击链接会下载）');
    expect(win).toContain('菜单栏');
    for (const k of ['alt', 'ctrl', 'shift', 'meta'] as CardModifierKey[]) for (const mac of [true, false]) expect(modifierKeyNote(k, mac)).not.toContain('推荐');
    const src = readFileSync('src/entrypoints/options/sections/CardTriggerSection.vue', 'utf8');
    expect(src).not.toContain('推荐');
  });

  it('mac Shift 用 ⇧，其他系统用 Shift', () => {
    expect(modifierKeyNote('shift', true)).toMatch(/^⇧\+点击/);
    expect(modifierKeyNote('shift', true)).not.toContain('Shift');
    expect(modifierKeyNote('shift', false)).toMatch(/^Shift\+点击/);
  });
});

describe('O3 悬停延迟三档', () => {
  it('档位与 schema 一致，默认 250；点击方式不显示', () => {
    expect(HOVER_DELAY_OPTIONS.map((o) => o.value)).toEqual([...CARD_HOVER_DELAYS]);
    expect(HOVER_DELAY_OPTIONS.map((o) => o.label)).toEqual(['快 100ms', '标准 250ms（默认）', '慢 400ms']);
    expect(createDefaultSettings().card.hoverDelay).toBe(250);
    expect(showsHoverDelay('hover')).toBe(true);
    expect(showsHoverDelay('modifier')).toBe(true);
    expect(showsHoverDelay('click')).toBe(false);
  });

  it('CardTriggerSection 读写 settings.card.hoverDelay，演示按同一延迟弹出', () => {
    const src = readFileSync('src/entrypoints/options/sections/CardTriggerSection.vue', 'utf8');
    expect(src).toContain('set: (v) => (settings.value.card.hoverDelay = v)');
    expect(src).toContain('hoverTimer = setTimeout(() => (demoOpen.value = word), hoverDelay.value)');
    expect(src).toContain('v-if="showsHoverDelay(mode)"');
    expect(src).toContain('越慢越不容易误触');
    // 副标题来自固定文案常量，模板里不再拼接 keyShort
    expect(src).toContain('const MODES = CARD_TRIGGER_MODES');
    expect(src).not.toMatch(/desc: `[^`]*keyShort/);
  });
});

describe('O6 来源关闭后的目标清单', () => {
  const book = (o: Partial<SourceBookState> & Pick<SourceBookState, 'id' | 'providerId' | 'name'>): SourceBookState => ({
    remoteId: o.id.split(':')[2]!, status: 'ok', lastSyncAt: 1, lastAttemptAt: 1, wordCount: 1, ...o,
  });
  const YD0 = book({ id: 'src:youdao:0', providerId: 'youdao', name: '无标签', canAdd: true, canDelete: true });
  const EU1 = book({ id: 'src:eudic:1', providerId: 'eudic', name: '测试', canAdd: true, canDelete: true });
  const EU_KNOWN = book({ id: 'src:eudic:9', providerId: 'eudic', name: '熟词分组', role: 'known', canAdd: true, canDelete: true });

  it('所属来源 enabled=false 的分组置灰并注明“来源已关闭”', () => {
    const s = createDefaultSettings();
    s.sources.youdao!.enabled = true;
    s.sources.eudic!.enabled = false;
    const o = wordActionOptions(s, [], [YD0, EU1, EU_KNOWN]);
    expect(o.addTargets.find((x) => x.id === YD0.id)).toMatchObject({ disabled: false, note: undefined });
    expect(o.addTargets.find((x) => x.id === EU1.id)).toMatchObject({ disabled: true, note: SOURCE_OFF_WRITE_NOTE });
    expect(SOURCE_OFF_WRITE_NOTE).toBe('来源已关闭，不会写入');
    expect(o.knownTargets.find((x) => x.id === EU_KNOWN.id)).toMatchObject({ disabled: true, note: SOURCE_OFF_WRITE_NOTE });
    expect(o.knownRemoveFrom.find((x) => x.id === EU1.id)).toMatchObject({ disabled: true, note: SOURCE_OFF_REMOVE_NOTE });
    expect(o.addRemoveFromKnown.find((x) => x.id === EU_KNOWN.id)).toMatchObject({ disabled: true, note: SOURCE_OFF_REMOVE_NOTE });
    // 本地熟词本不受影响
    expect(o.knownTargets.find((x) => x.id === LOCAL_KNOWN_BOOK_ID)?.disabled).toBe(false);
    // 重新打开来源后恢复可选
    s.sources.eudic!.enabled = true;
    expect(wordActionOptions(s, [], [EU1]).addTargets.find((x) => x.id === EU1.id)).toMatchObject({ disabled: false });
  });

  it('已勾选的已关闭来源仍显示勾选与同样的提示（TargetChecklist 只禁用未勾选项）', () => {
    const src = readFileSync('src/entrypoints/options/components/TargetChecklist.vue', 'utf8');
    expect(src).toContain(':checked="model.includes(o.id)"');
    expect(src).toContain(':disabled="disabled || (o.disabled && !model.includes(o.id))"');
    expect(src).toContain('<span v-if="o.note" class="note">{{ o.note }}</span>');
  });
});

describe('O7 补充说明', () => {
  it('代码“上方小标注”注明会遮挡上一行；行内译文“悬停显示”注明触屏点按看卡片', () => {
    expect(readFileSync('src/entrypoints/options/sections/CodeSection.vue', 'utf8')).toContain('会遮挡上一行代码');
    expect(readFileSync('src/entrypoints/options/pages/AppearancePage.vue', 'utf8')).toMatch(/value: 'hover', label: '悬停显示', desc: '[^']*触屏设备上没有悬停，请点按单词查看卡片'/);
  });
});

describe('O8 导入时提示短语不会高亮', () => {
  it('含空格或连字符的条目计为短语', () => {
    expect(isPhraseEntry('give up')).toBe(true);
    expect(isPhraseEntry('well-known')).toBe(true);
    expect(isPhraseEntry(' abandon ')).toBe(false);
    expect(isPhraseEntry("don't")).toBe(false);
  });

  it('导入结果中短语计数与提示文案', () => {
    const r = parseWordList({ text: 'abandon\ngive up\nwell-known\nlook forward to\nresilient\n' });
    expect(r.words).toHaveLength(5);
    const n = countPhraseEntries(r.words);
    expect(n).toBe(3);
    expect(phraseNotice(n)).toMatch(/^3 个短语不会在页面上高亮/);
    expect(phraseNotice(0)).toBe('');
    expect(countPhraseEntries(parseWordList({ text: 'apple\nbanana\n' }).words)).toBe(0);
  });

  it('导入预览与导入结果提示都接入了短语计数', () => {
    expect(readFileSync('src/entrypoints/options/components/ImportSheet.vue', 'utf8')).toMatch(/phraseNotice\(countPhraseEntries\(/);
    expect(readFileSync('src/entrypoints/options/sections/LocalBooksSection.vue', 'utf8')).toMatch(/个短语不会在页面上高亮/);
  });
});
