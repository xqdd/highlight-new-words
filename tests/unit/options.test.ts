import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '@/core/settings/defaults';
import { normalizeSettings } from '@/core/settings/migrate';
import { resolveMarkStyle } from '@/core/theme/resolve';
import { BUILTIN_THEMES, CUSTOM_THEME_ID } from '@/core/theme/themes';
import { applyCustomMark, applyPreset, autoAssignBookColors, setBookColor } from '@/entrypoints/options/lib/appearance';
import { moveBook, relativeTime, toggleBook } from '@/entrypoints/options/lib/books';
import { buildMark, hexToHsv, hsvToHex, markKind, markPrimaryColor, tintMark } from '@/ui/components/palette';

describe('options：配色工具（palette）', () => {
  it('HSV 与 HEX 互转可往返', () => {
    for (const hex of ['#ff7008', '#2563eb', '#10b981', '#000000', '#ffffff', '#808080']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
  });

  it('识别样式类型与主色', () => {
    expect(markKind(buildMark('background', '#ff7008'))).toBe('background');
    expect(markKind(buildMark('text', '#ff7008'))).toBe('text');
    expect(markKind(buildMark('underline', '#ff7008', true))).toBe('underline');
    expect(markKind(buildMark('wavy', '#ff7008'))).toBe('wavy');
    // 所有内置主题都能识别出主色（色板选中态依赖它）
    for (const t of BUILTIN_THEMES) expect(markPrimaryColor(t.mark)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('tintMark 保持样式类型只换颜色：背景保留透明度，下划线浅底同步换色', () => {
    const bg = tintMark({ background: '#ffc40066', color: '', underline: 'none', underlineColor: '' }, '#2563eb');
    expect(bg.background).toBe('#2563eb66');
    const ul = tintMark(buildMark('dashed', '#ff7008', true), '#10b981');
    expect(ul).toMatchObject({ underline: 'dashed', underlineColor: '#10b981' });
    expect(ul.background.startsWith('#10b981')).toBe(true);
    expect(tintMark(buildMark('text', '#ff7008'), '#2563eb').color).toBe('#2563eb');
  });
});

describe('options：外观设置修改', () => {
  it('自定义样式切到 custom 主题，并沿用预设的卡片配色', () => {
    const s = createDefaultSettings();
    applyPreset(s, 'mint');
    applyCustomMark(s, buildMark('wavy', '#ef4444'));
    expect(s.style.themeId).toBe(CUSTOM_THEME_ID);
    expect(s.style.custom.card.accent).toBe(BUILTIN_THEMES.find((t) => t.id === 'mint')!.card.accent);
    expect(resolveMarkStyle(s).underline).toBe('wavy');
  });

  it('按词书分色：全局样式类型变化时已分色的词书跟随新样式并保留各自颜色', () => {
    const s = createDefaultSettings();
    s.books.enabled = ['cet4', 'cet6', 'gre'];
    autoAssignBookColors(s);
    expect(s.style.perBook.cet4).toBeUndefined();
    const c6 = markPrimaryColor(resolveMarkStyle(s, 'cet6'));
    const gre = markPrimaryColor(resolveMarkStyle(s, 'gre'));
    expect(c6).not.toBe(gre);
    applyCustomMark(s, buildMark('wavy', '#ff7008'));
    expect(resolveMarkStyle(s, 'cet6')).toMatchObject({ underline: 'wavy', underlineColor: c6 });
    expect(resolveMarkStyle(s, 'gre')).toMatchObject({ underline: 'wavy', underlineColor: gre });
    setBookColor(s, 'gre', null);
    expect(s.style.perBook.gre).toBeUndefined();
  });

  it('词书启用与优先级调整', () => {
    const s = createDefaultSettings();
    s.books.enabled = ['a', 'b'];
    toggleBook(s, 'c');
    expect(s.books.enabled).toEqual(['a', 'b', 'c']);
    moveBook(s, 'c', -1);
    expect(s.books.enabled).toEqual(['a', 'c', 'b']);
    moveBook(s, 'a', -1);
    expect(s.books.enabled).toEqual(['a', 'c', 'b']);
    toggleBook(s, 'a');
    expect(s.books.enabled).toEqual(['c', 'b']);
  });

  it('旧设置缺少 ui 字段时补默认值', () => {
    const raw = createDefaultSettings() as unknown as Record<string, unknown>;
    delete raw.ui;
    expect(normalizeSettings(raw).ui.theme).toBe('auto');
  });

  it('相对时间文案', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(0, now)).toBe('从未');
    expect(relativeTime(now - 30_000, now)).toBe('刚刚');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 小时前');
    expect(relativeTime(now - 2 * 86400_000, now)).toBe('2 天前');
  });
});
