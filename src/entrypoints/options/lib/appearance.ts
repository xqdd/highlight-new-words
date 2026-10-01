import type { Settings } from '@/core/settings/schema';
import { applyThemePreset, resolveCardStyle, resolveMarkStyle } from '@/core/theme/resolve';
import { BUILTIN_THEMES, CUSTOM_THEME_ID, findTheme, type MarkStyle } from '@/core/theme/themes';
import { HIGHLIGHT_PALETTE, markPrimaryColor, tintMark } from '@/ui/components/palette';

/**
 * 外观设置的修改逻辑（纯函数式地修改传入的 settings，便于单测）。
 *
 * 模型：全局样式 = 预设主题或自定义（custom）。按词书有三种方式（bookStyleMode）：
 * - follow 跟随全局：perBook 中没有该书；
 * - tint 只换颜色：perBook[id] = { mark: 完整 MarkStyle }（与全局同形态、换颜色）。全局样式形态变化时（如从“背景”换成“波浪线”），
 *   按各自主色重新着色（retintPerBook），保持“同一种样式、不同颜色”；
 * - own 独立样式：perBook[id] = { themeId: 'custom', mark: 完整 MarkStyle }。resolveMarkStyle 先取 custom 再整体覆盖为该 mark，
 *   结果就是这份 mark；带 themeId 的覆盖不会被 retintPerBook 改动。旧数据中 { themeId: 预设 id } 也视为独立样式。
 */

/** 设置全局自定义高亮样式并切到 custom 主题 */
export function applyCustomMark(settings: Settings, mark: MarkStyle) {
  if (settings.style.themeId !== CUSTOM_THEME_ID) {
    // 从预设切到自定义时沿用预设的卡片配色，避免卡片颜色突变为旧版默认
    settings.style.custom.card = { ...resolveCardStyle(settings) };
  }
  settings.style.custom.mark = { ...mark };
  settings.style.themeId = CUSTOM_THEME_ID;
  retintPerBook(settings);
}

/** 选择预设主题：预设带建议译文（如“仅括号译文”）时一并应用（engine 的 applyThemePreset），再重新着色按词书分色的书 */
export function applyPreset(settings: Settings, themeId: string) {
  applyThemePreset(settings, themeId);
  retintPerBook(settings);
}

export type BookStyleMode = 'follow' | 'tint' | 'own';

export function bookStyleMode(settings: Settings, bookId: string): BookStyleMode {
  const o = settings.style.perBook[bookId];
  if (!o) return 'follow';
  return o.themeId ? 'own' : 'tint';
}

/** 为词书设置独立样式（完整 MarkStyle，不随全局变化） */
export function setBookStyle(settings: Settings, bookId: string, mark: MarkStyle) {
  settings.style.perBook = { ...settings.style.perBook, [bookId]: { themeId: CUSTOM_THEME_ID, mark: { ...mark } } };
}

/** 另存当前样式到“我的样式”；同名覆盖。返回新样式 id */
export function saveStyle(settings: Settings, name: string, mark: MarkStyle): string {
  const saved = settings.style.saved ?? [];
  const existing = saved.find((s) => s.name === name);
  const id = existing?.id ?? `s${Date.now().toString(36)}`;
  settings.style.saved = [...saved.filter((s) => s.id !== id), { id, name, mark: { ...mark } }];
  return id;
}

export function deleteSavedStyle(settings: Settings, id: string) {
  settings.style.saved = (settings.style.saved ?? []).filter((s) => s.id !== id);
}

/** 当前全局样式的显示名：预设名 / 自定义 */
export function currentStyleName(settings: Settings): string {
  const id = settings.style.themeId;
  return id === CUSTOM_THEME_ID ? '自定义' : (findTheme(id)?.name ?? id);
}

/** 按新的全局样式重新着色所有“按词书分色”的词书（只处理存了 mark 覆盖的；themeId 覆盖保持不变） */
export function retintPerBook(settings: Settings) {
  const global = resolveMarkStyle(settings);
  const next: Settings['style']['perBook'] = {};
  for (const [id, o] of Object.entries(settings.style.perBook)) {
    if (o.mark && !o.themeId) {
      const color = markPrimaryColor({ ...global, ...o.mark });
      next[id] = { mark: tintMark(global, color) };
    } else next[id] = o;
  }
  settings.style.perBook = next;
}

/** 为词书指定颜色；color 为空表示跟随全局 */
export function setBookColor(settings: Settings, bookId: string, color: string | null) {
  const perBook = { ...settings.style.perBook };
  if (color) perBook[bookId] = { mark: tintMark(resolveMarkStyle(settings), color) };
  else delete perBook[bookId];
  settings.style.perBook = perBook;
}

/** 自动为已启用词书分配不同颜色：第一本跟随全局，其余依次取色板中与全局主色不同的颜色 */
export function autoAssignBookColors(settings: Settings) {
  const globalColor = markPrimaryColor(resolveMarkStyle(settings));
  const colors = HIGHLIGHT_PALETTE.map((c) => c.hex).filter((c) => c !== globalColor);
  // 间隔取色，相邻词书色相差异更明显
  const order = [0, 6, 3, 9, 1, 7, 4, 10, 2, 8, 5].map((i) => colors[i % colors.length]!);
  const perBook = { ...settings.style.perBook };
  settings.books.enabled.forEach((id, i) => {
    if (i === 0) delete perBook[id];
    else perBook[id] = { mark: tintMark(resolveMarkStyle(settings), order[(i - 1) % order.length]!) };
  });
  settings.style.perBook = perBook;
}

/**
 * 预设分组：combos 为多维组合预设（带一句话说明，v5）、singles 为单一颜色样式。
 * main = combos + singles（popup 快捷切换沿用）。
 */
export function presetGroups() {
  const combos = BUILTIN_THEMES.filter((t) => !!t.desc);
  const singles = BUILTIN_THEMES.filter((t) => !t.desc);
  return { combos, singles, main: [...combos, ...singles] };
}
