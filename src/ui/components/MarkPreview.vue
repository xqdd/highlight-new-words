<script setup lang="ts">
import { computed } from 'vue';
import type { MarkStyle } from '@/core/theme/themes';
import { markStyleToCss } from '@/core/theme/resolve';

/** 高亮效果预览：与内容脚本使用同一套 markStyleToCss */
const props = defineProps<{ mark: MarkStyle; word?: string }>();
const style = computed(() => markStyleToCss(props.mark) + '; border-radius: .2em');
</script>

<template>
  <span class="preview" :style="style">{{ word ?? 'serendipity' }}</span>
</template>

<style scoped>
.preview { padding: 0 1px; }
</style>
