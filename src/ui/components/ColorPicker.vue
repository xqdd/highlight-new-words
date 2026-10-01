<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatHexAlpha, parseColor } from '@/ui/color';
import { HIGHLIGHT_PALETTE, hexToHsv, hsvToHex, type Hsv, type PaletteColor } from './palette';

/**
 * 自绘取色器（对标 Relingo 的 Sketch 取色器）：预设色板 + 饱和度/明度面板 + 色相条 + 可选透明度条 + HEX 输入。
 * 不用 <input type=color>：Android Edge 上系统取色器交互简陋且无法选透明度。
 * 拖动基于 Pointer Events + setPointerCapture，鼠标与触屏一致；面板设置 touch-action:none 避免拖动时页面滚动。
 * v-model 输出 #RRGGBB（alpha=false 或不透明）或 #RRGGBBAA。
 */
const model = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{ alpha?: boolean; presets?: readonly PaletteColor[] }>(), {
  alpha: false,
  presets: () => HIGHLIGHT_PALETTE,
});

// 本地保存 HSV：灰色（s=0）时 hex 无法还原色相，若每次从 hex 反算，拖动饱和度时色相会跳回 0
const hsv = ref<Hsv>(hexToHsv(parseColor(model.value)?.hex ?? '#ff7008'));
const alphaValue = ref(parseColor(model.value)?.alpha ?? 1);
const hexText = ref('');

const hex = computed(() => hsvToHex(hsv.value));
watch(
  model,
  (v) => {
    const p = parseColor(v || '');
    if (!p) return;
    // 外部值与当前 HSV 等价时不覆盖，保留色相
    if (p.hex !== hex.value) hsv.value = hexToHsv(p.hex);
    alphaValue.value = props.alpha ? p.alpha : 1;
    hexText.value = p.hex.slice(1).toUpperCase();
  },
  { immediate: true },
);

function emit() {
  model.value = formatHexAlpha(hex.value, props.alpha ? alphaValue.value : 1);
}

/** 通用拖动：在元素上按下后持续跟踪，回调参数为 0-1 的相对坐标 */
function drag(e: PointerEvent, onMove: (x: number, y: number) => void) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const rect = el.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    onMove(x, y);
    emit();
  };
  move(e);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

const onSv = (e: PointerEvent) => drag(e, (x, y) => (hsv.value = { ...hsv.value, s: x, v: 1 - y }));
const onHue = (e: PointerEvent) => drag(e, (x) => (hsv.value = { ...hsv.value, h: x * 360 }));
const onAlpha = (e: PointerEvent) => drag(e, (x) => (alphaValue.value = Math.round(x * 100) / 100));

/** 键盘微调（无障碍）：方向键移动 1%，Shift 10% */
function nudge(e: KeyboardEvent, target: 'sv' | 'hue' | 'alpha') {
  const step = e.shiftKey ? 0.1 : 0.01;
  const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
  const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
  if (!dx && !dy) return;
  e.preventDefault();
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  if (target === 'sv') hsv.value = { ...hsv.value, s: clamp(hsv.value.s + dx), v: clamp(hsv.value.v + dy) };
  else if (target === 'hue') hsv.value = { ...hsv.value, h: clamp(hsv.value.h / 360 + dx + dy) * 360 };
  else alphaValue.value = Math.round(clamp(alphaValue.value + dx + dy) * 100) / 100;
  emit();
}

function onHexInput() {
  const p = parseColor('#' + hexText.value.replace(/^#/, ''));
  if (!p) return;
  hsv.value = hexToHsv(p.hex);
  emit();
}

function pickPreset(c: string) {
  hsv.value = hexToHsv(c);
  emit();
}
</script>

<template>
  <div class="picker">
    <div class="presets" role="listbox" aria-label="预设颜色">
      <button
        v-for="c in presets"
        :key="c.hex"
        type="button"
        role="option"
        class="swatch"
        :style="{ '--c': c.hex }"
        :aria-selected="c.hex === hex"
        :title="c.name"
        :aria-label="c.name"
        @click="pickPreset(c.hex)"
      />
    </div>
    <div
      class="sv"
      :style="{ '--hue': `hsl(${hsv.h} 100% 50%)` }"
      tabindex="0"
      role="slider"
      aria-label="饱和度与明度"
      :aria-valuenow="Math.round(hsv.s * 100)"
      @pointerdown="onSv"
      @keydown="nudge($event, 'sv')"
    >
      <span class="knob" :style="{ left: hsv.s * 100 + '%', top: (1 - hsv.v) * 100 + '%', background: hex }" />
    </div>
    <div class="bars">
      <div class="bars-col">
        <div
          class="bar hue"
          tabindex="0"
          role="slider"
          aria-label="色相"
          :aria-valuenow="Math.round(hsv.h)"
          @pointerdown="onHue"
          @keydown="nudge($event, 'hue')"
        >
          <span class="thumb" :style="{ left: (hsv.h / 360) * 100 + '%' }" />
        </div>
        <div
          v-if="alpha"
          class="bar alpha"
          :style="{ '--c': hex }"
          tabindex="0"
          role="slider"
          aria-label="透明度"
          :aria-valuenow="Math.round(alphaValue * 100)"
          @pointerdown="onAlpha"
          @keydown="nudge($event, 'alpha')"
        >
          <span class="thumb" :style="{ left: alphaValue * 100 + '%' }" />
        </div>
      </div>
      <span class="current" :style="{ '--c': model }" aria-hidden="true" />
    </div>
    <div class="inputs">
      <label class="hex">
        <span>#</span>
        <input v-model="hexText" type="text" maxlength="7" spellcheck="false" aria-label="HEX 颜色" @change="onHexInput" />
      </label>
      <span v-if="alpha" class="muted">透明度 {{ Math.round(alphaValue * 100) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; gap: 12px; }
.presets { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.swatch { aspect-ratio: 1; min-height: 36px; border-radius: 10px; border: 0; background: var(--c); cursor: pointer; position: relative; }
.swatch[aria-selected='true']::after { content: ''; position: absolute; inset: -3px; border-radius: 12px; border: 2px solid var(--text); }
.sv { position: relative; height: 160px; border-radius: 10px; cursor: crosshair; touch-action: none;
  background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--hue)); }
.knob { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; border: 3px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .3), 0 1px 4px rgba(0, 0, 0, .3); pointer-events: none; }
.bars { display: flex; gap: 12px; align-items: center; }
.bars-col { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.bar { position: relative; height: 16px; border-radius: 999px; touch-action: none; cursor: pointer; }
.hue { background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
.alpha { background: linear-gradient(to right, transparent, var(--c)), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 10px 10px; }
.thumb { position: absolute; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .2), 0 1px 3px rgba(0, 0, 0, .35); pointer-events: none; }
.current { width: 40px; height: 40px; border-radius: 10px; flex: none; border: 1px solid var(--border);
  background: linear-gradient(var(--c), var(--c)), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 10px 10px; }
.inputs { display: flex; align-items: center; gap: 12px; }
.hex { display: flex; align-items: center; gap: 4px; flex: 0 0 9em; font-family: ui-monospace, Menlo, Consolas, monospace; }
.hex input { text-transform: uppercase; font-family: inherit; }
.sv:focus-visible, .bar:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (pointer: coarse) { .bar { height: 22px; } .sv { height: 180px; } }
</style>
