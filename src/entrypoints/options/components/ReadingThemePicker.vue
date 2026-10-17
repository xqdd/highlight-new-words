<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { READING_MARK_LABELS, READING_MARK_STYLES, type ReadingMarkStyle } from '@/core/reading/settings';
import ReadingPresetPicker from './ReadingPresetPicker.vue';

type ThemeMode = ReadingMarkStyle | 'mixed';
const model = defineModel<string>({ required: true });
const props = defineProps<{
  label: string;
  activeMode: ThemeMode;
  options: { value: string; label: string; mode?: ThemeMode; colors?: string[]; preview?: { mode: ReadingMarkStyle; color: string }[]; previewDark?: boolean }[];
}>();
const filter = ref<ThemeMode | 'all'>(props.activeMode);
// 浏览分类不应用主题；实际切换配置时跟随当前样式，确保选中的主题可见。
watch(() => [model.value, props.activeMode], () => { filter.value = props.activeMode; });
const filtered = computed(() => props.options.filter(option => !option.mode || filter.value === 'all' || option.mode === filter.value));
</script>

<template>
  <div class="theme-picker">
    <label class="type-filter"><span>样式类型</span><select v-model="filter" :aria-label="label + '样式类型'">
      <option value="all">全部样式</option>
      <option v-for="mode in READING_MARK_STYLES" :key="mode" :value="mode">{{ READING_MARK_LABELS[mode] }}</option>
      <option v-if="options.some(option => option.mode === 'mixed')" value="mixed">混合样式</option>
    </select></label>
    <ReadingPresetPicker v-model="model" :label="label" :options="filtered" />
  </div>
</template>

<style scoped>
.theme-picker { display: flex; flex-direction: column; gap: 12px; min-width: 0; width: 100%; }
.type-filter { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.type-filter select { flex: 1; min-width: 0; max-width: 240px; }
</style>
