<script setup lang="ts">
/**
 * 设置行（iOS/Relingo 设置式）：左侧标题 + 灰色说明，右侧控件插槽；整行最小高度满足触控。
 * stack=true 时控件换到下一行占满宽度（手机上放分段选择器、输入框等较宽控件）。
 */
defineProps<{ label: string; description?: string; stack?: boolean; forId?: string }>();
</script>

<template>
  <div class="setting-row" :class="{ stack }">
    <label class="text" :for="forId">
      <span class="label">{{ label }}</span>
      <span v-if="description" class="muted">{{ description }}</span>
    </label>
    <div class="control"><slot /></div>
  </div>
</template>

<style scoped>
.setting-row { display: flex; align-items: center; gap: 12px; min-height: var(--tap); }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.label { font-weight: 550; }
.control { flex: none; display: flex; align-items: center; gap: 8px; max-width: 60%; }
.setting-row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
.stack .control { max-width: none; }
.stack .control > * { flex: 1; min-width: 0; }
</style>
