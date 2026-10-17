export type ReadingMarkStyle = 'color' | 'underline' | 'dotted' | 'wavy' | 'background' | 'marker' | 'bold';
export const SYNTAX_KINDS = ['verb', 'noun', 'adjective', 'adverb', 'pronoun', 'determiner', 'preposition', 'conjunction', 'numeral', 'interjection', 'particle'] as const;
export type ReadingPartOfSpeech = typeof SYNTAX_KINDS[number];
export const SYNTAX_LABELS: Record<ReadingPartOfSpeech, string> = {
  verb: '动词', noun: '名词', adjective: '形容词', adverb: '副词', pronoun: '代词', determiner: '限定词 / 冠词',
  preposition: '介词', conjunction: '连词', numeral: '数词 / 序数词', interjection: '感叹词', particle: '小品词 / 不定式标记',
};
export const READING_MARK_STYLES: readonly ReadingMarkStyle[] = ['color', 'underline', 'dotted', 'wavy', 'background', 'marker', 'bold'];
export const READING_MARK_LABELS: Record<ReadingMarkStyle, string> = {
  color: '文字颜色', underline: '实线', dotted: '点线', wavy: '波浪线', background: '浅色底', marker: '荧光笔', bold: '彩色加粗',
};
export const EMPHASIS_KINDS = ['negation', 'connectives', 'numbers', 'properNouns'] as const;
export type ReadingEmphasisKind = typeof EMPHASIS_KINDS[number];
export type ReadingEmphasisStyles = Record<ReadingEmphasisKind, { mode: ReadingMarkStyle; color: string }>;

/** 阅读辅助只使用本地规则；总开关关闭时保留个人偏好。 */
export interface ReadingSettings {
  enabled: boolean;
  wordStylePriority: 'reading' | 'vocabulary';
  scope: { skipShortBlocks: boolean; minWords: number; skipStandaloneLinks: boolean; skipHeadings: boolean; skipTables: boolean; skipButtons: boolean; skipNavigation: boolean; skipMetadata: boolean };
  bionic: { enabled: boolean; ratio: number; minLength: number; intensity: 'light' | 'medium' | 'strong'; interval: number };
  syntax: {
    enabled: boolean; verbs: boolean; nouns: boolean; adjectives: boolean; adverbs: boolean;
    pronouns: boolean; determiners: boolean; prepositions: boolean; conjunctions: boolean; numerals: boolean; interjections: boolean; particles: boolean;
    colors: Record<ReadingPartOfSpeech, string>;
    mode: ReadingMarkStyle;
    modes: Partial<Record<ReadingPartOfSpeech, ReadingMarkStyle>>;
  };
  emphasis: { negation: boolean; connectives: boolean; numbers: boolean; properNouns: boolean; styles: ReadingEmphasisStyles };
  phrases: { enabled: boolean };
}

export function createDefaultReadingSettings(): ReadingSettings {
  return {
    enabled: false,
    wordStylePriority: 'reading',
    scope: { skipShortBlocks: true, minWords: 3, skipStandaloneLinks: true, skipHeadings: false, skipTables: false, skipButtons: true, skipNavigation: true, skipMetadata: true },
    bionic: { enabled: false, ratio: 0.5, minLength: 4, intensity: 'medium', interval: 1 },
    syntax: { enabled: false, verbs: true, nouns: true, adjectives: true, adverbs: true,
      pronouns: true, determiners: true, prepositions: true, conjunctions: true, numerals: true, interjections: true, particles: true,
      colors: { verb: '#2563eb', noun: '#15803d', adjective: '#a16207', adverb: '#be185d', pronoun: '#0e7490', determiner: '#6d28d9', preposition: '#9f1239', conjunction: '#475569', numeral: '#3f6212', interjection: '#a21caf', particle: '#155e75' }, mode: 'underline', modes: {} },
    emphasis: { negation: false, connectives: false, numbers: false, properNouns: false, styles: {
      negation: { mode: 'bold', color: '#b91c1c' }, connectives: { mode: 'underline', color: '#1d4ed8' },
      numbers: { mode: 'dotted', color: '#047857' }, properNouns: { mode: 'marker', color: '#7e22ce' },
    } },
    phrases: { enabled: false },
  };
}

/** 白名单重建设置，避免备份中的非法类型、无限数值和 CSS 字符串进入网页样式。 */
export function normalizeReadingSettings(raw: unknown): ReadingSettings {
  const defaults = createDefaultReadingSettings();
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const value = object(raw);
  const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
  const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  const b = object(value.bionic), s = object(value.syntax), colors = object(s.colors), e = object(value.emphasis), scope = object(value.scope);
  const validColor = (v: unknown, fallback: string) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : fallback;
  const validMode = (v: unknown, fallback: ReadingMarkStyle) => READING_MARK_STYLES.includes(v as ReadingMarkStyle) ? v as ReadingMarkStyle : fallback;
  const styles = object(e.styles);
  return {
    enabled: bool(value.enabled, defaults.enabled),
    wordStylePriority: value.wordStylePriority === 'vocabulary' ? 'vocabulary' : 'reading',
    scope: {
      skipShortBlocks: bool(scope.skipShortBlocks, defaults.scope.skipShortBlocks),
      minWords: Math.round(number(scope.minWords, defaults.scope.minWords, 2, 50)),
      skipStandaloneLinks: bool(scope.skipStandaloneLinks, defaults.scope.skipStandaloneLinks),
      skipHeadings: bool(scope.skipHeadings, defaults.scope.skipHeadings),
      skipTables: bool(scope.skipTables, defaults.scope.skipTables),
      skipButtons: bool(scope.skipButtons, defaults.scope.skipButtons),
      skipNavigation: bool(scope.skipNavigation, defaults.scope.skipNavigation),
      skipMetadata: bool(scope.skipMetadata, defaults.scope.skipMetadata),
    },
    bionic: { enabled: bool(b.enabled, false), ratio: number(b.ratio, 0.5, 0.2, 0.8), minLength: Math.round(number(b.minLength, 4, 3, 12)), intensity: b.intensity === 'light' || b.intensity === 'strong' ? b.intensity : 'medium', interval: Math.round(number(b.interval, 1, 1, 5)) },
    syntax: {
      enabled: bool(s.enabled, false), verbs: bool(s.verbs, true), nouns: bool(s.nouns, true), adjectives: bool(s.adjectives, true), adverbs: bool(s.adverbs, true),
      pronouns: bool(s.pronouns, true), determiners: bool(s.determiners, true), prepositions: bool(s.prepositions, true), conjunctions: bool(s.conjunctions, true), numerals: bool(s.numerals, true), interjections: bool(s.interjections, true), particles: bool(s.particles, true),
      mode: validMode(s.mode, defaults.syntax.mode),
      modes: Object.fromEntries(SYNTAX_KINDS.filter(key => READING_MARK_STYLES.includes(object(s.modes)[key] as ReadingMarkStyle)).map(key => [key, object(s.modes)[key]])),
      colors: Object.fromEntries(Object.entries(defaults.syntax.colors).map(([key, fallback]) => [key, validColor(colors[key], fallback)])) as ReadingSettings['syntax']['colors'],
    },
    emphasis: { negation: bool(e.negation, false), connectives: bool(e.connectives, false), numbers: bool(e.numbers, false), properNouns: bool(e.properNouns, false),
      styles: Object.fromEntries(EMPHASIS_KINDS.map(key => {
        const style = object(styles[key]), fallback = defaults.emphasis.styles[key];
        return [key, { mode: validMode(style.mode, fallback.mode), color: validColor(style.color, fallback.color) }];
      })) as ReadingEmphasisStyles,
    },
    phrases: { enabled: bool(object(value.phrases).enabled, false) },
  };
}

/** 词性与四类强调共用一套配色；强调是否开启仍由各自开关决定。 */
function syntaxTheme(id: string, name: string, mode: ReadingMarkStyle, colors: readonly [string, string, string, string]) {
  // 新增词类取色板内的混合色，使完整词类配色跟随同一主题，而非固定复用一组颜色。
  const extras = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3], [0, 1, 2, 3]].map(indices => '#' + [1, 3, 5].map(offset =>
    Math.round(indices.reduce((sum, index) => sum + parseInt(colors[index]!.slice(offset, offset + 2), 16), 0) / indices.length).toString(16).padStart(2, '0')).join(''));
  const settings = normalizeReadingSettings({ syntax: { enabled: true, mode, colors: Object.fromEntries(SYNTAX_KINDS.map((key, index) => [key, index < 4 ? colors[index] : extras[index - 4]])) } }).syntax;
  const emphasisStyles: ReadingEmphasisStyles = {
    negation: { mode, color: colors[2] },
    connectives: { mode, color: colors[0] }, numbers: { mode, color: colors[1] },
    properNouns: { mode, color: colors[3] },
  };
  return { id, name, settings, emphasisStyles };
}

/** 四个基础色扩展为完整词类配色，同一套色板覆盖七种视觉类型。 */
export const READING_THEME_PALETTES = [
  { id: 'cobalt', name: '蓝绿琥珀', colors: ['#1d4ed8', '#047857', '#92400e', '#be185d'] },
  { id: 'coral', name: '珊瑚青紫', colors: ['#b91c1c', '#0f766e', '#6d28d9', '#854d0e'] },
  { id: 'plum', name: '梅紫湖蓝', colors: ['#7e22ce', '#0e7490', '#a16207', '#be123c'] },
  { id: 'forest', name: '森林莓果', colors: ['#166534', '#9f1239', '#4338ca', '#854d0e'] },
  { id: 'ink', name: '石墨彩墨', colors: ['#334155', '#155e75', '#86198f', '#9a3412'] },
  { id: 'ruby', name: '宝石绛红', colors: ['#991b1b', '#1e40af', '#065f46', '#6b21a8'] },
  { id: 'olive', name: '橄榄靛青', colors: ['#3f6212', '#3730a3', '#9d174d', '#0f766e'] },
  { id: 'wine', name: '酒红松绿', colors: ['#881337', '#115e59', '#5b21b6', '#713f12'] },
  { id: 'muted', name: '柔和低饱和', colors: ['#526580', '#426a52', '#885c24', '#875070'] },
] as const;

/** 每组包含独立配色与标记方式；暗色组用于深色正文，其余组优先浅色背景可读性。 */
const BASE_SYNTAX_STYLE_PRESETS = [
  syntaxTheme('verbs', '低干扰', 'underline', ['#526580', '#426a52', '#885c24', '#875070']),
  syntaxTheme('structure', '柔和点线', 'dotted', ['#456a94', '#427869', '#8b6b32', '#8a5679']),
  syntaxTheme('color', '鲜明分色', 'color', ['#1d4ed8', '#047857', '#92400e', '#be185d']),
  syntaxTheme('ocean', '海洋波浪', 'wavy', ['#0369a1', '#0f766e', '#6d5b19', '#7e22ce']),
  syntaxTheme('forest', '森林浅底', 'background', ['#3f6212', '#166534', '#9f1239', '#4338ca']),
  syntaxTheme('dark', '暗色友好', 'color', ['#93c5fd', '#6ee7b7', '#fcd34d', '#f9a8d4']),
  syntaxTheme('rose', '玫瑰荧光', 'marker', ['#9d174d', '#1d4ed8', '#166534', '#6b21a8']),
  syntaxTheme('ink', '墨彩加粗', 'bold', ['#1e40af', '#065f46', '#9a3412', '#86198f']),
  syntaxTheme('amber', '琥珀线条', 'underline', ['#9a3412', '#155e75', '#3f6212', '#9d174d']),
  syntaxTheme('plum', '梅紫点线', 'dotted', ['#7e22ce', '#0e7490', '#a16207', '#be123c']),
  syntaxTheme('teal', '青绿荧光', 'marker', ['#0f766e', '#6d28d9', '#b45309', '#be185d']),
  syntaxTheme('contrast', '清晰浅底', 'background', ['#1e3a8a', '#14532d', '#7c2d12', '#831843']),
] as const;

export const SYNTAX_STYLE_PRESETS = [
  ...BASE_SYNTAX_STYLE_PRESETS,
  ...READING_MARK_STYLES.flatMap(mode => READING_THEME_PALETTES.map(palette =>
    syntaxTheme(`${mode}-${palette.id}`, `${palette.name} · ${READING_MARK_LABELS[mode]}`, mode, palette.colors)))
    .filter(theme => !BASE_SYNTAX_STYLE_PRESETS.some(existing => JSON.stringify(existing.settings) === JSON.stringify(theme.settings))),
];

/** 强调主题包含四类开关与样式；混合组为各类语义选用不同视觉通道。 */
export const EMPHASIS_STYLE_PRESETS = [
  ...READING_MARK_STYLES.flatMap(mode => READING_THEME_PALETTES.map(palette => ({
    id: `${mode}-${palette.id}`, name: `${palette.name} · ${READING_MARK_LABELS[mode]}`,
    settings: normalizeReadingSettings({ emphasis: {
      negation: true, connectives: true, numbers: true, properNouns: true,
      styles: Object.fromEntries(EMPHASIS_KINDS.map((kind, index) => [kind, { mode, color: palette.colors[index] }])),
    } }).emphasis,
  }))),
  ...READING_THEME_PALETTES.map(palette => ({
    id: `mixed-${palette.id}`, name: `${palette.name} · 混合线索`,
    settings: normalizeReadingSettings({ emphasis: {
      negation: true, connectives: true, numbers: true, properNouns: true,
      styles: {
        negation: { mode: 'bold', color: palette.colors[0] }, connectives: { mode: 'wavy', color: palette.colors[1] },
        numbers: { mode: 'dotted', color: palette.colors[2] }, properNouns: { mode: 'marker', color: palette.colors[3] },
      },
    } }).emphasis,
  })),
];

const themeById = (id: string) => SYNTAX_STYLE_PRESETS.find(p => p.id === id)!;

export const READING_PRESETS = [
  { id: 'off', name: '全关', settings: normalizeReadingSettings({ enabled: false, syntax: { enabled: false, ...Object.fromEntries(SYNTAX_KINDS.map(kind => [`${kind}s`, false])) } }) },
  { id: 'clear', name: '清爽', settings: normalizeReadingSettings({ enabled: true }) },
  { id: 'verbs', name: '动词线索', settings: normalizeReadingSettings({ enabled: true, syntax: { ...themeById('verbs').settings, ...Object.fromEntries(SYNTAX_KINDS.filter(kind => kind !== 'verb').map(kind => [`${kind}s`, false])) }, emphasis: { negation: true, connectives: true, styles: themeById('verbs').emphasisStyles } }) },
  { id: 'bionic', name: '视觉锚点', settings: normalizeReadingSettings({ enabled: true, bionic: { enabled: true } }) },
  { id: 'logic', name: '逻辑线索', settings: normalizeReadingSettings({ enabled: true, emphasis: { negation: true, connectives: true } }) },
  { id: 'facts', name: '事实扫描', settings: normalizeReadingSettings({ enabled: true, emphasis: { numbers: true, properNouns: true }, phrases: { enabled: true } }) },
  { id: 'guided', name: '轻量引导', settings: normalizeReadingSettings({ enabled: true, bionic: { enabled: true, ratio: 0.3, minLength: 5, intensity: 'light', interval: 2 }, syntax: themeById('structure').settings, emphasis: { styles: themeById('structure').emphasisStyles } }) },
  { id: 'color', name: '词性精读', settings: normalizeReadingSettings({ enabled: true, syntax: themeById('color').settings, emphasis: { negation: true, styles: themeById('color').emphasisStyles }, phrases: { enabled: true } }) },
  { id: 'dark', name: '夜间线索', settings: normalizeReadingSettings({ enabled: true, syntax: themeById('dark').settings, emphasis: { styles: themeById('dark').emphasisStyles }, bionic: { enabled: true, ratio: 0.3, intensity: 'light', interval: 3 } }) },
] as const;

export function readingPresetId(settings: ReadingSettings): string {
  return READING_PRESETS.find((preset) => JSON.stringify(preset.settings) === JSON.stringify(normalizeReadingSettings(settings)))?.id ?? 'custom';
}

/** 供内容脚本判断是否需要加载词法引擎，保持关闭状态的启动开销轻量。 */
export function isReadingVisualActive(settings: ReadingSettings): boolean {
  return settings.enabled && (settings.bionic.enabled || settings.syntax.enabled || EMPHASIS_KINDS.some(key => settings.emphasis[key]));
}
