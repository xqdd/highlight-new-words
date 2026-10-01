<script setup lang="ts" generic="T extends string">
/** 分段选择器（单选） */
const model = defineModel<T>({ required: true });
defineProps<{ options: { value: T; label: string }[] }>();
</script>

<template>
  <div class="seg" role="radiogroup">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :class="{ on: model === o.value }"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg { display: flex; padding: 3px; gap: 3px; background: var(--surface-2); border-radius: 10px; }
button { flex: 1; min-height: 32px; border: 0; background: transparent; border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--text-2); }
button.on { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
@media (pointer: coarse) { button { min-height: 38px; } }
</style>
