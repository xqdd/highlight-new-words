<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { ATTR_BOOK, ATTR_BOOKS, ATTR_IN_LINK, ATTR_ON_DARK } from '@/content/engine/dom';
import { highlightTextNode } from '@/content/engine/highlighter';
import type { Settings } from '@/core/settings/schema';
import { acquirePreviewCss, releasePreviewCss, setPreviewCss } from '../lib/preview-css';

/**
 * 单个生词的真实渲染：与网页上一致的 engine 标记（highlightTextNode）+ 页面样式（buildPageCss，见 lib/preview-css）。
 * 用在“试一试”等演示中：链接内的生词走 engine 的链接规则（保留链接色，只加浅色底），与普通生词可以区分，
 * 不能用 MarkPreview（它只套样式，链接内也会被染成生词色）。
 * 外层需要 data-pv-tr 容器（演示里一般为 off，不显示行内译文）。
 */
const props = defineProps<{ settings: Settings; word: string; bookId?: string }>();
const host = ref<HTMLElement>();

/** 背景是否为深色：按所在容器的计算背景色亮度判断（与 engine 判断上下文明暗的目的相同） */
function onDarkBackground(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const m = getComputedStyle(n).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) continue;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return false;
}

function render() {
  const el = host.value;
  if (!el) return;
  el.textContent = props.word;
  const [mark] = highlightTextNode(el.firstChild as Text, (w) => ({ surface: w, lemma: w.toLowerCase(), bookIds: [''] }));
  if (!mark) return;
  const book = props.bookId ?? props.settings.books.enabled[0] ?? '';
  mark.setAttribute(ATTR_BOOK, book);
  mark.setAttribute(ATTR_BOOKS, book);
  mark.toggleAttribute(ATTR_IN_LINK, !!el.closest('a'));
  mark.toggleAttribute(ATTR_ON_DARK, onDarkBackground(el));
}

acquirePreviewCss();
watchEffect(() => setPreviewCss(props.settings));
onUnmounted(releasePreviewCss);
onMounted(render);
watch(() => [props.word, props.bookId, props.settings.books.enabled[0]], render);
// 选项页切换亮/暗主题（系统配色或页面 data-theme）时重新判断背景
const scheme = matchMedia('(prefers-color-scheme: dark)');
const themeObserver = new MutationObserver(render);
onMounted(() => {
  scheme.addEventListener('change', render);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
onUnmounted(() => {
  scheme.removeEventListener('change', render);
  themeObserver.disconnect();
});
</script>

<template>
  <span ref="host" lang="en" />
</template>
