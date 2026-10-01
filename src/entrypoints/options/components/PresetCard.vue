<script setup lang="ts">
import type { InlineTranslationMode, MarkStyle } from '@/core/theme/themes';
import MarkPreview from '@/ui/components/MarkPreview.vue';

/**
 * 预设画廊的一张卡片：浅色纸面 + 深色纸面两个缩略（同一预设在亮/暗网页上的样子），带建议译文的预设同时示意译文位置。
 * 缩略用与内容脚本相同的 markStyleToCss 渲染；译文只做示意（真实效果见页面顶部实时预览）。
 */
defineProps<{ mark: MarkStyle; name: string; desc?: string; checked: boolean; translation?: InlineTranslationMode; compact?: boolean }>();
</script>

<template>
  <button type="button" role="radio" class="preset" :class="{ compact }" :aria-checked="checked" :aria-label="name">
    <span class="papers" :class="{ glossed: translation === 'after' }">
      <span class="paper light">
        <span v-if="translation === 'ruby'" class="ruby"><span class="rt">生动</span><MarkPreview :mark="mark" word="vivid" /></span>
        <MarkPreview v-else :mark="mark" word="vivid" /><span v-if="translation === 'after'" class="gloss">(生动)</span>
      </span>
      <span v-if="!compact" class="paper dark">
        <MarkPreview :mark="mark" word="vivid" /><span v-if="translation === 'after'" class="gloss">(生动)</span>
      </span>
    </span>
    <span class="pname">{{ name }}</span>
    <span v-if="desc && !compact" class="pdesc">{{ desc }}</span>
  </button>
</template>

<style scoped>
.preset { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 12px; border: 1.5px solid var(--border);
  background: var(--surface); cursor: pointer; color: var(--text); text-align: left; min-width: 0; }
.preset[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.papers { display: grid; grid-template-columns: 1fr 1fr; border-radius: 8px; overflow: hidden; border: 1px solid rgba(127, 127, 127, .18); }
.compact .papers { grid-template-columns: 1fr; }
.paper { display: flex; align-items: center; justify-content: center; gap: 2px; height: 48px; font: 17px/1 Georgia, 'Times New Roman', serif; white-space: nowrap; overflow: hidden; }
.paper.light { background: #fff; color: #1f2328; }
.paper.dark { background: #16181d; color: #e6e6e6; }
.compact .paper { height: 40px; font-size: 16px; }
.glossed .paper { font-size: 15px; }
.gloss { font-size: 10px; opacity: .6; font-family: system-ui, sans-serif; }
.ruby { display: inline-flex; flex-direction: column; align-items: center; line-height: 1.05; }
.rt { font-size: 9px; opacity: .7; font-family: system-ui, sans-serif; }
.pname { font-size: 13px; font-weight: 600; padding: 0 2px; }
.preset[aria-checked='true'] .pname { color: var(--accent); }
.pdesc { font-size: 11px; color: var(--text-2); padding: 0 2px; line-height: 1.4; }
@media (max-width: 480px) { .paper { height: 42px; font-size: 15px; } }
</style>
