<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ReadingVisual } from '@/content/reading/visual';
import { normalizeReadingSettings, type ReadingSettings } from '@/core/reading/settings';
import AppIcon from '@/ui/components/AppIcon.vue';

const props = defineProps<{ settings: ReadingSettings }>();
const safe = computed(() => normalizeReadingSettings(props.settings));
const dark = ref(false);
const sample = ref<HTMLElement>();
let visual: ReadingVisual | undefined;
onMounted(() => {
  if (!sample.value) return;
  visual = new ReadingVisual(sample.value, safe.value);
  visual.start();
});
watch(safe, (value) => visual?.update(value), { deep: true });
onUnmounted(() => visual?.stop());

</script>

<template>
  <section class="reading-preview" aria-label="阅读效果预览">
    <header class="preview-header">
      <span>阅读预览</span>
      <div class="background-buttons" role="group" aria-label="预览背景">
        <button type="button" aria-label="浅色预览" title="浅色预览" :aria-pressed="!dark" @click="dark = false"><AppIcon name="sun" :size="17" /></button>
        <button type="button" aria-label="深色预览" title="深色预览" :aria-pressed="dark" @click="dark = true"><AppIcon name="moon" :size="17" /></button>
      </div>
    </header>
    <div class="preview-surface" :class="{ dark }">
      <article ref="sample" class="sample" lang="en">
        <p>In 2025, Maya visited <a href="https://en.wikipedia.org/wiki/London" target="_blank" rel="noopener">London</a> for the first time. She did <strong>not</strong> expect the quiet library to become her favorite place. However, a small discovery changed her plans.</p>
        <p>The librarian suggested reading for 20 minutes each day. Although the first chapter seemed difficult, Maya kept going because the story was interesting. By Friday, she could follow the main idea without looking up every word.</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.reading-preview { position: sticky; top: 12px; z-index: 10; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px #0001; }
.preview-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 14px; background: var(--surface-2); font-size: 13px; font-weight: 600; }
.background-buttons { display: flex; gap: 4px; }
.background-buttons button { width: 32px; height: 32px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.background-buttons button[aria-pressed='true'] { border-color: var(--border); background: var(--surface); color: var(--text); }
.preview-surface { position: relative; overflow: auto; max-height: min(260px, 32vh); padding: 20px; background: #ffffff; color: #20252a; }
.preview-surface.dark { background: #20252a; color: #f1f5f9; }
.sample { margin-inline: auto; font-size: 16px; line-height: 1.7; }
.sample p { margin: 0 0 0.8em; }
.sample p:last-child { margin-bottom: 0; }
.sample a { color: #2563eb; text-decoration: underline; }
.dark .sample a { color: #7dd3fc; }
@media (max-width: 480px) { .preview-surface { padding: 16px; } }
@media (max-width: 899px) {
  .reading-preview { top: 64px; }
  .preview-surface { max-height: min(180px, 24vh); padding-block: 12px; }
}
</style>
