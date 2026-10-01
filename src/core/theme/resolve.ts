import type { BookId, Settings } from '../settings/schema';
import {
  CUSTOM_THEME_ID,
  DEFAULT_THEME_ID,
  TRANSLATION_STYLE_DEFAULTS,
  findTheme,
  type CardStyle,
  type InlineTranslationMode,
  type MarkStyle,
} from './themes';

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

/** 背景色乘以不透明度倍率：用 color-mix 保持任意 CSS 颜色写法可用（Chromium 111+ / Firefox 113+） */
function scaledColor(color: string, opacity: number | undefined): string {
  if (opacity === undefined || opacity >= 1) return color;
  const pct = Math.round(Math.max(0, opacity) * 100);
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/**
 * 马克笔色带：只覆盖文字下半部（约 55%–92%），上沿留一点柔边，比整块底色更像手写划线。
 * 返回 background-image 值，供悬停叠色时与之组合。
 */
export function markerGradient(color: string): string {
  return `linear-gradient(to bottom, transparent 52%, ${color} 58%, ${color} 92%, transparent 92%)`;
}

/**
 * MarkStyle 拆成 CSS 声明：`decls` 为普通声明，`bgImage` 为马克笔色带（没有时为 null）。
 * 所有维度都不占布局空间（不加 padding/border，边框用 outline、胶囊留白用 box-shadow 扩展），
 * 所以切换样式不会让页面重排（字重 bold/medium 除外，会让单词略变宽）。
 */
export function markStyleParts(s: MarkStyle): { decls: string[]; bgImage: string | null } {
  const decls: string[] = [];
  let bgImage: string | null = null;
  const kind = s.backgroundKind ?? 'block';
  const bg = s.background ? scaledColor(s.background, s.backgroundOpacity) : '';
  if (!bg) decls.push('background-color: transparent');
  else if (kind === 'marker') {
    decls.push('background-color: transparent');
    bgImage = markerGradient(bg);
  } else {
    decls.push(`background-color: ${bg}`);
    if (kind === 'pill') {
      // 胶囊：全圆角 + 同色扩展阴影做视觉留白（阴影不占位，也不会与半透明底色叠深）
      decls.push('border-radius: 1em', `box-shadow: 0 0 0 .16em ${bg}`);
    }
  }
  if (s.rounded === false && kind !== 'pill') decls.push('border-radius: 0');
  if (s.color) decls.push(`color: ${s.color}`);
  if (s.fontWeight === 'medium') decls.push('font-weight: 500');
  else if (s.fontWeight === 'bold') decls.push('font-weight: 700');
  if (s.italic) decls.push('font-style: italic');
  if (s.underline !== 'none') {
    const thickness = s.underlineThickness ?? (s.underline === 'solid' && !s.underlineDouble ? 2 : 1.5);
    decls.push(
      'text-decoration-line: underline',
      `text-decoration-style: ${s.underlineDouble ? 'double' : s.underline}`,
      `text-decoration-color: ${s.underlineColor || 'currentColor'}`,
      `text-decoration-thickness: ${thickness}px`,
      `text-underline-offset: ${s.underlineOffset ?? 3}px`,
      'text-decoration-skip-ink: auto',
    );
  } else {
    decls.push('text-decoration: inherit');
  }
  if (s.border && s.border !== 'none') {
    const c = s.borderColor || s.underlineColor || s.color || 'currentColor';
    decls.push(`outline: 1px ${s.border} ${c}`, 'outline-offset: 0');
  }
  return { decls, bgImage };
}

/** MarkStyle -> CSS 声明（不含选择器），options 预览与内容脚本共用 */
export function markStyleToCss(s: MarkStyle): string {
  const { decls, bgImage } = markStyleParts(s);
  return (bgImage ? [...decls, `background-image: ${bgImage}`] : decls).join('; ');
}

/** 样式是否“只改文字颜色”（无背景、无装饰线、无边框）：这类样式在链接里容易被误认为链接色，engine 会特殊处理 */
export function isTextOnlyStyle(s: MarkStyle): boolean {
  return !!s.color && !s.background && s.underline === 'none' && (!s.border || s.border === 'none');
}

/** 解析后的行内译文样式（缺省值按模式补齐） */
export interface ResolvedTranslationStyle {
  mode: InlineTranslationMode;
  blur: boolean;
  color: string;
  opacity: number;
  fontScale: number;
}

export function resolveTranslationStyle(settings: Settings): ResolvedTranslationStyle {
  const t = settings.inlineTranslation;
  const key = t.mode === 'off' ? 'after' : t.mode;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    mode: t.mode,
    blur: !!t.blur,
    color: t.color ?? TRANSLATION_STYLE_DEFAULTS.color,
    opacity: clamp(t.opacity ?? TRANSLATION_STYLE_DEFAULTS.opacity[key], 0.2, 1),
    fontScale: clamp(t.fontScale ?? TRANSLATION_STYLE_DEFAULTS.fontScale[key], 0.5, 1),
  };
}

/**
 * 选择预设（预设画廊点选时调用）：设置全局主题；预设带建议译文（如“仅括号译文”）时一并应用译文模式与样式。
 * 直接修改传入的 settings（options 中为响应式对象）并返回它。
 */
export function applyThemePreset(settings: Settings, themeId: string): Settings {
  settings.style.themeId = themeId;
  const t = findTheme(themeId)?.translation;
  if (t) settings.inlineTranslation = { ...settings.inlineTranslation, blur: false, ...t };
  return settings;
}
