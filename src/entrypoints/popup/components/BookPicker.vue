<script setup lang="ts">
import { computed } from 'vue';
import type { BookId } from '@/core/settings/schema';
import type { BookMeta } from '@/core/wordbook/types';
import { formatCount, groupBooks, sourceBookStatus } from '../model';
import type { MarkStyle } from '@/core/theme/themes';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import PopupIcon from './PopupIcon.vue';

/**
 * 词书快速切换（底部抽屉内容）：按类别分组的多选列表，可任意组合。
 * 新启用的词书排在末尾（优先级最低）；调整优先级与词书管理在设置页。
 */
const props = defineProps<{ books: BookMeta[]; enabled: BookId[]; markOf: (id: BookId) => MarkStyle }>();
const emit = defineEmits<{ toggle: [id: BookId, on: boolean] }>();

const groups = computed(() => groupBooks(props.books));
const now = Date.now();
</script>

<template>
  <div class="picker">
    <section v-for="g in groups" :key="g.category" class="group">
      <h3>{{ g.title }}</h3>
      <ul>
        <li v-for="b in g.books" :key="b.id">
          <label class="item" :class="{ on: enabled.includes(b.id) }">
            <input
              type="checkbox"
              :checked="enabled.includes(b.id)"
              @change="emit('toggle', b.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="box" aria-hidden="true"><PopupIcon name="check" :size="14" /></span>
            <span class="info">
              <span class="name">{{ b.name }}</span>
              <span class="meta">
                <span>{{ formatCount(b.size) }} 词</span>
                <template v-if="sourceBookStatus(b, now)">
                  <span class="sep">·</span>
                  <span :class="`tone-${sourceBookStatus(b, now)!.tone}`">{{ sourceBookStatus(b, now)!.text }}</span>
                </template>
                <template v-else-if="b.description && b.kind === 'builtin'">
                  <span class="sep">·</span><span class="desc">{{ b.nameEn }}</span>
                </template>
              </span>
            </span>
            <span v-if="enabled.includes(b.id)" class="prio" :title="`优先级第 ${enabled.indexOf(b.id) + 1}`">
              <MarkPreview :mark="markOf(b.id)" word="Aa" />
              <small>#{{ enabled.indexOf(b.id) + 1 }}</small>
            </span>
          </label>
        </li>
      </ul>
    </section>
    <p v-if="!groups.length" class="empty">词书加载中…</p>
  </div>
</template>

<style scoped>
.group + .group { margin-top: 12px; }
h3 { margin: 4px 0 6px; font-size: 12px; font-weight: 600; color: var(--text-2); letter-spacing: .04em; }
ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
li + li { border-top: 1px solid var(--border); }
.item { position: relative; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 12px; cursor: pointer; background: var(--surface); }
.item:hover { background: var(--surface-2); }
input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.box {
  display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; flex: none;
  border: 2px solid var(--border); color: transparent; transition: background .12s, border-color .12s;
}
.item.on .box { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
input:focus-visible + .box { outline: 2px solid var(--accent); outline-offset: 2px; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; gap: 4px; color: var(--text-2); font-size: 12px; min-width: 0; }
.meta > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sep { opacity: .6; }
.prio { flex: none; display: flex; flex-direction: column; align-items: center; font-weight: 650; font-size: 13px; line-height: 1.2; }
.prio small { font-size: 10px; color: var(--text-2); font-weight: 500; }
.tone-ok { color: var(--text-2); }
.tone-warn { color: #b45309; }
.tone-error { color: var(--danger); }
.tone-busy { color: var(--accent); }
.empty { color: var(--text-2); text-align: center; padding: 24px 0; }
@media (prefers-color-scheme: dark) { .tone-warn { color: #fbbf24; } }
</style>
