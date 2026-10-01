<script setup lang="ts">
import { computed, ref } from 'vue';
import { isEmptyMarkStyle } from '@/core/theme/resolve';
import type { BackgroundKind, BorderStyle, MarkFontWeight, MarkStyle, UnderlineStyle } from '@/core/theme/themes';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { BACKGROUND_ALPHA, markPrimaryColor } from '@/ui/components/palette';
import ColorRow from './ColorRow.vue';

/**
 * 生词样式编辑器（v5）：四个可组合维度——装饰线 / 文字 / 背景 / 边框，按标签页切换（手机上一次只展开一组，避免长页面）。
 * 每个选项都用真实的样式渲染缩略（MarkPreview 与内容脚本共用 markStyleToCss），所见即所得；
 * 每次修改输出一个新的完整 MarkStyle（v-model），由调用方决定写到全局 custom 还是某本词书。
 */
const model = defineModel<MarkStyle>({ required: true });
const tab = ref<'line' | 'text' | 'bg' | 'border'>('line');

function patch(p: Partial<MarkStyle>) {
  model.value = { ...model.value, ...p };
}
const m = computed(() => model.value);
/** 新开启某个维度时沿用当前主色，组合起来更协调 */
const primary = computed(() => markPrimaryColor(m.value));

// ---------- 装饰线 ----------
type LineKind = 'none' | 'solid' | 'dashed' | 'dotted' | 'wavy' | 'double';
const LINES: { value: LineKind; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' },
  { value: 'wavy', label: '波浪' },
  { value: 'double', label: '双线' },
];
const lineKind = computed<LineKind>(() => (m.value.underline === 'none' ? 'none' : m.value.underlineDouble ? 'double' : m.value.underline));
function lineStyle(k: LineKind): Partial<MarkStyle> {
  if (k === 'none') return { underline: 'none', underlineDouble: false };
  const color = m.value.underlineColor || primary.value;
  return k === 'double'
    ? { underline: 'solid', underlineDouble: true, underlineColor: color }
    : { underline: k as UnderlineStyle, underlineDouble: false, underlineColor: color };
}
const thickness = computed(() => m.value.underlineThickness ?? (m.value.underline === 'solid' && !m.value.underlineDouble ? 2 : 1.5));
const offset = computed(() => m.value.underlineOffset ?? 3);

// ---------- 文字 ----------
const WEIGHTS: { value: MarkFontWeight; label: string }[] = [
  { value: 'inherit', label: '不变' },
  { value: 'medium', label: '中粗' },
  { value: 'bold', label: '粗体' },
];

// ---------- 背景 ----------
type BgKind = 'none' | BackgroundKind;
const BGS: { value: BgKind; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'block', label: '整块' },
  { value: 'marker', label: '马克笔' },
  { value: 'pill', label: '胶囊' },
];
const bgKind = computed<BgKind>(() => (m.value.background ? (m.value.backgroundKind ?? 'block') : 'none'));
function bgStyle(k: BgKind): Partial<MarkStyle> {
  if (k === 'none') return { background: '', backgroundKind: undefined };
  // 马克笔需要更浓的颜色才看得出色带
  const bg = m.value.background || primary.value + Math.round((k === 'marker' ? 0.5 : BACKGROUND_ALPHA) * 255).toString(16).padStart(2, '0');
  return { background: bg, backgroundKind: k };
}
const bgOpacity = computed(() => m.value.backgroundOpacity ?? 1);

// ---------- 边框 ----------
const BORDERS: { value: BorderStyle; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' },
];

/** 选项缩略：在当前样式上套用该选项 */
const sample = (p: Partial<MarkStyle>): MarkStyle => ({ ...m.value, ...p });
const isEmptyStyle = computed(() => isEmptyMarkStyle(m.value));
</script>

<template>
  <div class="editor">
    <SegmentedControl
      v-model="tab"
      :options="[
        { value: 'line', label: '装饰线' },
        { value: 'text', label: '文字' },
        { value: 'bg', label: '背景' },
        { value: 'border', label: '边框' },
      ]"
    />

    <div v-if="tab === 'line'" class="pane">
      <div class="chips" role="radiogroup" aria-label="装饰线">
        <button v-for="l in LINES" :key="l.value" type="button" role="radio" class="chip" :aria-checked="lineKind === l.value" @click="patch(lineStyle(l.value))">
          <span class="chip-sample"><MarkPreview :mark="sample(lineStyle(l.value))" word="Ab" /></span>
          <span>{{ l.label }}</span>
        </button>
      </div>
      <template v-if="lineKind !== 'none'">
        <span class="lbl">线的颜色</span>
        <ColorRow :model-value="m.underlineColor" label="装饰线颜色" @update:model-value="(c: string) => patch({ underlineColor: c })" />
        <label class="slider">
          <span>粗细 {{ thickness }}px</span>
          <input type="range" min="1" max="4" step="0.5" :value="thickness" @input="patch({ underlineThickness: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <label class="slider">
          <span>与文字距离 {{ offset }}px</span>
          <input type="range" min="0" max="8" step="1" :value="offset" @input="patch({ underlineOffset: Number(($event.target as HTMLInputElement).value) })" />
        </label>
      </template>
    </div>

    <div v-else-if="tab === 'text'" class="pane">
      <span class="lbl">文字颜色</span>
      <ColorRow :model-value="m.color" label="文字颜色" empty-label="不改文字颜色" @update:model-value="(c: string) => patch({ color: c })" />
      <p v-if="m.color && !m.background && m.underline === 'none'" class="note">只改文字颜色时，链接里的生词会自动改为“保留链接色 + 同色浅底”，避免和链接混淆。</p>
      <span class="lbl">字重</span>
      <SegmentedControl :model-value="m.fontWeight ?? 'inherit'" :options="WEIGHTS" @update:model-value="(w: MarkFontWeight) => patch({ fontWeight: w === 'inherit' ? undefined : w })" />
      <p v-if="m.fontWeight === 'bold'" class="note">粗体会让单词略变宽，个别行可能换行位置不同。</p>
      <ToggleSwitch :model-value="!!m.italic" label="斜体" @update:model-value="(v: boolean) => patch({ italic: v || undefined })" />
    </div>

    <div v-else-if="tab === 'bg'" class="pane">
      <div class="chips" role="radiogroup" aria-label="背景形态">
        <button v-for="b in BGS" :key="b.value" type="button" role="radio" class="chip" :aria-checked="bgKind === b.value" @click="patch(bgStyle(b.value))">
          <span class="chip-sample"><MarkPreview :mark="sample(bgStyle(b.value))" word="Ab" /></span>
          <span>{{ b.label }}</span>
        </button>
      </div>
      <template v-if="bgKind !== 'none'">
        <span class="lbl">背景颜色</span>
        <ColorRow :model-value="m.background" label="背景颜色" alpha :default-alpha="BACKGROUND_ALPHA" @update:model-value="(c: string) => patch({ background: c })" />
        <label class="slider">
          <span>浓淡 {{ Math.round(bgOpacity * 100) }}%</span>
          <input type="range" min="0.2" max="1" step="0.05" :value="bgOpacity" @input="patch({ backgroundOpacity: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <ToggleSwitch v-if="bgKind === 'block'" :model-value="m.rounded !== false" label="圆角" @update:model-value="(v: boolean) => patch({ rounded: v ? undefined : false })" />
      </template>
    </div>

    <div v-else class="pane">
      <div class="chips" role="radiogroup" aria-label="边框">
        <button
          v-for="b in BORDERS"
          :key="b.value"
          type="button"
          role="radio"
          class="chip"
          :aria-checked="(m.border ?? 'none') === b.value"
          @click="patch({ border: b.value === 'none' ? undefined : b.value, borderColor: b.value === 'none' ? undefined : m.borderColor || primary })"
        >
          <span class="chip-sample"><MarkPreview :mark="sample({ border: b.value, borderColor: m.borderColor || primary })" word="Ab" /></span>
          <span>{{ b.label }}</span>
        </button>
      </div>
      <template v-if="m.border && m.border !== 'none'">
        <span class="lbl">边框颜色</span>
        <ColorRow :model-value="m.borderColor ?? ''" label="边框颜色" empty-label="跟随线色或文字色" @update:model-value="(c: string) => patch({ borderColor: c })" />
        <p class="note">边框用描边绘制，不占位置，不会挤动文字。</p>
      </template>
    </div>

    <p v-if="isEmptyStyle" class="note">现在是“无样式”：生词本身不做标记，只在开启行内译文时显示括号译文。</p>
  </div>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: 12px; }
.pane { display: flex; flex-direction: column; gap: 8px; }
.chips { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.pane .chips:has(> :nth-child(4):last-child) { grid-template-columns: repeat(4, 1fr); }
.chip { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; font-size: 12px; color: var(--text-2); min-height: var(--tap); }
.chip[aria-checked='true'] { border-color: var(--accent); color: var(--text); font-weight: 650; background: var(--accent-soft); }
.chip-sample { font: 600 17px/1.7 Georgia, serif; color: #1f2328; background: #fff; border-radius: 6px; padding: 0 8px; }
.lbl { font-size: 13px; font-weight: 600; color: var(--text-2); margin-top: 4px; }
.slider { display: grid; grid-template-columns: 9em 1fr; align-items: center; gap: 10px; min-height: var(--tap); font-size: 13px; }
.slider input { width: 100%; accent-color: var(--accent); }
.note { margin: 0; font-size: 12px; color: var(--text-2); }
@media (max-width: 560px) {
  .chips { grid-template-columns: repeat(3, 1fr); }
  .pane .chips:has(> :nth-child(4):last-child) { grid-template-columns: repeat(4, 1fr); }
  .slider { grid-template-columns: 7.5em 1fr; }
}
</style>
