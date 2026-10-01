<script setup lang="ts">
import { computed } from 'vue';
import { formatHexAlpha, parseColor } from '@/ui/color';

/**
 * 颜色选择：系统取色器（RGB）+ 透明度滑块 + 文本输入（可填任意 CSS 颜色）。
 * 输出统一为 #RRGGBB 或 #RRGGBBAA；allowEmpty 时可清空（表示继承页面颜色）。
 */
const model = defineModel<string>({ required: true });
const props = defineProps<{ label: string; allowEmpty?: boolean }>();

const parsed = computed(() => parseColor(model.value));
const hex = computed(() => parsed.value?.hex ?? '#000000');
const alpha = computed(() => Math.round((parsed.value?.alpha ?? 1) * 100));

function onPick(e: Event) {
  model.value = formatHexAlpha((e.target as HTMLInputElement).value, (parsed.value?.alpha ?? 1));
}
function onAlpha(e: Event) {
  model.value = formatHexAlpha(hex.value, Number((e.target as HTMLInputElement).value) / 100);
}
</script>

<template>
  <div class="color-field">
    <span class="label">{{ label }}</span>
    <label class="swatch" :style="{ '--c': model || 'transparent' }" :class="{ empty: !model }">
      <input type="color" :value="hex" :aria-label="label" @input="onPick" />
    </label>
    <input
      class="alpha"
      type="range"
      min="0"
      max="100"
      :value="alpha"
      :disabled="!model"
      :aria-label="label + ' 透明度'"
      @input="onAlpha"
    />
    <input v-model.lazy="model" class="text" type="text" spellcheck="false" :placeholder="props.allowEmpty ? '继承' : ''" />
    <button v-if="props.allowEmpty && model" type="button" class="btn clear" title="清空（继承页面）" @click="model = ''">×</button>
  </div>
</template>

<style scoped>
.color-field { display: grid; grid-template-columns: 5.5em 36px 1fr 7.5em auto; align-items: center; gap: 8px; min-height: var(--tap); }
.label { color: var(--text-2); font-size: 13px; }
.swatch { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border); cursor: pointer; position: relative; overflow: hidden;
  background: linear-gradient(var(--c), var(--c)), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 10px 10px; }
.swatch.empty { background: repeating-linear-gradient(45deg, transparent 0 5px, var(--border) 5px 6px); }
.swatch input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
.alpha { width: 100%; accent-color: var(--accent); }
.text { min-height: 32px !important; padding: 4px 8px !important; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.clear { min-height: 32px; padding: 0 10px; }
@media (max-width: 480px) {
  .color-field { grid-template-columns: 5em 36px 1fr; }
  .text { grid-column: 2 / 4; }
  .clear { grid-column: 3; justify-self: end; }
}
</style>
