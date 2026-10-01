<script setup lang="ts">
/** 开关组件：v-model 布尔值，触屏下点击区域不小于 44px */
const model = defineModel<boolean>({ required: true });
defineProps<{ label?: string; description?: string }>();
</script>

<template>
  <label class="toggle">
    <span v-if="label || description || $slots.default" class="text">
      <span class="label">{{ label }}<slot /></span>
      <span v-if="description" class="muted">{{ description }}</span>
    </span>
    <input v-model="model" type="checkbox" role="switch" />
    <span class="track" aria-hidden="true"><span class="thumb" /></span>
  </label>
</template>

<style scoped>
.toggle { display: flex; align-items: center; gap: 12px; min-height: var(--tap); cursor: pointer; }
.text { flex: 1; display: flex; flex-direction: column; }
.label { font-weight: 550; }
input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.track { width: 40px; height: 24px; border-radius: 999px; background: var(--border); position: relative; transition: background .15s; flex: none; }
.thumb { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
input:checked + .track { background: var(--accent); }
input:checked + .track .thumb { transform: translateX(16px); }
input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
