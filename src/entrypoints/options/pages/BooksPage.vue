<script setup lang="ts">
import { computed } from 'vue';
import { resolveMarkStyle } from '@/core/theme/resolve';
import type { BookMeta } from '@/core/wordbook/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import { CATEGORY_GROUPS, bookKindLabel, formatCount, isBookEnabled, moveBook, toggleBook } from '../lib/books';
import { useOptions } from '../lib/context';
import BookRow from '../components/BookRow.vue';

/**
 * 词书页：已启用列表（顺序=优先级，可上下调整）+ 我的生词本 + 各分类内置词书（多选组合，显示词数）。
 * 启用顺序决定一个词同时命中多本书时用哪本的颜色。
 */
const { settings, books, navigate } = useOptions();

const byId = computed(() => new Map(books.value.map((b) => [b.id, b])));
const enabled = computed(() =>
  settings.value.books.enabled.map((id) => ({ id, meta: byId.value.get(id) })),
);
const userBooks = computed(() => books.value.filter((b) => b.kind !== 'builtin'));
const groups = computed(() => {
  const known = new Set(CATEGORY_GROUPS.map((g) => g.category));
  return CATEGORY_GROUPS.map((g) => ({
    ...g,
    books: books.value
      .filter((b) => b.kind === 'builtin' && (b.category === g.category || (g.category === 'other' && !known.has(b.category))))
      .sort((a, b) => a.level - b.level),
  })).filter((g) => g.books.length > 0);
});

/** 已启用词书词数合计（未去重，仅作量级参考） */
const totalWords = computed(() => enabled.value.reduce((n, e) => n + (e.meta?.size ?? 0), 0));

function groupAll(list: BookMeta[], on: boolean) {
  for (const b of list) toggleBook(settings.value, b.id, on);
}

/**
 * 难度分级（level）是包含体系（选 B2 = B2+C1+C2，见 BookCategory 注释），同时启用多档没有意义，
 * 按单选处理：启用一档时停用同组其他档。
 */
function toggleInGroup(b: BookMeta, group: BookMeta[]) {
  const on = !isBookEnabled(settings.value, b.id);
  if (on && b.category === 'level') for (const other of group) if (other.id !== b.id) toggleBook(settings.value, other.id, false);
  toggleBook(settings.value, b.id, on);
}
</script>

<template>
  <SettingsSection id="enabled" title="已启用" flush>
    <template #actions>
      <span class="muted total">{{ enabled.length }} 本 · 约 {{ formatCount(totalWords) }} 词</span>
    </template>
    <p class="hint muted">一个词同时出现在多本书中时，排在前面的词书决定它的颜色。</p>
    <ol v-if="enabled.length" class="enabled">
      <li v-for="(e, i) in enabled" :key="e.id">
        <span class="rank">{{ i + 1 }}</span>
        <span class="sample"><MarkPreview :mark="resolveMarkStyle(settings, e.id)" word="Aa" /></span>
        <span class="name">
          <span class="title">{{ e.meta ? e.meta.name : e.id }}</span>
          <span class="muted">
            <template v-if="e.meta">{{ bookKindLabel(e.meta) }} · {{ formatCount(e.meta.size) }} 词</template>
            <template v-else>词书不存在或尚未加载</template>
          </span>
        </span>
        <span class="ops">
          <button type="button" class="icon-btn" :disabled="i === 0" aria-label="上移" @click="moveBook(settings, e.id, -1)"><AppIcon name="up" :size="18" /></button>
          <button type="button" class="icon-btn" :disabled="i === enabled.length - 1" aria-label="下移" @click="moveBook(settings, e.id, 1)"><AppIcon name="down" :size="18" /></button>
          <button type="button" class="icon-btn" aria-label="停用" @click="toggleBook(settings, e.id, false)"><AppIcon name="close" :size="18" /></button>
        </span>
      </li>
    </ol>
    <p v-else class="empty">还没有启用词书，从下面选择一本或几本开始吧。</p>
    <div class="foot">
      <button type="button" class="link" @click="navigate('appearance', 'per-book')">
        <AppIcon name="palette" :size="16" />为不同词书设置颜色
      </button>
    </div>
  </SettingsSection>

  <SettingsSection id="mine" title="我的生词本" description="云端同步与文件导入的生词本，可与内置词书组合启用" flush>
    <template #actions>
      <button type="button" class="btn" @click="navigate('sources')"><AppIcon name="plus" :size="16" />添加</button>
    </template>
    <ul v-if="userBooks.length" class="list">
      <BookRow v-for="b in userBooks" :key="b.id" :book="b" :on="isBookEnabled(settings, b.id)" @toggle="toggleBook(settings, b.id)" />
    </ul>
    <div v-else class="empty-cta">
      <p class="muted">同步有道 / 欧路的生词本，或导入 CSV、TXT、Anki 等文件，作为自己的词书高亮。</p>
      <div class="row">
        <button type="button" class="btn primary" @click="navigate('sources', 'providers')">同步云端生词本</button>
        <button type="button" class="btn" @click="navigate('sources', 'import')">导入文件</button>
      </div>
    </div>
  </SettingsSection>

  <SettingsSection v-for="g in groups" :id="'cat-' + g.category" :key="g.category" :title="g.title" :description="g.hint" flush>
    <template v-if="g.category !== 'level'" #actions>
      <button
        type="button"
        class="btn small"
        @click="groupAll(g.books, !g.books.every((b) => isBookEnabled(settings, b.id)))"
      >
        {{ g.books.every((b) => isBookEnabled(settings, b.id)) ? '全不选' : '全选' }}
      </button>
    </template>
    <ul class="list">
      <BookRow
        v-for="b in g.books"
        :key="b.id"
        :book="b"
        :on="isBookEnabled(settings, b.id)"
        :radio="g.category === 'level'"
        @toggle="toggleInGroup(b, g.books)"
      />
    </ul>
  </SettingsSection>
</template>

<style scoped>
.hint { margin: -4px 18px 8px 30px; }
.total { white-space: nowrap; }
.enabled { list-style: none; margin: 0; padding: 0; }
.enabled li { display: flex; align-items: center; gap: 10px; padding: 8px 18px; min-height: 56px; border-top: 1px solid var(--border); }
.rank { width: 20px; text-align: center; color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.sample { width: 40px; height: 32px; display: grid; place-items: center; border-radius: 8px; background: #fff; color: #1f2328;
  border: 1px solid var(--border); font: 600 15px/1 Georgia, serif; flex: none; }
.name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops { display: flex; gap: 2px; }
.icon-btn { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.icon-btn:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.icon-btn:disabled { opacity: .3; cursor: default; }
@media (pointer: coarse) { .icon-btn { width: 40px; height: 40px; } }
.empty { margin: 0; padding: 16px 18px; color: var(--text-2); border-top: 1px solid var(--border); }
.foot { padding: 6px 12px 4px; border-top: 1px solid var(--border); }
.link { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--accent); cursor: pointer;
  min-height: var(--tap); padding: 0 6px; font-weight: 600; }
.list { list-style: none; margin: 0; padding: 0; }
.empty-cta { padding: 4px 18px 14px; display: flex; flex-direction: column; gap: 10px; }
.empty-cta p { margin: 0; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.small { min-height: 32px; padding: 4px 12px; font-size: 13px; }
@media (max-width: 480px) {
  .enabled li { padding: 8px 10px 8px 14px; gap: 8px; }
  .hint { margin: -4px 14px 8px 26px; }
}
</style>
