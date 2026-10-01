<script setup lang="ts">
import { computed } from 'vue';
import type { DictEntry } from '@/core/dict/types';
import type { BookMeta } from '@/core/wordbook/types';
import PopupIcon from './PopupIcon.vue';

/**
 * 单词详情（底部抽屉内容）：音标、发音、完整释义、命中词书；
 * 操作按钮由父组件放在抽屉 footer（标为熟词 / 撤销 / 从来源生词本删除）。
 */
const props = defineProps<{ word: string; entry?: DictEntry; books: BookMeta[]; known: boolean }>();
const emit = defineEmits<{ speak: [] }>();

/** 完整释义按行拆分；每行“词性. 释义”拆出词性标签 */
const senses = computed(() =>
  (props.entry?.full || props.entry?.short || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([a-z]+\.(?:\s*&\s*[a-z]+\.)?)\s*(.*)$/i);
      return m ? { pos: m[1], text: m[2] } : { pos: '', text: line };
    }),
);
</script>

<template>
  <div class="detail">
    <div class="pron">
      <span v-if="entry?.phonetic" class="phon">/{{ entry.phonetic }}/</span>
      <button type="button" class="speak" :aria-label="`朗读 ${word}`" @click="emit('speak')">
        <PopupIcon name="volume" :size="16" /> 发音
      </button>
    </div>

    <ol v-if="senses.length" class="senses">
      <li v-for="(s, i) in senses" :key="i">
        <span v-if="s.pos" class="pos">{{ s.pos }}</span>
        <span>{{ s.text }}</span>
      </li>
    </ol>
    <p v-else class="none">暂无释义</p>

    <div v-if="books.length || known" class="tags">
      <span v-if="known" class="tag known"><PopupIcon name="check-check" :size="13" /> 熟词</span>
      <span v-for="b in books" :key="b.id" class="tag">{{ b.kind === 'builtin' ? b.short : b.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 12px; }
.pron { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.phon { font-family: 'Lucida Sans Unicode', 'Segoe UI', system-ui, sans-serif; color: var(--text-2); font-size: 14px; }
.speak {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font-size: 13px;
}
.speak:hover { border-color: var(--accent); color: var(--accent); }
@media (pointer: coarse) { .speak { min-height: 40px; } }
.senses { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 14.5px; line-height: 1.55; }
.senses li { display: flex; gap: 8px; align-items: baseline; }
.pos { flex: none; font-size: 12px; font-style: italic; color: var(--accent); min-width: 28px; }
.none { margin: 0; color: var(--text-2); }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.tag.known { background: var(--accent-soft); color: var(--accent); }
</style>
