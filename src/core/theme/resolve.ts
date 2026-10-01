import type { BookId, Settings } from '../settings/schema';
import {
  CUSTOM_THEME_ID,
  DEFAULT_THEME_ID,
  TRANSLATION_PRESETS,
  TRANSLATION_STYLE_DEFAULTS,
  findTheme,
  type CardStyle,
  type InlineTranslationMode,
  type MarkStyle,
  type TranslationBracket,
  type TranslationPreset,
  type TranslationStyle,
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
  bracket: TranslationBracket;
  background: string;
  italic: boolean;
  bold: boolean;
}

export function resolveTranslationStyle(settings: Settings): ResolvedTranslationStyle {
  return resolveTranslationStyleOf(settings.inlineTranslation);
}

/** 按模式补齐缺省值（不依赖完整 Settings：选项页的预设卡片示例、预设匹配判定也用它） */
export function resolveTranslationStyleOf(t: { mode: InlineTranslationMode } & TranslationStyle): ResolvedTranslationStyle {
  const key = t.mode === 'off' ? 'after' : t.mode;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    mode: t.mode,
    blur: !!t.blur,
    color: t.color ?? TRANSLATION_STYLE_DEFAULTS.color,
    opacity: clamp(t.opacity ?? TRANSLATION_STYLE_DEFAULTS.opacity[key], 0.2, 1),
    fontScale: clamp(t.fontScale ?? TRANSLATION_STYLE_DEFAULTS.fontScale[key], 0.5, 1),
    bracket: t.bracket ?? 'paren',
    background: t.background ?? '',
    italic: !!t.italic,
    bold: !!t.bold,
  };
}

/**
 * 译文的外观声明（底色、斜体、加粗），追加在各模式的字号/透明度/颜色声明之后。
 * 字段都为缺省时返回空数组，保证旧设置生成的 CSS 与新增这些字段之前完全一致。
 * 带底色时加少量水平内边距与圆角（标签/胶囊效果），不加垂直内边距，避免撑高行距。
 */
export function translationLookDecls(t: ResolvedTranslationStyle): string[] {
  const decls: string[] = [];
  if (t.background) decls.push(`background:${t.background}`, 'padding:0 .3em', 'border-radius:.3em');
  if (t.italic) decls.push('font-style:italic');
  if (t.bold) decls.push('font-weight:700');
  return decls;
}

/** 译文预设可改动的样式字段（预设只动这些，不动 mode/blur/oncePerParagraph） */
const TRANSLATION_PRESET_FIELDS = ['color', 'opacity', 'fontScale', 'bracket', 'background', 'italic', 'bold'] as const;

/**
 * 选择译文样式预设：先清掉全部样式字段（回到按模式的缺省值），再写入预设的字段。
 * 所以“经典括号”会把用户调过的浓淡、字号等清回缺省。替换整个 inlineTranslation 对象（options 中为响应式对象）。
 */
export function applyTranslationPreset(settings: Settings, presetId: string): Settings {
  const preset = TRANSLATION_PRESETS.find((p) => p.id === presetId);
  if (!preset) return settings;
  const next = { ...settings.inlineTranslation };
  for (const f of TRANSLATION_PRESET_FIELDS) delete next[f];
  settings.inlineTranslation = { ...next, ...preset.style };
  return settings;
}

/**
 * 当前译文样式匹配哪个预设：双方都按当前模式补齐缺省值后逐字段比较（颜色忽略大小写、数值容差 0.001），
 * 所以“没写 opacity”与“opacity 恰为模式缺省值”视为相同。没有匹配返回 undefined（界面显示“自定义”）。
 */
export function matchTranslationPreset(t: { mode: InlineTranslationMode } & TranslationStyle): TranslationPreset | undefined {
  const cur = resolveTranslationStyleOf(t);
  return TRANSLATION_PRESETS.find((p) => {
    const want = resolveTranslationStyleOf({ mode: t.mode, ...p.style });
    return TRANSLATION_PRESET_FIELDS.every((f) => {
      const a = cur[f];
      const b = want[f];
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.001;
      if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
      return a === b;
    });
  });
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
