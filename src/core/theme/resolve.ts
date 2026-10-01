import type { BookId, Settings } from '../settings/schema';
import { CUSTOM_THEME_ID, DEFAULT_THEME_ID, findTheme, type CardStyle, type MarkStyle } from './themes';

function themeMark(settings: Settings, themeId: string): MarkStyle {
  if (themeId === CUSTOM_THEME_ID) return settings.style.custom.mark;
  return (findTheme(themeId) ?? findTheme(DEFAULT_THEME_ID)!).mark;
}

/** 解析某本词书最终的高亮样式：词书覆盖主题 > 全局主题，再叠加词书的 mark 局部覆盖 */
export function resolveMarkStyle(settings: Settings, bookId?: BookId): MarkStyle {
  const override = bookId ? settings.style.perBook[bookId] : undefined;
  const base = themeMark(settings, override?.themeId ?? settings.style.themeId);
  return { ...base, ...(override?.mark ?? {}) };
}

/** 卡片样式跟随全局主题 */
export function resolveCardStyle(settings: Settings): CardStyle {
  const id = settings.style.themeId;
  if (id === CUSTOM_THEME_ID) {
    const c = settings.style.custom.card;
    // 旧版气泡文字色可能为空，卡片需要一个确定的文字色
    return { background: c.background || '#ffffff', color: c.color || '#1f2328', accent: c.accent || '#2563eb' };
  }
  return (findTheme(id) ?? findTheme(DEFAULT_THEME_ID)!).card;
}

/** MarkStyle -> CSS 声明（不含选择器），options 预览与内容脚本共用 */
export function markStyleToCss(s: MarkStyle): string {
  const decl: string[] = [];
  decl.push(`background-color: ${s.background || 'transparent'}`);
  if (s.color) decl.push(`color: ${s.color}`);
  if (s.underline !== 'none') {
    decl.push(`text-decoration-line: underline`);
    decl.push(`text-decoration-style: ${s.underline}`);
    decl.push(`text-decoration-color: ${s.underlineColor || 'currentColor'}`);
    decl.push(`text-decoration-thickness: ${s.underline === 'solid' ? '2px' : '1.5px'}`);
    decl.push(`text-underline-offset: 3px`);
  } else {
    decl.push('text-decoration: inherit');
  }
  return decl.join('; ');
}
