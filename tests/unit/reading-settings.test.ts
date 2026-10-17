import { describe, expect, it } from 'vitest';
import { reactive, toRaw } from 'vue';
import { createDefaultReadingSettings, EMPHASIS_KINDS, EMPHASIS_STYLE_PRESETS, isReadingVisualActive, normalizeReadingSettings, READING_MARK_STYLES, READING_PRESETS, SYNTAX_STYLE_PRESETS, readingPresetId } from '@/core/reading/settings';
import { normalizeSettings } from '@/core/settings/migrate';
import { createDefaultSettings } from '@/core/settings/defaults';
import { createReadingPresetState, normalizeReadingPresetState, READING_FEATURES, READING_FEATURE_PRESETS, READING_MARKING_PRESETS, rememberReadingEdits, selectFeatureReadingPreset, selectGlobalReadingPreset, selectReadingMarkingPreset } from '@/core/reading/presets';
import { READING_MARK_ITEMS, readingMarkConfig, updateReadingMark } from '@/core/reading/marking';
import { mergeSyncedSettings, pickSyncedSettings } from '@/core/sync/merge';

describe('阅读设置', () => {
  it('标记范围有默认值，非法阈值和开关安全归一化', () => {
    expect(normalizeReadingSettings({}).scope).toEqual({ skipShortBlocks: true, minWords: 3, skipStandaloneLinks: true, skipHeadings: false, skipTables: false, skipButtons: true, skipNavigation: true, skipMetadata: true });
    expect(normalizeReadingSettings({ scope: { skipShortBlocks: false, minWords: 8.6, skipStandaloneLinks: false, skipHeadings: true, skipTables: true } }).scope)
      .toEqual({ skipShortBlocks: false, minWords: 9, skipStandaloneLinks: false, skipHeadings: true, skipTables: true, skipButtons: true, skipNavigation: true, skipMetadata: true });
    expect(normalizeReadingSettings({ scope: { skipButtons: false, skipNavigation: false } }).scope).toMatchObject({ skipButtons: false, skipNavigation: false });
    expect(normalizeReadingSettings({ scope: { skipButtons: 'false', skipNavigation: 0 } }).scope).toMatchObject({ skipButtons: true, skipNavigation: true });
    for (const [value, expected] of [[NaN, 3], [Infinity, 3], ['5', 3], [-1, 2], [100, 50]] as const) {
      expect(normalizeReadingSettings({ scope: { minWords: value, skipShortBlocks: 'false' } }).scope).toMatchObject({ minWords: expected, skipShortBlocks: true });
    }
  });

  it('范围自定义可持久化并在全局切换后恢复，切换标记主题不重置范围', () => {
    let host = createDefaultSettings();
    const before = normalizeReadingSettings(host.reading);
    host.reading.scope = { skipShortBlocks: false, minWords: 12, skipStandaloneLinks: false, skipHeadings: true, skipTables: true, skipButtons: false, skipNavigation: false, skipMetadata: false };
    const custom = { ...host.reading.scope };
    rememberReadingEdits(host, before);
    selectReadingMarkingPreset(host, 'ocean');
    expect(host.reading.scope).toEqual(custom);
    selectGlobalReadingPreset(host, 'bionic');
    host = normalizeSettings(JSON.parse(JSON.stringify(host)));
    selectGlobalReadingPreset(host, 'custom');
    expect(host.reading.scope).toEqual(custom);
  });

  it('统一主题覆盖十五类条目，单项配置与自定义在全局切换、序列化后保留', () => {
    let host = reactive(createDefaultSettings());
    expect(READING_MARK_ITEMS).toHaveLength(15);
    expect([...READING_PRESETS, ...READING_MARKING_PRESETS, ...Object.values(READING_FEATURE_PRESETS).flat()].some(p => p.id === 'all')).toBe(false);
    for (const theme of READING_MARKING_PRESETS.filter(p => p.id !== 'off')) {
      selectReadingMarkingPreset(host, theme.id);
      expect(READING_MARK_ITEMS.every(item => readingMarkConfig(host.reading, item).enabled)).toBe(true);
      expect(host.readingPresets.marking.selected).toBe(theme.id);
      expect(() => structuredClone(toRaw(host))).not.toThrow();
    }
    const pronoun = READING_MARK_ITEMS.find(item => item.id === 'pronoun')!;
    const connective = READING_MARK_ITEMS.find(item => item.id === 'connectives')!;
    const before = normalizeReadingSettings(host.reading);
    updateReadingMark(host.reading, pronoun, { mode: 'marker', color: '#123456' });
    updateReadingMark(host.reading, connective, { enabled: false });
    rememberReadingEdits(host, before);
    const custom = structuredClone(toRaw(host.readingPresets.marking.custom));
    selectReadingMarkingPreset(host, 'ocean');
    selectGlobalReadingPreset(host, 'clear');
    host = reactive(normalizeSettings(JSON.parse(JSON.stringify(host))));
    selectReadingMarkingPreset(host, 'custom');
    expect({ syntax: host.reading.syntax, emphasis: host.reading.emphasis }).toEqual(custom);
    expect(readingMarkConfig(host.reading, pronoun)).toMatchObject({ mode: 'marker', color: '#123456', enabled: true });
    expect(readingMarkConfig(host.reading, connective).enabled).toBe(false);
  });
  it('响应式设置切换强调组合后，整份存储快照不含嵌套Proxy', () => {
    const host = reactive(createDefaultSettings());
    selectReadingMarkingPreset(host, 'color');
    selectFeatureReadingPreset(host, 'syntax', 'color');
    selectFeatureReadingPreset(host, 'emphasis', 'off');
    expect(() => structuredClone(toRaw(host))).not.toThrow();
  });
  it('七种标记样式与四类强调都经过白名单校验，样式对象不会误激活引擎', () => {
    for (const mode of READING_MARK_STYLES) {
      const reading = normalizeReadingSettings({ syntax: { mode }, emphasis: { styles: { negation: { mode, color: '#123456' } } } });
      expect(reading.syntax.mode).toBe(mode);
      expect(reading.emphasis.styles.negation).toEqual({ mode, color: '#123456' });
    }
    const invalid = normalizeReadingSettings({ enabled: true, emphasis: { styles: { negation: { mode: 'invalid', color: 'url(test)' }, numbers: null } } });
    expect(invalid.emphasis.styles).toEqual(createDefaultReadingSettings().emphasis.styles);
    expect(isReadingVisualActive(invalid)).toBe(false);
    invalid.emphasis.numbers = true;
    expect(isReadingVisualActive(invalid)).toBe(true);
    expect(createDefaultReadingSettings().syntax).toMatchObject({ enabled: false, verbs: true, nouns: true, adjectives: true, adverbs: true });
  });

  it('主题只联动强调样式，手改与自定义恢复同时保存词性和配套样式', () => {
    let host = createDefaultSettings();
    selectReadingMarkingPreset(host, 'color');
    const savedCustom = structuredClone(host.readingPresets.features.emphasis.custom);
    const theme = SYNTAX_STYLE_PRESETS.find(p => p.id === 'ocean')!;
    selectFeatureReadingPreset(host, 'syntax', 'ocean');
    expect(host.reading.emphasis.styles).toEqual(theme.emphasisStyles);
    expect(EMPHASIS_KINDS.every(key => host.reading.emphasis[key])).toBe(true);
    expect(host.readingPresets.features.emphasis.custom).toEqual(savedCustom);
    expect(host.readingPresets.features.syntax.selected).toBe('ocean');
    expect(host.readingPresets.features.emphasis.selected).not.toBe('all');
    const before = normalizeReadingSettings(host.reading);
    host.reading.emphasis.styles.negation = { mode: 'bold', color: '#123456' };
    rememberReadingEdits(host, before);
    expect(host.readingPresets.features.syntax.selected).toBe('custom');
    expect(host.readingPresets.features.syntax.customEmphasisStyles.negation).toEqual({ mode: 'bold', color: '#123456' });
    const customSyntax = structuredClone(host.reading.syntax), customStyles = structuredClone(host.reading.emphasis.styles);
    selectFeatureReadingPreset(host, 'syntax', 'color');
    const stylesBeforeSwitch = structuredClone(host.reading.emphasis.styles);
    selectFeatureReadingPreset(host, 'emphasis', 'off');
    expect(host.reading.emphasis.styles).toEqual(stylesBeforeSwitch);
    host = normalizeSettings(JSON.parse(JSON.stringify(host)));
    selectFeatureReadingPreset(host, 'syntax', 'custom');
    expect(host.reading.syntax).toEqual(customSyntax);
    expect(host.reading.emphasis.styles).toEqual(customStyles);
    expect(EMPHASIS_KINDS.every(key => !host.reading.emphasis[key])).toBe(true);
    selectFeatureReadingPreset(host, 'emphasis', 'custom');
    expect(host.reading.emphasis.styles).toEqual(customStyles);
    expect(EMPHASIS_KINDS.every(key => host.reading.emphasis[key])).toBe(true);
  });

  it('单项切换不重算无关功能的显式自定义选中状态', () => {
    const host = createDefaultSettings();
    selectFeatureReadingPreset(host, 'bionic', 'balanced');
    expect(host.readingPresets.features.syntax.selected).toBe('custom');
    expect(host.readingPresets.features.emphasis.selected).toBe('custom');
    selectFeatureReadingPreset(host, 'emphasis', 'logic');
    expect(host.readingPresets.features.syntax.selected).toBe('custom');
    expect(host.readingPresets.features.bionic.selected).toBe('balanced');
  });
  it('词首强度与英文词间隔限制为明确档位，旧配置补齐默认', () => {
    expect(normalizeReadingSettings({ bionic: { enabled: true } }).bionic).toMatchObject({ intensity: 'medium', interval: 1 });
    expect(normalizeReadingSettings({ bionic: { intensity: 'strong', interval: 9 } }).bionic).toMatchObject({ intensity: 'strong', interval: 5 });
    expect(normalizeReadingSettings({ bionic: { intensity: 'light', interval: 2.6 } }).bionic).toMatchObject({ intensity: 'light', interval: 3 });
    expect(normalizeReadingSettings({ bionic: { intensity: 'invalid', interval: -1 } }).bionic).toMatchObject({ intensity: 'medium', interval: 1 });
    expect(normalizeReadingSettings({ bionic: { interval: NaN } }).bionic.interval).toBe(1);
  });

  it('全局组合与词性配色各不相同，文字配色在目标背景具备可读对比度', () => {
    expect(READING_PRESETS).toHaveLength(9);
    expect(new Set(READING_PRESETS.map(p => JSON.stringify(p.settings))).size).toBe(READING_PRESETS.length);
    expect(new Set(SYNTAX_STYLE_PRESETS.map(p => JSON.stringify(p.settings))).size).toBe(SYNTAX_STYLE_PRESETS.length);
    for (const mode of READING_MARK_STYLES) {
      expect(new Set(SYNTAX_STYLE_PRESETS.filter(p => p.settings.mode === mode).map(p => JSON.stringify(p.settings.colors))).size).toBeGreaterThanOrEqual(9);
      const emphasisThemes = EMPHASIS_STYLE_PRESETS.filter(p => EMPHASIS_KINDS.every(kind => p.settings.styles[kind].mode === mode));
      expect(new Set(emphasisThemes.map(p => JSON.stringify(p.settings.styles))).size).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(SYNTAX_STYLE_PRESETS.map(p => p.settings.mode))).toEqual(new Set(READING_MARK_STYLES));
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
    };
    for (const preset of SYNTAX_STYLE_PRESETS) {
      expect(['verbs', 'nouns', 'adjectives', 'adverbs'].every(key => preset.settings[key as 'verbs'])).toBe(true);
      expect(new Set(Object.values(preset.settings.colors)).size).toBeGreaterThanOrEqual(8);
      const background = luminance(preset.id === 'dark' ? '#20252a' : '#ffffff');
      for (const color of Object.values(preset.settings.colors)) {
        const foreground = luminance(color);
        expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const preset of READING_PRESETS) expect(normalizeReadingSettings(preset.settings)).toEqual(preset.settings);
  });

  it('强调视觉主题完整应用开关和样式，开关组合保留当前样式，切换后仍可恢复自定义', () => {
    let host = reactive(createDefaultSettings());
    const before = normalizeReadingSettings(host.reading);
    host.reading.emphasis.negation = true;
    host.reading.emphasis.styles.negation = { mode: 'marker', color: '#123456' };
    rememberReadingEdits(host, before);
    const custom = normalizeReadingSettings(host.reading).emphasis;
    for (const theme of EMPHASIS_STYLE_PRESETS) {
      selectFeatureReadingPreset(host, 'emphasis', theme.id);
      expect(host.reading.emphasis).toEqual(theme.settings);
      expect(host.readingPresets.features.emphasis.selected).toBe(theme.id);
      expect(() => structuredClone(toRaw(host))).not.toThrow();
      selectFeatureReadingPreset(host, 'emphasis', 'off');
      expect(host.reading.emphasis.styles).toEqual(theme.settings.styles);
      expect(EMPHASIS_KINDS.every(kind => !host.reading.emphasis[kind])).toBe(true);
    }
    host = reactive(normalizeSettings(JSON.parse(JSON.stringify(host))));
    selectFeatureReadingPreset(host, 'emphasis', 'custom');
    expect(host.reading.emphasis).toEqual(custom);
    expect(host.readingPresets.features.emphasis.selected).toBe('custom');
  });

  it('全局、功能关闭与各功能开启预设不会改写自定义快照', () => {
    for (const id of ['color', 'off']) {
      const host = createDefaultSettings();
      host.reading.bionic.ratio = 0.65;
      host.readingPresets = createReadingPresetState(host.reading);
      const custom = structuredClone(host.readingPresets);
      const enabled = id === 'color';
      selectGlobalReadingPreset(host, id);
      expect(host.reading.enabled).toBe(enabled);
      expect(host.reading.bionic.enabled).toBe(false);
      expect(host.reading.phrases.enabled).toBe(enabled);
      expect(host.reading.emphasis.negation).toBe(enabled);
      for (const key of ['enabled', 'verbs', 'nouns', 'adjectives', 'adverbs'] as const) expect(host.reading.syntax[key]).toBe(enabled);
      expect(host.readingPresets.global.selected).toBe(id);
      expect(host.readingPresets.global.custom).toEqual(custom.global.custom);
      for (const key of READING_FEATURES) {
        expect(host.readingPresets.features[key].custom).toEqual(custom.features[key].custom);
        const on = key === 'emphasis' ? 'color-cobalt' : key === 'bionic' ? 'balanced' : 'color';
        selectFeatureReadingPreset(host, key, enabled ? 'off' : on);
        selectFeatureReadingPreset(host, key, enabled ? on : 'off');
        if (key === 'bionic') expect(host.reading.bionic.enabled).toBe(enabled);
        else if (key === 'emphasis') expect(EMPHASIS_KINDS.every(kind => host.reading.emphasis[kind] === enabled)).toBe(true);
        else for (const field of ['enabled', 'verbs', 'nouns', 'adjectives', 'adverbs'] as const) expect(host.reading.syntax[field]).toBe(enabled);
        expect(host.readingPresets.features[key].selected).toBe(enabled ? on : 'off');
        expect(host.readingPresets.features[key].custom).toEqual(custom.features[key].custom);
      }
    }
  });
  it('全局自定义在切换、序列化重载及同步后都能恢复', () => {
    let host = createDefaultSettings();
    const before = normalizeReadingSettings(host.reading);
    host.reading.bionic.ratio = 0.65;
    host.reading.syntax.colors.verb = '#112233';
    rememberReadingEdits(host, before);
    const custom = normalizeReadingSettings(host.reading);
    selectGlobalReadingPreset(host, 'verbs');
    host.updatedAt = 100;
    host = normalizeSettings(JSON.parse(JSON.stringify(host)));
    const synced = mergeSyncedSettings(createDefaultSettings(), pickSyncedSettings(host));
    expect(synced).toBeDefined();
    if (!synced) throw new Error('同步设置未合并');
    selectGlobalReadingPreset(synced, 'custom');
    expect(synced.reading).toEqual(custom);
    expect(synced.readingPresets.global.selected).toBe('custom');
  });

  it('所有功能预设都能来回切换，并独立恢复自定义', () => {
    for (const key of READING_FEATURES) {
      let host = createDefaultSettings();
      const before = normalizeReadingSettings(host.reading);
      // 每个功能取第二个有效预设作为用户自定义的示例值，再记为手动修改。
      Object.assign(host.reading, { [key]: normalizeReadingSettings({ [key]: READING_FEATURE_PRESETS[key][1]!.settings })[key] });
      rememberReadingEdits(host, before);
      const custom = normalizeReadingSettings(host.reading)[key];
      const otherSnapshots = READING_FEATURES.map(feature => structuredClone(host.readingPresets.features[feature].custom));
      for (const preset of READING_FEATURE_PRESETS[key]) {
        selectFeatureReadingPreset(host, key, preset.id);
        expect(host.reading[key]).toEqual(preset.settings);
        host = normalizeSettings(JSON.parse(JSON.stringify(host)));
      }
      selectFeatureReadingPreset(host, key, 'custom');
      expect(host.reading[key]).toEqual(custom);
      expect(READING_FEATURES.map(feature => host.readingPresets.features[feature].custom)).toEqual(otherSnapshots);
      expect(host.readingPresets.features[key].selected).toBe('custom');
    }
  });

  it('全局预设不覆盖单项快照，手动修改单项才更新对应快照', () => {
    const host = createDefaultSettings();
    host.reading.syntax.colors.verb = '#123456';
    host.readingPresets = createReadingPresetState(host.reading);
    const savedFeatures = JSON.stringify(host.readingPresets.features);
    selectGlobalReadingPreset(host, 'clear');
    expect(host.reading.syntax.colors.verb).toBe('#2563eb');
    expect(JSON.stringify(Object.fromEntries(READING_FEATURES.map(key => [key, host.readingPresets.features[key].custom])))).toBe(JSON.stringify(Object.fromEntries(READING_FEATURES.map(key => [key, JSON.parse(savedFeatures)[key].custom]))));
    // 当前功能值来自全局且不同于保存的自定义时，必须允许点击“自定义”恢复。
    host.readingPresets.features.bionic.custom.ratio = 0.65;
    selectGlobalReadingPreset(host, 'clear');
    expect(host.readingPresets.features.bionic.selected).toBe('off');
    selectFeatureReadingPreset(host, 'bionic', 'custom');
    expect(host.reading.bionic.ratio).toBe(0.65);
    selectFeatureReadingPreset(host, 'syntax', 'custom');
    expect(host.reading.syntax.colors.verb).toBe('#123456');
    selectFeatureReadingPreset(host, 'syntax', 'color');
    const before = normalizeReadingSettings(host.reading);
    host.reading.syntax.colors.verb = '#654321';
    rememberReadingEdits(host, before);
    expect(host.readingPresets.features.syntax.selected).toBe('custom');
    expect(host.readingPresets.features.syntax.custom.colors.verb).toBe('#654321');
    expect(host.readingPresets.global.selected).toBe('custom');
  });

  it('旧数据保留现有配置作为自定义，非法预设元数据仍受字段校验', () => {
    const reading = normalizeReadingSettings({ bionic: { interval: 3 }, syntax: { colors: { verb: '#456789' } } });
    expect(normalizeSettings({ reading }).readingPresets).toEqual(createReadingPresetState(reading));
    const state = normalizeReadingPresetState({ global: { selected: 'bad', custom: { enabled: 'true' } }, features: { bionic: { selected: 'strong', custom: { interval: Infinity, intensity: 'bad' } }, syntax: { selected: 'bad', custom: { colors: { verb: 'red' } } } } }, reading);
    expect(state.global.selected).toBe('custom');
    expect(state.global.custom.enabled).toBe(false);
    expect(state.features.bionic).toEqual({ selected: 'strong', custom: createDefaultReadingSettings().bionic });
    expect(state.features.syntax.custom.colors.verb).toBe('#2563eb');
    expect(state.features.syntax.selected).toBe('custom');
  });

  it('无效预设ID不修改任何配置', () => {
    const host = createDefaultSettings();
    const before = JSON.stringify(host);
    selectGlobalReadingPreset(host, 'invalid');
    selectFeatureReadingPreset(host, 'bionic', 'invalid');
    expect(JSON.stringify(host)).toBe(before);
  });

  it('全局预设中的单项按配置识别，不受对象属性顺序影响', () => {
    const host = createDefaultSettings();
    selectGlobalReadingPreset(host, 'verbs');
    expect(host.readingPresets.features.syntax.selected).toBe('global');
    expect(host.reading.syntax).toMatchObject({ verbs: true, nouns: false, adjectives: false, adverbs: false });
    expect(host.readingPresets.features.emphasis.selected).toBe('logic');
    selectGlobalReadingPreset(host, 'bionic');
    expect(host.readingPresets.features.bionic.selected).toBe('balanced');
    selectGlobalReadingPreset(host, 'dark');
    expect(host.readingPresets.features.syntax.selected).toBe('dark');
  });
  it('旧设置补齐关闭状态，每次创建独立对象', () => {
    const first = createDefaultReadingSettings();
    expect(normalizeSettings({}).reading).toEqual(first);
    first.syntax.colors.verb = '#000000';
    expect(createDefaultReadingSettings().syntax.colors.verb).toBe('#2563eb');
  });

  it('拒绝非法类型和无限数值，约束有限数值范围', () => {
    const reading = normalizeReadingSettings({ enabled: 'true', bionic: { enabled: 1, ratio: 8, minLength: 1 },
      syntax: { mode: 'invalid', verbs: null, colors: { verb: 'url(https://example.com)', noun: '#ffffff' } },
      typography: { enabled: true, fontSize: Infinity, lineHeight: 0, maxWidth: 4000, paragraphSpacing: NaN },
      focus: { mode: 'invalid', dim: -1, rulerHeight: 0 }, speech: { rate: '2' }, phrases: { enabled: 'yes' } });
    expect(reading.enabled).toBe(false);
    expect(reading.bionic).toEqual({ enabled: false, ratio: 0.8, minLength: 3, intensity: 'medium', interval: 1 });
    expect(reading.syntax.mode).toBe('underline');
    expect(reading.syntax.verbs).toBe(true);
    expect(reading.syntax.colors).toMatchObject({ verb: '#2563eb', noun: '#ffffff' });
    expect(reading).not.toHaveProperty('typography');
    expect(reading).not.toHaveProperty('focus');
    expect(reading).not.toHaveProperty('speech');
    expect(reading.phrases.enabled).toBe(false);
  });

  it('畸形子对象及数组回退默认值', () => {
    for (const raw of [null, false, [], { syntax: [], bionic: null, focus: 'ruler', typography: 1 }]) {
      expect(normalizeReadingSettings(raw)).toEqual(createDefaultReadingSettings());
    }
  });

  it('预设可复制编辑，不污染内置预设；修改后识别为自定义', () => {
    for (const preset of READING_PRESETS) {
      const reading = normalizeReadingSettings(preset.settings);
      expect(readingPresetId(reading)).toBe(preset.id);
      reading.bionic.interval = 5;
      expect(readingPresetId(reading)).toBe('custom');
      expect(preset.settings.bionic.interval).not.toBe(5);
    }
  });

  it('同步与备份使用的设置载荷保留自定义阅读参数，合并仍保留本机同步配置', () => {
    const local = createDefaultSettings();
    local.sync.enabled = true;
    const remote = createDefaultSettings();
    remote.updatedAt = 100;
    remote.reading = normalizeReadingSettings({ enabled: true, syntax: { enabled: true, colors: { verb: '#123456' } }, bionic: { interval: 3, intensity: 'strong' }, phrases: { enabled: true } });
    const payload = JSON.parse(JSON.stringify(pickSyncedSettings(remote)));
    const merged = mergeSyncedSettings(local, payload)!;
    expect(merged.reading).toEqual(remote.reading);
    expect(merged.sync.enabled).toBe(true);
    expect(normalizeSettings(payload).reading).toEqual(remote.reading);
  });
});
