<script setup lang="ts">
import { computed } from 'vue';

/**
 * 线性图标（24 视窗、描边 2px，风格参照 Lucide），只收录 popup/options 用到的少量图标，避免引入图标库。
 * 圆用 path 弧线表示，统一以 path 渲染。
 */
const ICONS = {
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z', 'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'],
  palette: [
    'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.7-1.3-.7-2.1 0-.9.8-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z',
    'M7.5 11.5h.01', 'M10 7.5h.01', 'M14.5 7.5h.01', 'M17 11h.01',
  ],
  cloud: ['M17.5 19H8a6 6 0 1 1 5.7-7.9A4.5 4.5 0 1 1 17.5 19z'],
  known: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M8.5 12.5l2.5 2.5 5-5.5'],
  more: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', 'M15 4v4', 'M9 10v4', 'M17 16v4'],
  upload: ['M12 15V4', 'M7 9l5-5 5 5', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
  chevron: ['M9 6l6 6-6 6'],
  up: ['M6 15l6-6 6 6'],
  down: ['M6 9l6 6 6-6'],
  refresh: ['M20 11a8 8 0 0 0-14.8-4', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.8 4', 'M20 20v-4h-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  undo: ['M9 14L4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  monitor: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  file: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  volume: ['M4 9v6h4l5 4V5L8 9z', 'M16.5 8.5a5 5 0 0 1 0 7', 'M19 6a8.5 8.5 0 0 1 0 12'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z'],
  sync: ['M4 12a8 8 0 0 1 13.7-5.6L20 8.5', 'M20 4v4.5h-4.5', 'M20 12a8 8 0 0 1-13.7 5.6L4 15.5', 'M4 20v-4.5h4.5'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z'],
  power: ['M12 3v9', 'M6.3 6.3a8 8 0 1 0 11.4 0'],
} as const;

export type IconName = keyof typeof ICONS;

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 20 });
const paths = computed(() => ICONS[props.name]);
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icon { flex: none; display: block; }
</style>
