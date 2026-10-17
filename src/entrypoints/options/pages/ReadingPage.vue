<script setup lang="ts">
import { computed, watch } from 'vue';
import { createDefaultReadingSettings, normalizeReadingSettings, READING_MARK_LABELS, READING_MARK_STYLES, READING_PRESETS } from '@/core/reading/settings';
import { createReadingPresetState, READING_FEATURE_PRESETS, rememberReadingEdits, selectFeatureReadingPreset, selectGlobalReadingPreset, type ReadingFeature } from '@/core/reading/presets';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingRow from '@/ui/components/SettingRow.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import AppIcon from '@/ui/components/AppIcon.vue';
import ColorRow from '../components/ColorRow.vue';
import ReadingPreview from '../components/ReadingPreview.vue';
import ReadingPresetPicker from '../components/ReadingPresetPicker.vue';
import ReadingThemePicker from '../components/ReadingThemePicker.vue';
import { useOptions } from '../lib/context';
import { READING_MARK_ITEMS, readingMarkConfig, updateReadingMark } from '@/core/reading/marking';
import { READING_MARKING_PRESETS, selectReadingMarkingPreset } from '@/core/reading/presets';

const { settings } = useOptions();
const reading = computed(() => settings.value.reading);
let applyingPreset = false;
// 同步刷新整个设置对象时采用其持久化状态，只有本页手动编辑才改写自定义快照。
// 同时追踪对象身份与正文参数：时间戳回流即使不改正文，也会更新 watch 的上一份基线。
watch(() => [settings.value, JSON.stringify(settings.value.reading)] as const, ([host], [previousHost, before]) => {
  if (!applyingPreset && host === previousHost) rememberReadingEdits(host, normalizeReadingSettings(JSON.parse(before)));
}, { flush: 'sync' });
function apply(action: () => void) {
  applyingPreset = true;
  try { action(); } finally { applyingPreset = false; }
}
const preset = computed({
  get: () => settings.value.readingPresets.global.selected,
  set: (id: string) => apply(() => selectGlobalReadingPreset(settings.value, id)),
});
const bionicOptions = computed(() => [
  ...(settings.value.readingPresets.features.bionic.selected === 'global' ? [{ value: 'global', label: '全局配置' }] : []),
  ...READING_FEATURE_PRESETS.bionic.map(p => ({ value: p.id, label: p.name })),
  { value: 'custom', label: '自定义' },
]);
function selectFeature(key: ReadingFeature, id: string) { apply(() => selectFeatureReadingPreset(settings.value, key, id)); }
function reset() {
  apply(() => {
    settings.value.reading = createDefaultReadingSettings();
    settings.value.readingPresets = createReadingPresetState();
  });
}
const markOptions = READING_MARK_STYLES.map(value => ({ value, label: READING_MARK_LABELS[value] }));
const markingOptions = computed(() => [
  ...READING_MARKING_PRESETS.map(p => {
    if (p.id === 'off') return { value: p.id, label: p.name };
    const preview = (p.id.startsWith('mixed-') ? ['verb', 'noun', 'negation', 'properNouns'] : ['verb', 'noun', 'adjective', 'adverb']).map(id => readingMarkConfig(p.settings, READING_MARK_ITEMS.find(item => item.id === id)!));
    return { value: p.id, label: p.name, mode: p.id.startsWith('mixed-') ? 'mixed' as const : p.settings.syntax.mode, colors: preview.map(style => style.color), preview, previewDark: p.id === 'dark' };
  }),
  { value: 'custom', label: '自定义' },
]);
const markingMode = computed(() => {
  const modes = new Set(READING_MARK_ITEMS.filter(item => readingMarkConfig(reading.value, item).enabled).map(item => readingMarkConfig(reading.value, item).mode));
  return modes.size > 1 ? 'mixed' as const : modes.values().next().value ?? reading.value.syntax.mode;
});
</script>

<template>
  <div class="reading-page">
  <p class="reading-intro"><strong>母语式阅读</strong><span>直接读英文，让理解跟上原文。</span></p>
  <ReadingPreview :settings="reading" />
  <SettingsSection id="reading" title="原文阅读" description="通过词首加粗、词性配色和逻辑线索，辅助阅读英文原文。">
    <div class="master-row">
      <ToggleSwitch v-model="reading.enabled" label="开启原文阅读" />
      <button type="button" class="btn icon-btn" aria-label="重置原文阅读" title="重置原文阅读" @click="reset"><AppIcon name="undo" :size="18" /></button>
    </div>
    <SettingRow label="阅读预设" stack>
      <ReadingPresetPicker v-model="preset" label="阅读预设" :options="[...READING_PRESETS.map(p => ({ value: p.id, label: p.name })), { value: 'custom', label: '自定义' }]" />
    </SettingRow>
    <SettingRow label="生词与阅读样式重叠时" stack>
      <select v-model="reading.wordStylePriority" aria-label="生词与阅读样式优先级"><option value="reading">阅读样式优先，保留译文与查词</option><option value="vocabulary">生词样式优先</option></select>
    </SettingRow>
  </SettingsSection>

  <SettingsSection id="reading-syntax" title="词性与语义标记">
    <SettingRow label="标记主题" stack><ReadingThemePicker label="标记预设" :model-value="settings.readingPresets.marking.selected" :active-mode="markingMode" :options="markingOptions" @update:model-value="apply(() => selectReadingMarkingPreset(settings, $event))" /></SettingRow>
    <details class="mark-details">
      <summary>具体标记配置</summary>
      <div v-for="item in READING_MARK_ITEMS" :key="item.id" class="emphasis-setting" :data-mark="item.id">
        <ToggleSwitch :model-value="readingMarkConfig(reading, item).enabled" :label="item.label" @update:model-value="updateReadingMark(reading, item, { enabled: $event })" />
        <div class="color-fields">
          <SettingRow :label="item.label + '样式'" stack><select :value="readingMarkConfig(reading, item).mode" :aria-label="item.label + '标记样式'" @change="updateReadingMark(reading, item, { mode: ($event.target as HTMLSelectElement).value as typeof reading.syntax.mode })"><option v-for="option in markOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></SettingRow>
          <SettingRow :label="item.label + '颜色'" stack><ColorRow :model-value="readingMarkConfig(reading, item).color" :label="item.label + '颜色'" @update:model-value="updateReadingMark(reading, item, { color: $event })" /></SettingRow>
        </div>
      </div>
    </details>
  </SettingsSection>

  <SettingsSection id="reading-bionic" title="仿生阅读" description="词首加粗（Bionic Reading）：突出单词前部，形成视觉锚点。">
    <SettingRow label="词首加粗预设" stack><ReadingPresetPicker label="词首加粗预设" :model-value="settings.readingPresets.features.bionic.selected" :options="bionicOptions" @update:model-value="selectFeature('bionic', $event)" /></SettingRow>
    <ToggleSwitch v-model="reading.bionic.enabled" label="开启词首加粗" />
    <template v-if="reading.bionic.enabled">
      <SettingRow label="加粗强度" stack><SegmentedControl v-model="reading.bionic.intensity" :options="[{value:'light',label:'轻'},{value:'medium',label:'中'},{value:'strong',label:'重'}]" /></SettingRow>
      <SettingRow label="强调间隔" stack><select v-model.number="reading.bionic.interval" aria-label="强调间隔"><option v-for="n in 5" :key="n" :value="n">每 {{ n }} 个英文单词强调 1 个</option></select></SettingRow>
      <SettingRow label="加粗比例" stack><label class="range"><input v-model.number="reading.bionic.ratio" aria-label="加粗比例" type="range" min="0.2" max="0.8" step="0.05" /><output>{{ Math.round(reading.bionic.ratio * 100) }}%</output></label></SettingRow>
      <SettingRow label="最短单词长度"><input v-model.number="reading.bionic.minLength" aria-label="最短单词长度" type="number" min="3" max="12" step="1" /></SettingRow>
    </template>
  </SettingsSection>

  <SettingsSection id="reading-phrases" title="短语释义">
    <ToggleSwitch v-model="reading.phrases.enabled" label="选区短语释义" />
  </SettingsSection>
  </div>
</template>

<style scoped>
.reading-page { display: flex; flex-direction: column; gap: 20px; }
.reading-intro { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0 0 12px; color: var(--text-2); font-size: 14px; }
.reading-intro strong { color: var(--text); font-size: 16px; }
.reading-page :deep(.section) { background: transparent; border: 0; border-top: 2px solid var(--border); border-radius: 0; box-shadow: none; padding: 24px 0 8px; }
.reading-page :deep(.section:first-child) { padding-top: 0; }
.reading-page :deep(.section:last-child) { border-bottom: 0; }
/* 定位配置项时给吸顶预览留出空间，避免控件滚到预览背后。 */
.reading-page :deep(.section), .reading-page :deep(button), .reading-page :deep(input), .reading-page :deep(select), .reading-page summary { scroll-margin-top: 380px; }
.master-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.icon-btn { width: 36px; height: 36px; padding: 6px; flex: 0 0 auto; }
.details { display: flex; flex-direction: column; gap: 12px; }
.emphasis-setting { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; border-bottom: 1px solid var(--border); }
.emphasis-setting:last-child { border-bottom: 0; }
.mark-details { border-top: 1px solid var(--border); }
.mark-details > summary { cursor: pointer; padding: 16px 0; font-size: 14px; color: var(--text-2); }
.mark-details > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.color-fields { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 12px; }
.checks { display: flex; flex-wrap: wrap; gap: 12px 20px; }
.checks label { display: flex; align-items: center; gap: 6px; min-height: 32px; }
.range { display: flex; align-items: center; gap: 12px; width: 100%; }
.range input { flex: 1; min-width: 0; }
output { width: 52px; flex: 0 0 auto; text-align: right; font-variant-numeric: tabular-nums; }
input[type='number'] { width: 96px; max-width: 100%; }
</style>
