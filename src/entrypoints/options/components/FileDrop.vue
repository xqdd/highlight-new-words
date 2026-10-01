<script setup lang="ts">
import { ref } from 'vue';
import AppIcon from '@/ui/components/AppIcon.vue';

/**
 * 文件拖放区：拖拽文件到区域内，或点击选择文件（手机上点按即弹出系统文件选择器）。
 * 通过 defineExpose 暴露 pick()，供“覆盖导入”等入口复用同一个文件选择器。
 */
defineProps<{ accept: string; title: string; hint?: string; compact?: boolean }>();
const emit = defineEmits<{ file: [file: File] }>();

const input = ref<HTMLInputElement>();
const dragging = ref(false);

function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  const file = el.files?.[0];
  if (file) emit('file', file);
  // 清空以便再次选择同一文件
  el.value = '';
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) emit('file', file);
}

defineExpose({ pick: () => input.value?.click() });
</script>

<template>
  <div
    class="drop"
    :class="{ dragging, compact }"
    role="button"
    tabindex="0"
    @click="input?.click()"
    @keydown.enter.prevent="input?.click()"
    @keydown.space.prevent="input?.click()"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <span class="ico"><AppIcon name="upload" :size="22" /></span>
    <span class="text">
      <strong>{{ dragging ? '松开即可导入' : title }}</strong>
      <span v-if="hint" class="muted">{{ hint }}</span>
    </span>
    <input ref="input" type="file" :accept="accept" hidden @change="onChange" />
  </div>
</template>

<style scoped>
.drop { display: flex; align-items: center; gap: 14px; padding: 18px; border: 1.5px dashed var(--border); border-radius: 14px;
  background: var(--surface-2); cursor: pointer; transition: border-color .15s, background .15s; }
.drop:hover, .drop:focus-visible, .drop.dragging { border-color: var(--accent); background: var(--accent-soft); outline: none; }
.ico { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--surface); color: var(--accent); flex: none; }
.text { display: flex; flex-direction: column; min-width: 0; }
.compact { padding: 12px 14px; }
</style>
