<script setup lang="ts">
import AppIcon from '@/ui/components/AppIcon.vue';
import type { CSSProperties } from 'vue';
import type { ReadingMarkStyle } from '@/core/reading/settings';
const model = defineModel<string>({ required: true });
const props = defineProps<{ label: string; options: { value: string; label: string; colors?: string[]; preview?: { mode: ReadingMarkStyle; color: string }[]; previewDark?: boolean }[] }>();
function previewStyle(mode: ReadingMarkStyle, color: string): CSSProperties {
  if (mode === 'color') return { color };
  if (mode === 'bold') return { WebkitTextStroke: `0.35px ${color}` };
  if (mode === 'background') return { backgroundColor: `${color}33` };
  if (mode === 'marker') return { backgroundImage: `linear-gradient(transparent 55%, ${color}55 55%, ${color}55 95%, transparent 95%)` };
  return { textDecorationLine: 'underline', textDecorationStyle: mode === 'underline' ? 'solid' : mode, textDecorationColor: color, textUnderlineOffset: '3px' };
}
function move(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next = (index + offset + props.options.length) % props.options.length;
  model.value = props.options[next]!.value;
  const group = (event.currentTarget as HTMLElement).parentElement;
  (group?.children[next] as HTMLButtonElement)?.focus();
}
</script>

<template>
  <div class="preset-grid" role="radiogroup" :aria-label="label">
    <button v-for="(option, index) in options" :key="option.value" type="button" role="radio" :aria-label="option.label" :aria-checked="model === option.value" :tabindex="model === option.value || (!options.some(item => item.value === model) && index === 0) ? 0 : -1" @click="model = option.value" @keydown="move($event, index)">
      <span class="preset-name">{{ option.label }}</span>
      <AppIcon name="check" :size="16" class="selected-check" :class="{ selected: model === option.value }" />
      <span v-if="option.colors" class="swatches" aria-hidden="true"><i v-for="(color, colorIndex) in option.colors" :key="colorIndex" :style="{ background: color }" /></span>
      <span v-if="option.preview" class="style-preview" :class="{ dark: option.previewDark }" aria-hidden="true"><span v-for="(style, sampleIndex) in option.preview" :key="sampleIndex" :style="previewStyle(style.mode, style.color)">{{ ['Read', 'words', 'with', 'clarity'][sampleIndex] }}</span></span>
    </button>
  </div>
</template>

<style scoped>
.preset-grid { display: grid; width: 100%; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: 8px; }
button { display: grid; grid-template-columns: minmax(0, 1fr) 16px; align-items: center; gap: 6px; min-height: 44px; padding: 9px 12px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; text-align: left; font: inherit; font-size: 13px; }
button[aria-checked='true'] { border-color: var(--accent); background: var(--accent-soft); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.preset-name { overflow-wrap: anywhere; }
.selected-check { opacity: 0; color: var(--accent); }
.selected-check.selected { opacity: 1; }
.swatches { display: flex; gap: 5px; grid-column: 1 / -1; }
.swatches i { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 1px #0002; }
.style-preview { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; min-height: 22px; line-height: 1.7; color: var(--text); font-size: 12px; }
.style-preview.dark { background: #20252a; color: #f1f5f9; padding-inline: 4px; border-radius: 2px; }
</style>
