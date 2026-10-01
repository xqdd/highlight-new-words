import type { Settings } from '@/core/settings/schema';
import { resolveCardStyle, resolveMarkStyle } from '@/core/theme/resolve';
import { BUILTIN_THEMES, CUSTOM_THEME_ID, type MarkStyle } from '@/core/theme/themes';
import { HIGHLIGHT_PALETTE, markPrimaryColor, tintMark } from '@/ui/components/palette';

/**
 * 外观设置的修改逻辑（纯函数式地修改传入的 settings，便于单测）。
 *
 * 模型：全局样式 = 预设主题或自定义（custom）；按词书分色 = perBook[id].mark 存一份完整 MarkStyle（与全局同类型、换颜色）。
 * 全局样式类型变化时（如从“背景”换成“波浪线”），已分色的词书按各自主色重新着色，保持“同一种样式、不同颜色”。
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

/** 选择预设主题 */
export function applyPreset(settings: Settings, themeId: string) {
  settings.style.themeId = themeId;
  retintPerBook(settings);
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

/** 预设分组：新预设在前，旧版配色单独折叠 */
export function presetGroups() {
  return {
    main: BUILTIN_THEMES.filter((t) => !t.id.startsWith('legacy-')),
    legacy: BUILTIN_THEMES.filter((t) => t.id.startsWith('legacy-')),
  };
}
