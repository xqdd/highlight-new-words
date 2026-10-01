/**
 * 高亮主题（配色）契约与内置预设。
 *
 * - MarkStyle：页面内高亮单词的样式（背景、文字色、下划线）
 * - CardStyle：释义卡片的样式
 * 颜色值均为任意合法 CSS 颜色字符串（#RRGGBB / #RRGGBBAA / rgba() 等），空串表示继承页面原样式。
 */

export type UnderlineStyle = 'none' | 'solid' | 'wavy' | 'dotted' | 'dashed';

/** 背景形态（v5）：整块底色 / 马克笔（下半部色带）/ 圆角胶囊（视觉留白不占位） */
export type BackgroundKind = 'block' | 'marker' | 'pill';
/** 边框（v5）：用 outline 绘制，不占布局空间，不影响等宽对齐与换行 */
export type BorderStyle = 'none' | 'solid' | 'dashed' | 'dotted';
/** 字重（v5）：inherit 不改；medium=500；bold=700（会让单词变宽，可能改变换行） */
export type MarkFontWeight = 'inherit' | 'medium' | 'bold';

/**
 * 生词样式：四个可组合维度（装饰线 / 文字 / 背景 / 边框），全部为空/none 时为“无样式”（只靠行内译文提示）。
 * v5 新增字段全部可选，缺省时与旧版渲染一致（旧设置、旧主题无需迁移）。
 */
export interface MarkStyle {
  /** 高亮背景色，空串=无背景 */
  background: string;
  /** 文字颜色，空串=继承页面 */
  color: string;
  underline: UnderlineStyle;
  /** 下划线颜色，空串=currentColor */
  underlineColor: string;
  /** 双线（v5）：underline 非 none 时改为 text-decoration-style:double（CSS 只有一种线型，双线不能与波浪同时使用） */
  underlineDouble?: boolean;
  /** 装饰线粗细 px（v5，缺省：实线 2、其他 1.5） */
  underlineThickness?: number;
  /** 装饰线与文字基线的偏移 px（v5，缺省 3） */
  underlineOffset?: number;
  /** 字重（v5，缺省 inherit） */
  fontWeight?: MarkFontWeight;
  /** 斜体（v5） */
  italic?: boolean;
  /** 背景形态（v5，缺省 block；background 为空时无效） */
  backgroundKind?: BackgroundKind;
  /** 背景不透明度倍率 0–1（v5，缺省 1；与颜色自带的 alpha 相乘） */
  backgroundOpacity?: number;
  /** 边框（v5，缺省 none） */
  border?: BorderStyle;
  /** 边框颜色，空串=跟随装饰线色/文字色 */
  borderColor?: string;
  /** 边框/背景圆角（v5，缺省 true：.22em；pill 总是全圆角） */
  rounded?: boolean;
}

/** 行内译文模式：关闭 / 词后括注 / 词上方（ruby）/ 仅悬停时浮现（不占位） */
export type InlineTranslationMode = 'off' | 'after' | 'ruby' | 'hover';

/**
 * 行内译文样式（v5，与生词样式相互独立）。所有字段可选，缺省值见 TRANSLATION_STYLE_DEFAULTS。
 * 存于 Settings.inlineTranslation（与 mode 同级），预设可携带一份建议值（HighlightTheme.translation）。
 */
export interface TranslationStyle {
  /** 模糊自测：译文模糊显示，点按译文后才清晰（再点恢复） */
  blur?: boolean;
  /** 译文颜色，空串=继承正文色 */
  color?: string;
  /** 不透明度 0.2–1 */
  opacity?: number;
  /** 字号相对正文的比例 0.5–1 */
  fontScale?: number;
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
  /**
   * 预设建议的行内译文（v5，可选）：如“仅括号译文”需要 after 模式。
   * 主题与译文设置相互独立，只有用户在预设画廊中选择该预设时才应用（见 resolve.ts#applyThemePreset）。
   */
  translation?: { mode: InlineTranslationMode } & TranslationStyle;
  /** 一句话说明（v5 预设画廊用） */
  desc?: string;
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
    // 与 v5 的 wavy-line（珊瑚色波浪线）区分：此预设是琥珀色波浪线，id 保持不变（旧设置引用它）
    name: '琥珀波浪线',
    nameEn: 'Amber wavy',
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
  // ---- v5 组合样式预设（engine 第二阶段）：多维组合 + 建议的行内译文；都已在亮色页、暗色页、正文链接中核对可读性 ----
  // 颜色避开常见链接蓝（#0645ad/#1a0dab/#0969da），文字色类样式在链接内自动改为“保留链接色 + 同色浅底”（见 engine/style.ts）
  {
    id: 'highlighter',
    name: '荧光笔',
    nameEn: 'Highlighter',
    desc: '下半部黄色马克笔，像在纸上划重点',
    mark: { background: 'rgba(255, 213, 0, 0.55)', backgroundKind: 'marker', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#a16207' },
  },
  {
    id: 'wavy-line',
    name: '波浪线',
    nameEn: 'Wavy line',
    desc: '珊瑚色波浪下划线，醒目但不遮字',
    mark: { background: '', color: '', underline: 'wavy', underlineColor: '#f43f5e', underlineThickness: 1.5, underlineOffset: 4 },
    card: { ...lightCard, accent: '#be123c' },
  },
  {
    id: 'underline-gloss',
    name: '下划线 + 括号译文',
    nameEn: 'Underline + gloss',
    desc: '橙色下划线，词后灰色括号短释义',
    mark: { background: '', color: '', underline: 'solid', underlineColor: '#f97316', underlineThickness: 2, underlineOffset: 3 },
    card: { ...lightCard, accent: '#c2410c' },
    translation: { mode: 'after' },
  },
  {
    id: 'gloss-only',
    name: '仅括号译文',
    nameEn: 'Gloss only',
    desc: '生词不加任何标记，只在词后显示译文',
    mark: { background: '', color: '', underline: 'none', underlineColor: '' },
    card: lightCard,
    translation: { mode: 'after' },
  },
  {
    id: 'bold-accent',
    name: '粗体强调',
    nameEn: 'Bold accent',
    desc: '加粗 + 赭石色文字（会让单词略变宽）',
    mark: { background: '', color: '#c2410c', underline: 'none', underlineColor: '', fontWeight: 'bold' },
    card: { ...lightCard, accent: '#c2410c' },
  },
  {
    id: 'soft-tint',
    name: '柔和底色',
    nameEn: 'Soft tint',
    desc: '很淡的杏色圆角底，长时间阅读不累眼',
    mark: { background: 'rgba(251, 146, 60, 0.18)', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#c2410c' },
  },
  {
    id: 'dark-friendly',
    name: '暗色模式友好',
    nameEn: 'Dark-mode friendly',
    desc: '青绿浅底 + 点线，深浅色网页都清楚',
    mark: { background: 'rgba(45, 212, 191, 0.2)', color: '', underline: 'dotted', underlineColor: '#14b8a6', underlineThickness: 2, underlineOffset: 3 },
    card: { ...lightCard, accent: '#0f766e' },
  },
  {
    id: 'pill',
    name: '胶囊',
    nameEn: 'Pill',
    desc: '淡紫色圆角胶囊，留白不挤占排版',
    mark: { background: 'rgba(139, 92, 246, 0.2)', backgroundKind: 'pill', color: '', underline: 'none', underlineColor: '' },
    card: { ...lightCard, accent: '#6d28d9' },
  },
  {
    id: 'dashed-box',
    name: '虚线框',
    nameEn: 'Dashed box',
    desc: '青色虚线圆角框，不改文字颜色',
    mark: { background: '', color: '', underline: 'none', underlineColor: '', border: 'dashed', borderColor: '#0d9488' },
    card: { ...lightCard, accent: '#0f766e' },
  },
  {
    id: 'double-underline',
    name: '双下划线',
    nameEn: 'Double underline',
    desc: '紫色细双线，和链接的单下划线区分开',
    mark: { background: '', color: '', underline: 'solid', underlineDouble: true, underlineColor: '#8b5cf6', underlineThickness: 1, underlineOffset: 2 },
    card: { ...lightCard, accent: '#6d28d9' },
  },
  {
    id: 'ruby-gloss',
    name: '词上注释',
    nameEn: 'Ruby gloss',
    desc: '琥珀点线 + 单词上方小字释义',
    mark: { background: '', color: '', underline: 'dotted', underlineColor: '#d97706', underlineThickness: 2, underlineOffset: 3 },
    card: { ...lightCard, accent: '#b45309' },
    translation: { mode: 'ruby' },
  },
  {
    id: 'quiz-blur',
    name: '模糊自测',
    nameEn: 'Blur quiz',
    desc: '译文模糊，先想再点开核对',
    mark: { background: '', color: '', underline: 'dashed', underlineColor: '#8b5cf6', underlineThickness: 1.5, underlineOffset: 3 },
    card: { ...lightCard, accent: '#6d28d9' },
    translation: { mode: 'after', blur: true },
  },
  {
    id: 'italic-dotted',
    name: '斜体点线',
    nameEn: 'Italic dotted',
    desc: '斜体 + 灰绿点线，书卷气、最安静',
    mark: { background: '', color: '', underline: 'dotted', underlineColor: '#65a30d', underlineThickness: 1.5, underlineOffset: 3, italic: true },
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

/** v5 组合样式预设 id（预设画廊推荐展示的一组，按展示顺序） */
export const V5_PRESET_IDS: readonly string[] = [
  'highlighter',
  'wavy-line',
  'underline-gloss',
  'gloss-only',
  'bold-accent',
  'soft-tint',
  'dark-friendly',
  'pill',
  'dashed-box',
  'double-underline',
  'ruby-gloss',
  'quiz-blur',
  'italic-dotted',
];

/** 行内译文样式缺省值（按模式区分：词后括注较大、ruby 注解较小） */
export const TRANSLATION_STYLE_DEFAULTS = {
  color: '',
  opacity: { after: 0.58, ruby: 0.7, hover: 1 },
  fontScale: { after: 0.88, ruby: 0.55, hover: 0.8 },
} as const;

export function findTheme(id: string): HighlightTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}
