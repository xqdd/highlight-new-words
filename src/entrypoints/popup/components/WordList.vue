<script setup lang="ts">
import type { WordRow } from '../model';
import PopupIcon from './PopupIcon.vue';

/**
 * 单词列表（本页生词 / 熟词本共用）：整行点击打开详情，右侧主操作按钮（标为熟词 / 撤销）。
 * 行高 ≥ 44px（触屏）；释义单行截断。
 */

defineProps<{ rows: WordRow[]; action: 'known' | 'undo'; busy?: Set<string> }>();
const emit = defineEmits<{ open: [word: string]; act: [word: string] }>();
</script>

<template>
  <ul class="list">
    <li v-for="r in rows" :key="r.word" class="row">
      <button type="button" class="main" :aria-label="`${r.word} 详情`" @click="emit('open', r.word)">
        <span class="dot" :style="r.swatch ? { background: r.swatch } : undefined" aria-hidden="true" />
        <span class="text">
          <span class="word">{{ r.word }}</span>
          <span class="meaning">{{ r.meaning || '—' }}</span>
        </span>
        <span v-if="r.badge" class="badge">{{ r.badge }}</span>
      </button>
      <button
        type="button"
        class="act"
        :class="action"
        :disabled="busy?.has(r.word)"
        :title="action === 'known' ? '标为熟词（不再高亮）' : '移出熟词本（恢复高亮）'"
        :aria-label="action === 'known' ? `把 ${r.word} 标为熟词` : `把 ${r.word} 移出熟词本`"
        @click="emit('act', r.word)"
      >
        <PopupIcon :name="action === 'known' ? 'check-check' : 'undo'" />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.list { list-style: none; margin: 0; padding: 0; }
.row { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: 0; }
.main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;
  min-height: 46px; padding: 6px 4px 6px 2px; border: 0; background: none; text-align: left; cursor: pointer;
  border-radius: var(--radius-sm);
}
.main:hover .word { color: var(--accent); }
.main:focus-visible, .act:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); flex: none; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .08); }
.text { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.word { font-size: 15px; font-weight: 600; letter-spacing: .01em; flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meaning { flex: 1; min-width: 0; color: var(--text-2); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { flex: none; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 6px; background: var(--surface-2); color: var(--text-2); }
.act {
  flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px;
  border: 0; background: transparent; color: var(--text-2); cursor: pointer;
}
.act:hover { background: var(--accent-soft); color: var(--accent); }
.act:disabled { opacity: .4; cursor: default; }
@media (pointer: coarse) {
  .main { min-height: 52px; }
  .act { width: 46px; height: 46px; }
}
</style>
