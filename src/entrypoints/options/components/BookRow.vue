<script setup lang="ts">
import { computed } from 'vue';
import type { BookMeta } from '@/core/wordbook/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import { bookKindLabel, formatCount, relativeTime } from '../lib/books';

/**
 * 可勾选的词书行：整行是一个开关按钮，左侧简称徽标，右侧词数与勾选圈。
 * radio=true 时按单选语义展示（role=radio、圆点），用于包含体系的难度分级。
 */
const props = defineProps<{ book: BookMeta; on: boolean; radio?: boolean }>();
defineEmits<{ toggle: [] }>();

const sub = computed(() => {
  const b = props.book;
  if (b.kind === 'source') {
    const s = b.sync;
    if (!s) return '';
    if (s.status === 'error') return '同步失败：' + (s.error ?? '');
    return s.lastSyncAt ? `同步于 ${relativeTime(s.lastSyncAt)}` : '尚未同步';
  }
  if (b.kind === 'local') return `导入于 ${relativeTime(b.updatedAt ?? 0)}`;
  return b.description ?? b.nameEn;
});
/** 增量词书说明：如“六级 − 四级/高考/中考” */
const deltaTitle = computed(() => (props.book.delta ? `${props.book.delta.of} − ${props.book.delta.minus.join(' / ')}` : ''));
const badge = computed(() => {
  const label = bookKindLabel(props.book);
  // 徽标最多显示 3 个字符，如“六级”“GRE”“导入”“有道”
  return label.replace(/词典$/, '').slice(0, 3);
});
</script>

<template>
  <li>
    <button type="button" class="book" :role="radio ? 'radio' : 'switch'" :aria-checked="on" @click="$emit('toggle')">
      <span class="badge" :class="book.kind">{{ badge }}</span>
      <span class="text">
        <span class="name">{{ book.name }}<span v-if="book.delta" class="tag" :title="deltaTitle">增量</span></span>
        <span class="sub" :class="{ err: book.sync?.status === 'error' }">{{ sub }}</span>
      </span>
      <span class="count">{{ formatCount(book.size) }}<small>词</small></span>
      <span class="check" :class="{ on, radio }"><AppIcon v-if="on && !radio" name="check" :size="16" /></span>
    </button>
  </li>
</template>

<style scoped>
.book { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 18px; min-height: 60px; border: 0;
  border-top: 1px solid var(--border); background: transparent; text-align: left; cursor: pointer; color: var(--text); }
.book:hover { background: var(--surface-2); }
.book:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.badge { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex: none; font-size: 12px; font-weight: 700;
  background: var(--surface-2); color: var(--text-2); letter-spacing: -.02em; }
.badge.source { background: color-mix(in srgb, #0ea5e9 14%, transparent); color: #0284c7; }
.badge.local { background: color-mix(in srgb, #8b5cf6 14%, transparent); color: #7c3aed; }
.book[aria-checked='true'] .badge.builtin { background: var(--accent-soft); color: var(--accent); }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub.err { color: var(--danger); }
.count { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 13px; white-space: nowrap; }
.count small { margin-left: 2px; font-size: 11px; }
.check { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--border); display: grid; place-items: center; flex: none;
  transition: background .15s, border-color .15s; }
.check.on { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.check.radio.on { background: var(--surface); border: 7px solid var(--accent); }
.tag { margin-left: 6px; padding: 0 6px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); vertical-align: 1px; }
@media (max-width: 480px) { .book { padding: 10px 14px; gap: 10px; } }
</style>
