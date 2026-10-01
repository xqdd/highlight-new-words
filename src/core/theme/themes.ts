/**
 * 高亮主题（配色）契约与内置预设。
 *
 * - MarkStyle：页面内高亮单词的样式（背景、文字色、下划线）
 * - CardStyle：释义卡片的样式
 * 颜色值均为任意合法 CSS 颜色字符串（#RRGGBB / #RRGGBBAA / rgba() 等），空串表示继承页面原样式。
 */

export type UnderlineStyle = 'none' | 'solid' | 'wavy' | 'dotted' | 'dashed';

export interface MarkStyle {
  /** 高亮背景色，空串=无背景 */
  background: string;
  /** 文字颜色，空串=继承页面 */
  color: string;
  underline: UnderlineStyle;
  /** 下划线颜色，空串=currentColor */
  underlineColor: string;
}

export interface CardStyle {
  background: string;
  color: string;
  /** 强调色：按钮、标签等 */
  accent: string;
}

export interface HighlightTheme {
  id: string;
  name: string;
  nameEn: string;
  mark: MarkStyle;
  card: CardStyle;
}

/** 自定义主题 id：使用 Settings.style.custom 的颜色 */
export const CUSTOM_THEME_ID = 'custom';

const lightCard: CardStyle = { background: '#ffffff', color: '#1f2328', accent: '#2563eb' };

/**
 * 内置预设。半透明背景在深浅色页面上都可读；最后 5 个为旧版 popup 的配色方案（保留兼容）。
 * options 分片可以扩充此列表，但不要修改已存在的 id（用户设置里保存的是 id）。
 */
export const BUILTIN_THEMES: readonly HighlightTheme[] = [
  {
    id: 'amber',
    name: '琥珀',
    nameEn: 'Amber',
    mark: { background: 'rgba(255, 196, 0, 0.30)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#b45309' },
  },
  {
    id: 'mint',
    name: '薄荷',
    nameEn: 'Mint',
    mark: { background: 'rgba(16, 185, 129, 0.22)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#047857' },
  },
  {
    id: 'sky',
    name: '天空',
    nameEn: 'Sky',
    mark: { background: 'rgba(56, 189, 248, 0.25)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#0369a1' },
  },
  {
    id: 'rose',
    name: '玫瑰',
    nameEn: 'Rose',
    mark: { background: 'rgba(244, 63, 94, 0.18)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#be123c' },
  },
  {
    id: 'violet',
    name: '紫罗兰',
    nameEn: 'Violet',
    mark: { background: 'rgba(139, 92, 246, 0.20)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#6d28d9' },
  },
  {
    id: 'wavy',
    name: '波浪线',
    nameEn: 'Wavy underline',
    mark: { background: '', color: '', underline: 'wavy', underlineColor: '#f59e0b' },
    card: { ...lightCard, accent: '#b45309' },
  },
  {
    id: 'dotted',
    name: '点状线',
    nameEn: 'Dotted underline',
    mark: { background: '', color: '', underline: 'dotted', underlineColor: '#2563eb' },
    card: lightCard,
  },
  {
    id: 'ink',
    name: '墨蓝字',
    nameEn: 'Ink',
    mark: { background: '', color: '#2563eb', underline: 'none', underlineColor: '' },
    card: lightCard,
  },
  // ---- v3 options 新增预设（options 分片）：文字色 / 下划线 / 下划线+浅底，参照 Relingo 与不背单词的常用样式 ----
  {
    id: 'orange-text',
    name: '橙色字',
    nameEn: 'Orange text',
    mark: { background: '', color: '#ea580c', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#c2410c' },
  },
  {
    id: 'teal-text',
    name: '青绿字',
    nameEn: 'Teal text',
    mark: { background: '', color: '#0d9488', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#0f766e' },
  },
  {
    id: 'dashed-orange',
    name: '橙虚线',
    nameEn: 'Dashed orange',
    mark: { background: '', color: '', underline: 'dashed', underlineColor: '#f97316' },
    card: { ...lightCard, accent: '#c2410c' },
  },
  {
    id: 'wavy-red',
    name: '红波浪',
    nameEn: 'Red wavy',
    mark: { background: '', color: '', underline: 'wavy', underlineColor: '#ef4444' },
    card: { ...lightCard, accent: '#b91c1c' },
  },
  {
    id: 'underline-tint',
    name: '下划线浅底',
    nameEn: 'Underline + tint',
    mark: { background: 'rgba(249, 115, 22, 0.12)', color: '', underline: 'solid', underlineColor: '#f97316' },
    card: { ...lightCard, accent: '#c2410c' },
  },
  {
    id: 'marker-lime',
    name: '荧光绿',
    nameEn: 'Lime marker',
    mark: { background: 'rgba(163, 230, 53, 0.35)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#4d7c0f' },
  },
  // ---- 旧版配色方案（popup 中 Light/Green/Red/Blue/Sky）----
  {
    id: 'legacy-light',
    name: '经典浅灰',
    nameEn: 'Classic light',
    mark: { background: '#f0f0f0', color: '#333333', underline: 'none', underlineColor: '' },
    card: { background: '#f0f0f0', color: '#333333', accent: '#333333' },
  },
  {
    id: 'legacy-green',
    name: '经典绿',
    nameEn: 'Classic green',
    mark: { background: '#e8f5e9', color: '#1b5e20', underline: 'none', underlineColor: '' },
    card: { background: '#e8f5e9', color: '#1b5e20', accent: '#1b5e20' },
  },
  {
    id: 'legacy-red',
    name: '经典红',
    nameEn: 'Classic red',
    mark: { background: '#fbe9e7', color: '#bf360c', underline: 'none', underlineColor: '' },
    card: { background: '#fbe9e7', color: '#bf360c', accent: '#bf360c' },
  },
  {
    id: 'legacy-blue',
    name: '经典蓝',
    nameEn: 'Classic blue',
    mark: { background: '#eaeef6', color: '#2a5598', underline: 'none', underlineColor: '' },
    card: { background: '#eaeef6', color: '#2a5598', accent: '#2a5598' },
  },
  {
    id: 'legacy-sky',
    name: '经典天蓝',
    nameEn: 'Classic sky',
    mark: { background: '#f5f5f5', color: '#35a3ff', underline: 'none', underlineColor: '' },
    card: { background: '#f5f5f5', color: '#35a3ff', accent: '#35a3ff' },
  },
];

export const DEFAULT_THEME_ID = 'amber';

export function findTheme(id: string): HighlightTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}
