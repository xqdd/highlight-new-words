<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue';
import { ATTR_BOOK, ATTR_BOOKS, ATTR_IN_LINK, ATTR_LEMMA, ATTR_ON_DARK } from '@/content/engine/dom';
import { highlightTextNode, setMarkTranslation } from '@/content/engine/highlighter';
import type { InlineTranslationMode, Settings } from '@/core/settings/schema';
import { resolveMarkStyle } from '@/core/theme/resolve';
import type { BookMeta } from '@/core/wordbook/types';
import { markPrimaryColor } from '@/ui/components/palette';
import { acquirePreviewCss, releasePreviewCss, setPreviewCss } from '../lib/preview-css';

/**
 * 实时预览：直接复用内容脚本的高亮实现（highlightTextNode + setMarkTranslation 生成 DOM，buildPageCss 生成样式，见 lib/preview-css），
 * 所见即网页上的实际效果，engine 调整 DOM 结构或样式时预览自动一致。
 * 预览容器用 data-pv-tr 指定行内译文模式，同一页面中多个预览可以使用不同模式。
 * 示例生词按启用顺序轮流分配给各词书，以展示“按词书分色”。
 */
const props = defineProps<{ settings: Settings; books: BookMeta[]; mode?: InlineTranslationMode; text?: 'full' | 'short' }>();

/** 完整示例：中间一段放在链接里，检验生词样式不会与网页链接色混淆（Relingo 的已知缺陷） */
const FULL_TEXT: [string, string, string] = ['Scientists remain skeptical about the ambitious proposal, citing ', 'insufficient evidence', ' and a notoriously volatile market.'];
const SHORT_TEXT = 'A meticulous and resilient team.';
const TRANSLATIONS: Record<string, string> = {
  skeptical: '怀疑的',
  ambitious: '雄心勃勃的',
  insufficient: '不足的',
  notoriously: '出了名地',
  volatile: '易变的',
  meticulous: '一丝不苟的',
  resilient: '有韧性的',
};

/** 页面背景：预览高亮在浅色/深色网页上的可读性（深色时给 mark 打上 engine 的深色上下文标记） */
const pageTone = ref<'light' | 'dark'>('light');
const sample = ref<HTMLElement>();

/** 用 engine 的切分逻辑重建示例段落（逐个文本节点切分，链接内的文本同样处理） */
function render() {
  const el = sample.value;
  if (!el) return;
  el.replaceChildren();
  if (props.text === 'short') el.textContent = SHORT_TEXT;
  else {
    const link = Object.assign(document.createElement('a'), { href: '#', textContent: FULL_TEXT[1] });
    link.addEventListener('click', (e) => e.preventDefault());
    el.append(FULL_TEXT[0], link, FULL_TEXT[2]);
  }
  const texts: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  const ids = props.settings.books.enabled.length ? props.settings.books.enabled : [''];
  const marks = texts.flatMap((t) =>
    highlightTextNode(t, (word) => {
      const lemma = word.toLowerCase();
      return lemma in TRANSLATIONS ? { surface: word, lemma, bookIds: [''] } : null;
    }),
  );
  // highlightTextNode 返回文档顺序，这里从左到右依次分配启用的词书，并写入释义
  marks.forEach((mark, i) => {
    const lemma = mark.getAttribute(ATTR_LEMMA) ?? '';
    const book = ids[i % ids.length]!;
    mark.setAttribute(ATTR_BOOK, book);
    mark.setAttribute(ATTR_BOOKS, book);
    mark.toggleAttribute(ATTR_ON_DARK, pageTone.value === 'dark');
    mark.toggleAttribute(ATTR_IN_LINK, !!mark.closest('a'));
    setMarkTranslation(mark, TRANSLATIONS[lemma]);
  });
}
onMounted(render);
watch([() => props.settings.books.enabled.join(' '), pageTone, () => props.text], render);

/** 图例：启用多本词书时展示每本书对应的颜色 */
const legend = computed(() =>
  props.settings.books.enabled.slice(0, 6).map((id) => {
    const meta = props.books.find((b) => b.id === id);
    return { id, name: meta ? meta.name : id, color: markPrimaryColor(resolveMarkStyle(props.settings, id)) };
  }),
);

// 样式注入（全页共享一份，见 lib/preview-css）
acquirePreviewCss();
watchEffect(() => setPreviewCss(props.settings));
onUnmounted(releasePreviewCss);
</script>

<template>
  <div class="preview" :class="pageTone" :data-pv-tr="mode ?? settings.inlineTranslation.mode">
    <p ref="sample" class="sample" lang="en" />
    <div v-if="text !== 'short'" class="caption">
      <span v-if="!settings.enabled" class="off">高亮已关闭</span>
      <span v-for="l in legend.length > 1 ? legend : []" :key="l.id" class="legend"><i :style="{ background: l.color }" />{{ l.name }}</span>
      <span class="spacer" />
      <!-- 页面附加的操作（如外观页手机上的“收起预览”） -->
      <slot name="actions" />
      <button
        type="button"
        class="tone"
        :aria-label="pageTone === 'light' ? '切换到深色网页预览' : '切换到浅色网页预览'"
        @click="pageTone = pageTone === 'light' ? 'dark' : 'light'"
      >
        {{ pageTone === 'light' ? '浅色网页' : '深色网页' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.preview { margin: 0; border-radius: 12px; border: 1px solid var(--border); overflow: hidden; }
.preview.light { background: #ffffff; color: #1f2328; }
.preview.dark { background: #16181d; color: #e6e6e6; }
.sample { margin: 0; padding: 14px 16px; font: 17px/1.9 Georgia, 'Times New Roman', serif; }
/* 词上方译文需要更大行距，避免注解压到上一行（预览容器固定了行高） */
.preview[data-pv-tr='ruby'] .sample { line-height: 2.4; }
/* 手机：预览吸顶，压缩字号与行距，给下方设置留出空间 */
@media (max-width: 560px) {
  .sample { font-size: 15px; line-height: 1.75; padding: 10px 12px; }
  .preview[data-pv-tr='ruby'] .sample { line-height: 2.2; }
  .caption { padding: 6px 10px; gap: 4px 10px; }
}
.sample :deep(a) { color: #1a5fb4; text-decoration: underline; }
.dark .sample :deep(a) { color: #8ab4f8; }
.caption { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 12px; font-size: 12px;
  border-top: 1px solid rgba(127, 127, 127, .2); color: inherit; opacity: .85; }
.legend { display: inline-flex; align-items: center; gap: 5px; max-width: 14em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend i { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.spacer { flex: 1; }
.tone { border: 1px solid rgba(127, 127, 127, .35); background: transparent; color: inherit; border-radius: 999px; padding: 2px 10px;
  min-height: 28px; cursor: pointer; font-size: 12px; }
.off { color: #dc2626; font-weight: 600; }
</style>
