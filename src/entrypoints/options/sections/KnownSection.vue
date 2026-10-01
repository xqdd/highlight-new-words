<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import type { ImportResult } from '@/core/import/types';
import { exportKnownWords, getKnownData, setKnownWords } from '@/core/known/store';
import { STORAGE_KEYS } from '@/core/storage/keys';
import AppIcon from '@/ui/components/AppIcon.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import FileDrop from '../components/FileDrop.vue';
import ImportSheet, { type ImportSource } from '../components/ImportSheet.vue';
import KnownSourcesSection from './KnownSourcesSection.vue';
import { formatCount, relativeTime } from '../lib/books';
import { errorText, showToast } from '../lib/toast';
import { IMPORT_FORMATS } from '@/core/import/types';

/**
 * 熟词本管理：搜索、按时间/字母排序、逐个或批量移除（可撤销）、手动添加、文件导入（带预览，可撤销）、导出 TXT/CSV。
 * 熟词永不高亮；卡片上“认识了”与其他设备同步过来的熟词会实时出现在这里（监听 storage）。
 * 所有写入走 core/known/store（带锁读改写 + 删除墓碑，保证跨设备合并正确）。
 */
const entries = ref<{ word: string; at: number }[]>([]);
async function load() {
  const data = await getKnownData();
  entries.value = Object.entries(data.words).map(([word, at]) => ({ word, at }));
}
const onStorage = (changes: Record<string, unknown>, area: string) => {
  if (area === 'local' && changes[STORAGE_KEYS.knownWords]) void load();
};
browser.storage.onChanged.addListener(onStorage);
onScopeDispose(() => browser.storage.onChanged.removeListener(onStorage));
void load();

// ---------- 搜索 / 排序 / 分页 ----------
const query = ref('');
const sort = ref<'recent' | 'alpha'>('recent');
const PAGE = 100;
const limit = ref(PAGE);
watch([query, sort], () => (limit.value = PAGE));

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = q ? entries.value.filter((e) => e.word.includes(q)) : [...entries.value];
  return sort.value === 'alpha' ? list.sort((a, b) => a.word.localeCompare(b.word)) : list.sort((a, b) => b.at - a.at || a.word.localeCompare(b.word));
});
const visible = computed(() => filtered.value.slice(0, limit.value));

// ---------- 选择与移除（可撤销） ----------
const selecting = ref(false);
const selected = ref(new Set<string>());
function toggleSelect(w: string) {
  const next = new Set(selected.value);
  if (next.has(w)) next.delete(w);
  else next.add(w);
  selected.value = next;
}
const allFilteredSelected = computed(() => filtered.value.length > 0 && filtered.value.every((e) => selected.value.has(e.word)));
function selectAllFiltered() {
  selected.value = allFilteredSelected.value ? new Set() : new Set(filtered.value.map((e) => e.word));
}
function exitSelect() {
  selecting.value = false;
  selected.value = new Set();
}

async function remove(words: string[]) {
  if (!words.length) return;
  try {
    await setKnownWords(words, false);
    showToast(words.length === 1 ? `已移除“${words[0]}”，将重新高亮` : `已移除 ${words.length} 个熟词`, {
      action: { label: '撤销', run: () => setKnownWords(words, true) },
    });
  } catch (err) {
    showToast('移除失败：' + errorText(err), { tone: 'error' });
  }
}
async function removeSelected() {
  await remove([...selected.value]);
  exitSelect();
}

// ---------- 手动添加 ----------
const adding = ref('');
async function add() {
  const words = [...new Set(adding.value.split(/[\s,，;；]+/).map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z][a-z'’-]*$/.test(w)))];
  if (!words.length) {
    showToast('请输入英文单词', { tone: 'error' });
    return;
  }
  const existing = new Set(entries.value.map((e) => e.word));
  const added = words.filter((w) => !existing.has(w));
  await setKnownWords(added, true);
  adding.value = '';
  showToast(added.length ? `已加入 ${added.length} 个熟词` : '这些词已在熟词本中', added.length ? { action: { label: '撤销', run: () => setKnownWords(added, false) } } : {});
}

// ---------- 导入 / 导出 ----------
const source = ref<ImportSource | null>(null);
const sheetOpen = ref(false);
async function onFile(file: File) {
  source.value = { text: await file.text(), fileName: file.name };
  sheetOpen.value = true;
}
async function onImport(result: ImportResult) {
  const existing = new Set(entries.value.map((e) => e.word));
  // 熟词按原形小写存储；导入文件中的短语也会被加入（不会被匹配到，但不影响）
  const added = [...new Set(result.words.map((w) => w.word.trim().toLowerCase()))].filter((w) => !existing.has(w));
  try {
    await setKnownWords(added, true);
    showToast(`导入 ${added.length} 个新熟词${result.words.length > added.length ? `（${result.words.length - added.length} 个已存在）` : ''}`, {
      action: added.length ? { label: '撤销', run: () => setKnownWords(added, false) } : undefined,
    });
  } catch (err) {
    showToast('导入失败：' + errorText(err), { tone: 'error' });
  }
}

async function exportAs(format: 'txt' | 'csv') {
  const text = await exportKnownWords(format);
  const url = URL.createObjectURL(new Blob([text], { type: format === 'csv' ? 'text/csv' : 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `known-words.${format}` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const ACCEPT = IMPORT_FORMATS[0]!.accept;
</script>

<template>
  <KnownSourcesSection :local-count="entries.length" />
  <SettingsSection id="known-list" title="本地熟词本" :description="`共 ${formatCount(entries.length)} 个熟词，在这里的词不会被高亮`" flush>
    <template #actions>
      <button type="button" class="btn small" :disabled="!entries.length" @click="exportAs('txt')"><AppIcon name="download" :size="16" />TXT</button>
      <button type="button" class="btn small" :disabled="!entries.length" @click="exportAs('csv')"><AppIcon name="download" :size="16" />CSV</button>
    </template>

    <form class="add" @submit.prevent="add">
      <input v-model="adding" type="text" placeholder="添加熟词，多个用空格或逗号分隔" aria-label="添加熟词" autocapitalize="off" spellcheck="false" />
      <button type="submit" class="btn primary" :disabled="!adding.trim()"><AppIcon name="plus" :size="16" />添加</button>
    </form>

    <div class="toolbar">
      <label class="search">
        <AppIcon name="search" :size="16" />
        <input v-model="query" type="search" placeholder="搜索熟词" aria-label="搜索熟词" autocapitalize="off" spellcheck="false" />
      </label>
      <SegmentedControl v-model="sort" class="sort" :options="[{ value: 'recent', label: '最近' }, { value: 'alpha', label: 'A-Z' }]" />
    </div>

    <div v-if="entries.length" class="selbar">
      <template v-if="selecting">
        <button type="button" class="btn small" @click="selectAllFiltered">{{ allFilteredSelected ? '取消全选' : `全选 ${filtered.length}` }}</button>
        <span class="muted">已选 {{ selected.size }}</span>
        <span class="spacer" />
        <button type="button" class="btn small" @click="exitSelect">取消</button>
        <button type="button" class="btn small danger-fill" :disabled="!selected.size" @click="removeSelected">移除</button>
      </template>
      <template v-else>
        <span class="muted">{{ query ? `匹配 ${filtered.length} 个` : '点 × 移除，可撤销' }}</span>
        <span class="spacer" />
        <button type="button" class="btn small" @click="selecting = true">批量选择</button>
      </template>
    </div>

    <ul v-if="visible.length" class="words" :class="{ selecting }">
      <li v-for="e in visible" :key="e.word">
        <label v-if="selecting" class="pick">
          <input type="checkbox" :checked="selected.has(e.word)" @change="toggleSelect(e.word)" />
          <span class="w">{{ e.word }}</span>
        </label>
        <span v-else class="w">{{ e.word }}</span>
        <span class="t muted">{{ e.at ? relativeTime(e.at) : '' }}</span>
        <button v-if="!selecting" type="button" class="x" :aria-label="'移除 ' + e.word" @click="remove([e.word])"><AppIcon name="close" :size="16" /></button>
      </li>
    </ul>
    <p v-else class="empty muted">{{ query ? '没有匹配的熟词' : '还没有熟词。在网页上点生词卡片里的“认识了”，或从下方导入。' }}</p>
    <button v-if="filtered.length > limit" type="button" class="more" @click="limit += PAGE * 3">显示更多（还有 {{ filtered.length - limit }} 个）</button>
  </SettingsSection>

  <SettingsSection id="known-import" title="批量导入熟词" description="已经掌握的词表（如四级词汇）一次导入，导入后可撤销">
    <FileDrop :accept="ACCEPT" title="拖拽文件到这里，或点击选择" hint="与词书导入格式相同：TXT / CSV / TSV / 有道 XML / 欧路 / Anki" compact @file="onFile" />
    <ImportSheet v-model:open="sheetOpen" :source="source" mode="known" @confirm="onImport" />
  </SettingsSection>
</template>

<style scoped>
.add { display: flex; gap: 8px; padding: 0 18px 12px; }
.add input { flex: 1; min-width: 0; }
.toolbar { display: flex; gap: 8px; padding: 0 18px 8px; align-items: center; }
.search { flex: 1; display: flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--text-2); min-width: 0; }
.search input { border: 0; padding-left: 0; outline: none; background: transparent; min-width: 0; }
.search:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.sort { flex: 0 0 120px; }
.selbar { display: flex; align-items: center; gap: 8px; padding: 4px 18px 8px; min-height: 44px; }
.spacer { flex: 1; }
.words { list-style: none; margin: 0; padding: 0 10px 6px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); column-gap: 8px;
  border-top: 1px solid var(--border); }
.words li { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 0 0 8px; border-bottom: 1px solid var(--border); }
.w { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t { font-size: 12px; white-space: nowrap; }
.pick { flex: 1; display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; min-width: 0; }
.pick input { width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
.x { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; flex: none; }
.x:hover { background: var(--danger-soft); color: var(--danger); }
.empty { padding: 16px 18px; margin: 0; border-top: 1px solid var(--border); }
.more { display: block; width: 100%; min-height: 44px; border: 0; background: transparent; color: var(--accent); font-weight: 600; cursor: pointer; }
.btn.small { min-height: 32px; padding: 4px 12px; font-size: 13px; }
.danger-fill { background: var(--danger); color: #fff; border-color: transparent; }
@media (pointer: coarse) { .btn.small { min-height: 40px; } }
@media (max-width: 480px) {
  .add, .toolbar { padding-left: 14px; padding-right: 14px; }
  .selbar { padding: 4px 14px 8px; }
  .words { grid-template-columns: 1fr; padding: 0 6px 6px; }
  .sort { flex-basis: 108px; }
}
</style>
