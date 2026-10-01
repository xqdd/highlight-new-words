<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { IMPORT_FORMATS, type ImportResult } from '@/core/import/types';
import { countPhraseEntries } from '@/core/import/parse';
import { deleteLocalBook, renameLocalBook, saveLocalBook } from '@/core/wordbook/user-store';
import type { BookMeta } from '@/core/wordbook/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import FileDrop from '../components/FileDrop.vue';
import ImportSheet, { type ImportSource } from '../components/ImportSheet.vue';
import { formatCount, isBookEnabled, relativeTime, toggleBook } from '../lib/books';
import { useOptions } from '../lib/context';
import { errorText, showToast } from '../lib/toast';

/**
 * 本地导入词书：拖拽/选择文件 → 预览（可切换格式）→ 新建或覆盖导入；列表中可启用、重命名、再次导入覆盖、删除。
 * 新导入的词书默认启用。
 */
const { settings, books } = useOptions();
const locals = computed(() => books.value.filter((b) => b.kind === 'local'));
const ACCEPT = IMPORT_FORMATS[0]!.accept;

const source = ref<ImportSource | null>(null);
const sheetOpen = ref(false);
const drop = ref<InstanceType<typeof FileDrop>>();
/** 下一次选择文件的覆盖目标（列表里点“重新导入”时设置） */
let pendingTarget = '';

async function onFile(file: File) {
  source.value = { text: await file.text(), fileName: file.name, targetId: pendingTarget || undefined };
  pendingTarget = '';
  sheetOpen.value = true;
}

function reimport(b: BookMeta) {
  pendingTarget = b.id;
  drop.value?.pick();
}

async function onConfirm(result: ImportResult, opts: { name: string; targetId: string }) {
  try {
    const meta = await saveLocalBook({
      id: opts.targetId || undefined,
      name: opts.name,
      format: result.format,
      fileName: source.value?.fileName,
      words: result.words,
    });
    if (!isBookEnabled(settings.value, meta.id)) toggleBook(settings.value, meta.id, true);
    // 短语（give up、well-known）不会在页面上高亮，结果提示里一并说明（导入预览中有完整说明）
    const phrases = countPhraseEntries(result.words);
    const phraseTip = phrases ? `；其中 ${phrases} 个短语不会在页面上高亮` : '';
    showToast(`${opts.targetId ? '已覆盖' : '已导入'}“${meta.name}”，共 ${formatCount(meta.wordCount)} 词，已启用${phraseTip}`);
  } catch (err) {
    showToast('导入失败：' + errorText(err), { tone: 'error' });
  }
}

// ---------- 行内重命名 / 删除确认 ----------
const editing = ref('');
const editName = ref('');
const confirming = ref('');

async function startRename(b: BookMeta) {
  editing.value = b.id;
  editName.value = b.name;
  confirming.value = '';
  await nextTick();
  (document.getElementById('rename-' + b.id) as HTMLInputElement | null)?.select();
}
async function commitRename(b: BookMeta) {
  const name = editName.value.trim();
  editing.value = '';
  if (name && name !== b.name) await renameLocalBook(b.id, name);
}
async function remove(b: BookMeta) {
  confirming.value = '';
  await deleteLocalBook(b.id);
  toggleBook(settings.value, b.id, false);
  const perBook = { ...settings.value.style.perBook };
  delete perBook[b.id];
  settings.value.style.perBook = perBook;
  showToast(`已删除“${b.name}”`);
}
const formatLabel = (f?: string) => IMPORT_FORMATS.find((x) => x.value === f)?.label.replace(/（.*）/, '') ?? f ?? '';
</script>

<template>
  <SettingsSection id="import" title="导入词书" description="把自己的单词表导入为一本词书，可与其他词书组合高亮">
    <FileDrop ref="drop" :accept="ACCEPT" title="拖拽文件到这里，或点击选择" hint="支持 TXT / CSV / TSV、有道导出 XML、欧路导出、Anki 纯文本" @file="onFile" />

    <ul v-if="locals.length" class="books">
      <li v-for="b in locals" :key="b.id">
        <div class="main">
          <ToggleSwitch :model-value="isBookEnabled(settings, b.id)" :aria-label="'启用 ' + b.name" @update:model-value="(v: boolean) => toggleBook(settings, b.id, v)" />
          <div class="info">
            <input
              v-if="editing === b.id"
              :id="'rename-' + b.id"
              v-model="editName"
              type="text"
              maxlength="40"
              aria-label="词书名称"
              @keydown.enter="commitRename(b)"
              @keydown.esc="editing = ''"
              @blur="commitRename(b)"
            />
            <strong v-else>{{ b.name }}</strong>
            <span class="muted">{{ formatCount(b.size) }} 词 · {{ formatLabel(b.importFormat) }} · {{ relativeTime(b.updatedAt ?? 0) }}</span>
          </div>
        </div>
        <div v-if="confirming === b.id" class="confirm">
          <span>删除后不可恢复，确定？</span>
          <button type="button" class="btn" @click="confirming = ''">取消</button>
          <button type="button" class="btn danger-fill" @click="remove(b)">删除</button>
        </div>
        <div v-else class="ops">
          <button type="button" class="icon-btn" title="重命名" aria-label="重命名" @click="startRename(b)"><AppIcon name="edit" :size="18" /></button>
          <button type="button" class="icon-btn" title="重新导入（覆盖）" aria-label="重新导入（覆盖）" @click="reimport(b)"><AppIcon name="upload" :size="18" /></button>
          <button type="button" class="icon-btn danger" title="删除" aria-label="删除" @click="confirming = b.id"><AppIcon name="trash" :size="18" /></button>
        </div>
      </li>
    </ul>

    <ImportSheet v-model:open="sheetOpen" :source="source" mode="book" :local-books="locals" @confirm="onConfirm" />
  </SettingsSection>
</template>

<style scoped>
.books { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.books li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.main { flex: 1; min-width: 200px; display: flex; align-items: center; gap: 12px; }
.main :deep(.toggle) { flex: none; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops { display: flex; gap: 2px; margin-left: auto; }
.icon-btn { width: 40px; height: 40px; border: 0; border-radius: 10px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.icon-btn:hover { background: var(--surface-2); color: var(--text); }
.icon-btn.danger:hover { color: var(--danger); background: var(--danger-soft); }
.confirm { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; font-size: 13px; }
.danger-fill { background: var(--danger); color: #fff; border-color: transparent; }
</style>
