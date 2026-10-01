<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatHexAlpha, parseColor } from '@/ui/color';
import AppIcon from '@/ui/components/AppIcon.vue';
import { HIGHLIGHT_PALETTE } from '@/ui/components/palette';
import ColorSheet from './ColorSheet.vue';

/**
 * 取色板（对标 Burning Vocabulary 的预设色块 + Relingo 的自定义取色器）：
 * 一排预设色（点选即生效）+ “自定义”色块（打开 ColorSheet：SV 面板、色相、透明度、HEX）。
 * - alpha：值带透明度（背景色）。点预设色时保留当前透明度，当前为空或不透明时用 defaultAlpha；
 * - emptyLabel：可清空（如“不改文字色”“跟随线色”），显示为第一个斜纹色块。
 */
const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{ label: string; alpha?: boolean; defaultAlpha?: number; emptyLabel?: string }>(), { alpha: false, defaultAlpha: 1 });

const parsed = computed(() => (model.value ? parseColor(model.value) : null));
const hex = computed(() => parsed.value?.hex ?? '');
const isPreset = computed(() => HIGHLIGHT_PALETTE.some((c) => c.hex === hex.value));

function pick(c: string) {
  const a = parsed.value?.alpha;
  model.value = props.alpha ? formatHexAlpha(c, a !== undefined && a < 1 ? a : props.defaultAlpha) : c;
}
const sheetOpen = ref(false);
const sheetColor = computed({ get: () => model.value || formatHexAlpha('#ff7008', props.alpha ? props.defaultAlpha : 1), set: (c) => (model.value = c) });
</script>

<template>
  <div class="color-row" role="radiogroup" :aria-label="label">
    <button v-if="emptyLabel" type="button" role="radio" class="sw none" :aria-checked="!model" :aria-label="emptyLabel" :title="emptyLabel" @click="model = ''" />
    <button
      v-for="c in HIGHLIGHT_PALETTE"
      :key="c.hex"
      type="button"
      role="radio"
      class="sw"
      :style="{ '--c': c.hex }"
      :aria-checked="hex === c.hex"
      :aria-label="c.name"
      :title="c.name"
      @click="pick(c.hex)"
    >
      <AppIcon v-if="hex === c.hex" name="check" :size="14" />
    </button>
    <button
      type="button"
      class="sw more"
      :class="{ on: !!model && !isPreset }"
      :style="{ '--c': hex || '#ff7008' }"
      :aria-label="label + '：自定义颜色'"
      title="自定义颜色"
      @click="sheetOpen = true"
    >
      <AppIcon name="plus" :size="14" />
    </button>
    <ColorSheet v-if="sheetOpen" v-model:open="sheetOpen" v-model:color="sheetColor" :title="label" :alpha="alpha" />
  </div>
</template>

<style scoped>
.color-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(30px, 1fr)); gap: 8px; }
.sw { aspect-ratio: 1; min-height: 30px; border-radius: 50%; border: 0; background: var(--c); cursor: pointer; color: #fff; display: grid; place-items: center;
  position: relative; padding: 0; }
.sw[aria-checked='true']::after, .sw.more.on::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--c, var(--text)); }
.sw.none { background: repeating-linear-gradient(45deg, var(--surface) 0 4px, var(--border) 4px 6px); border: 1px solid var(--border); --c: var(--text-2); }
.sw.more { background: conic-gradient(#f43f5e, #f59e0b, #84cc16, #10b981, #0ea5e9, #6366f1, #d946ef, #f43f5e); }
.sw.more.on { background: var(--c); }
@media (max-width: 560px) { .color-row { grid-template-columns: repeat(7, 1fr); gap: 10px; } .sw { min-height: 34px; } }
</style>
