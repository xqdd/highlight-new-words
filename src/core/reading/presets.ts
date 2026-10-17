import { createDefaultReadingSettings, EMPHASIS_KINDS, EMPHASIS_STYLE_PRESETS, normalizeReadingSettings, READING_PRESETS, SYNTAX_STYLE_PRESETS, type ReadingEmphasisStyles, type ReadingSettings } from './settings';

export const READING_FEATURES = ['bionic', 'syntax', 'emphasis'] as const;
export type ReadingFeature = typeof READING_FEATURES[number];
type FeaturePresetState = { [K in ReadingFeature]: { selected: string; custom: ReadingSettings[K] } };
/** 预设状态独立于渲染设置存储，切换预设不能覆盖之前保存的自定义。 */
export interface ReadingPresetState {
  global: { selected: string; custom: ReadingSettings };
  marking: { selected: string; custom: Pick<ReadingSettings, 'syntax' | 'emphasis'> };
  features: FeaturePresetState & { syntax: { customEmphasisStyles: ReadingEmphasisStyles } };
}
export interface ReadingPresetHost { reading: ReadingSettings; readingPresets: ReadingPresetState }

const base = createDefaultReadingSettings();
export const READING_FEATURE_PRESETS = {
  bionic: [
    { id: 'off', name: '全关', settings: { ...base.bionic, enabled: false } },
    { id: 'light', name: '轻量锚点', settings: { enabled: true, ratio: 0.3, minLength: 5, intensity: 'light' as const, interval: 2 } },
    { id: 'balanced', name: '均衡锚点', settings: { enabled: true, ratio: 0.5, minLength: 4, intensity: 'medium' as const, interval: 1 } },
    { id: 'strong', name: '强化锚点', settings: { enabled: true, ratio: 0.7, minLength: 3, intensity: 'strong' as const, interval: 1 } },
  ],
  syntax: [
    { id: 'off', name: '全关', settings: { ...base.syntax, enabled: false, verbs: false, nouns: false, adjectives: false, adverbs: false } },
    ...SYNTAX_STYLE_PRESETS,
  ],
  emphasis: [
    { id: 'off', name: '全关', switchesOnly: true, settings: { ...base.emphasis, negation: false, connectives: false, numbers: false, properNouns: false } },
    { id: 'logic', name: '逻辑线索', switchesOnly: true, settings: { ...base.emphasis, negation: true, connectives: true } },
    { id: 'facts', name: '事实线索', switchesOnly: true, settings: { ...base.emphasis, numbers: true, properNouns: true } },
    ...EMPHASIS_STYLE_PRESETS,
  ],
} satisfies { [K in ReadingFeature]: readonly { id: string; name: string; settings: ReadingSettings[K]; switchesOnly?: boolean }[] };

/** 统一主题一次应用所有词性和语义项，条目仍可单独关闭或覆盖样式。 */
export const READING_MARKING_PRESETS = [
  { id: 'off', name: '全关', settings: normalizeReadingSettings({ syntax: { ...base.syntax, enabled: false }, emphasis: base.emphasis }) },
  ...SYNTAX_STYLE_PRESETS.map(theme => ({ id: theme.id, name: theme.name, settings: normalizeReadingSettings({
    syntax: theme.settings,
    emphasis: { negation: true, connectives: true, numbers: true, properNouns: true, styles: theme.emphasisStyles },
  }) })),
  ...EMPHASIS_STYLE_PRESETS.filter(theme => theme.id.startsWith('mixed-')).map(theme => {
    const syntax = SYNTAX_STYLE_PRESETS.find(p => p.settings.mode === 'color' && p.settings.colors.verb === theme.settings.styles.negation.color && p.settings.colors.noun === theme.settings.styles.connectives.color)!.settings;
    return { id: theme.id, name: theme.name, settings: normalizeReadingSettings({ syntax, emphasis: theme.settings }) };
  }),
];

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createReadingPresetState(reading = createDefaultReadingSettings()): ReadingPresetState {
  const custom = normalizeReadingSettings(reading);
  const features = Object.fromEntries(READING_FEATURES.map(key => [key, { selected: 'custom', custom: normalizeReadingSettings(custom)[key] }])) as ReadingPresetState['features'];
  features.syntax.customEmphasisStyles = normalizeReadingSettings(custom).emphasis.styles;
  return {
    global: { selected: 'custom', custom },
    marking: { selected: 'custom', custom: { syntax: custom.syntax, emphasis: custom.emphasis } },
    features,
  };
}

export function normalizeReadingPresetState(raw: unknown, reading: ReadingSettings): ReadingPresetState {
  const value = object(raw), global = object(value.global), features = object(value.features);
  const state = createReadingPresetState(reading);
  const marking = object(value.marking);
  state.marking.selected = READING_MARKING_PRESETS.some(p => p.id === marking.selected) ? marking.selected as string : 'custom';
  if (marking.custom) {
    const custom = normalizeReadingSettings(marking.custom);
    state.marking.custom = { syntax: custom.syntax, emphasis: custom.emphasis };
  } else if (object(features.syntax).custom || object(features.emphasis).custom) {
    // 合并入口时继承用户已有的两组自定义，避免升级后只保留当前预设。
    const syntax = object(features.syntax), emphasis = object(features.emphasis);
    const custom = normalizeReadingSettings({ syntax: syntax.custom ?? reading.syntax, emphasis: emphasis.custom ?? reading.emphasis });
    if (syntax.customEmphasisStyles) custom.emphasis.styles = normalizeReadingSettings({ emphasis: { styles: syntax.customEmphasisStyles } }).emphasis.styles;
    state.marking.custom = { syntax: custom.syntax, emphasis: custom.emphasis };
  }
  state.global.selected = READING_PRESETS.some(p => p.id === global.selected) ? global.selected as string : 'custom';
  if (global.custom && typeof global.custom === 'object' && !Array.isArray(global.custom)) state.global.custom = normalizeReadingSettings(global.custom);
  for (const key of READING_FEATURES) {
    const feature = object(features[key]);
    state.features[key].selected = feature.selected === 'global' || READING_FEATURE_PRESETS[key].some(p => p.id === feature.selected) ? feature.selected as string : 'custom';
    if (feature.custom && typeof feature.custom === 'object' && !Array.isArray(feature.custom)) {
      Object.assign(state.features[key], { custom: normalizeReadingSettings({ [key]: feature.custom })[key] });
    }
  }
  const syntax = object(features.syntax);
  if (syntax.customEmphasisStyles && typeof syntax.customEmphasisStyles === 'object' && !Array.isArray(syntax.customEmphasisStyles)) {
    state.features.syntax.customEmphasisStyles = normalizeReadingSettings({ emphasis: { styles: syntax.customEmphasisStyles } }).emphasis.styles;
  }
  return state;
}

/** 全关与场景组合只匹配开关；视觉主题必须连同配色和样式完整匹配。 */
function matchesFeature(host: ReadingPresetHost, key: ReadingFeature, preset: { settings: unknown; emphasisStyles?: ReadingEmphasisStyles; switchesOnly?: boolean }): boolean {
  const expected = normalizeReadingSettings({ [key]: preset.settings });
  if (key === 'emphasis' && preset.switchesOnly) return EMPHASIS_KINDS.every(kind => expected.emphasis[kind] === host.reading.emphasis[kind]);
  return equal(expected[key], host.reading[key]) && (!preset.emphasisStyles || equal(preset.emphasisStyles, host.reading.emphasis.styles));
}

function refreshFeatureSelections(host: ReadingPresetHost, keys: readonly ReadingFeature[] = READING_FEATURES): void {
  for (const key of keys) {
    const feature = host.readingPresets.features[key];
    const matches = READING_FEATURE_PRESETS[key].filter(p => matchesFeature(host, key, p));
    const matchesCustom = equal(feature.custom, host.reading[key]) && (key !== 'syntax' || equal(host.readingPresets.features.syntax.customEmphasisStyles, host.reading.emphasis.styles));
    feature.selected = matches.find(p => p.id === host.readingPresets.global.selected)?.id ?? matches.find(p => p.id !== 'off')?.id ?? matches[0]?.id ?? (matchesCustom ? 'custom' : 'global');
  }
}

export function selectGlobalReadingPreset(host: ReadingPresetHost, id: string): void {
  const found = READING_PRESETS.find(p => p.id === id);
  if (!found && id !== 'custom') return;
  const state = host.readingPresets;
  if (state.global.selected === 'custom') state.global.custom = normalizeReadingSettings(host.reading);
  host.reading = normalizeReadingSettings(found?.settings ?? state.global.custom);
  state.global.selected = id;
  refreshFeatureSelections(host);
  host.readingPresets.marking.selected = READING_MARKING_PRESETS.find(p => equal(p.settings.syntax, host.reading.syntax) && equal(p.settings.emphasis, host.reading.emphasis))?.id ?? 'custom';
}

export function selectReadingMarkingPreset(host: ReadingPresetHost, id: string): void {
  const preset = READING_MARKING_PRESETS.find(p => p.id === id);
  if (!preset && id !== 'custom') return;
  const value = normalizeReadingSettings(preset?.settings ?? host.readingPresets.marking.custom);
  host.reading.syntax = value.syntax;
  host.reading.emphasis = value.emphasis;
  host.readingPresets.marking.selected = id;
  refreshFeatureSelections(host, ['syntax', 'emphasis']);
  host.readingPresets.global.selected = 'custom';
  host.readingPresets.global.custom = normalizeReadingSettings(host.reading);
}

export function selectFeatureReadingPreset(host: ReadingPresetHost, key: ReadingFeature, id: string): void {
  const found = READING_FEATURE_PRESETS[key].find(p => p.id === id);
  if (!found && id !== 'custom') return;
  const state = host.readingPresets.features[key];
  const previousStyles = host.reading.emphasis.styles;
  const next = normalizeReadingSettings({ [key]: found?.settings ?? state.custom });
  // 归一化生成纯对象，避免把 Vue Proxy 嵌进设置原始对象，导致 storage 快照无法 structuredClone。
  if (key === 'emphasis' && found && 'switchesOnly' in found && found.switchesOnly) next.emphasis.styles = normalizeReadingSettings(host.reading).emphasis.styles;
  Object.assign(host.reading, { [key]: next[key] });
  if (key === 'syntax') {
    const pairedStyles = found && 'emphasisStyles' in found ? found.emphasisStyles : id === 'custom' ? host.readingPresets.features.syntax.customEmphasisStyles : undefined;
    if (pairedStyles) host.reading.emphasis.styles = normalizeReadingSettings({ emphasis: { styles: pairedStyles } }).emphasis.styles;
  }
  // 仅刷新真正发生样式联动的另一组，保留其他组显式选择的“自定义”。
  if (!equal(previousStyles, host.reading.emphasis.styles)) refreshFeatureSelections(host, key === 'syntax' ? ['emphasis'] : ['syntax']);
  state.selected = id;
  // 单项预设组合属于全局自定义，但不能重写其他功能的自定义快照。
  host.readingPresets.global.selected = 'custom';
  host.readingPresets.global.custom = normalizeReadingSettings(host.reading);
}

/** 手工编辑只更新确实变化的功能，避免同步和全局切换误写其他快照。 */
export function rememberReadingEdits(host: ReadingPresetHost, before: ReadingSettings): void {
  const next = normalizeReadingSettings(host.reading);
  if (equal(next, before)) return;
  if (!equal(next.syntax, before.syntax) || !equal(next.emphasis, before.emphasis)) {
    host.readingPresets.marking = { selected: 'custom', custom: { syntax: next.syntax, emphasis: next.emphasis } };
  }
  host.readingPresets.global.selected = 'custom';
  host.readingPresets.global.custom = normalizeReadingSettings(next);
  for (const key of READING_FEATURES) if (!equal(next[key], before[key])) {
    Object.assign(host.readingPresets.features[key], { selected: 'custom', custom: normalizeReadingSettings(next)[key] });
  }
  if (!equal(next.syntax, before.syntax) || !equal(next.emphasis.styles, before.emphasis.styles)) {
    Object.assign(host.readingPresets.features.syntax, { selected: 'custom', custom: normalizeReadingSettings(next).syntax, customEmphasisStyles: normalizeReadingSettings(next).emphasis.styles });
  }
}
