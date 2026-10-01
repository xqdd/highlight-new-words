<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { parseWordList } from '@/core/import/parse';
import { IMPORT_FORMATS, type ImportFormatOption, type ImportResult } from '@/core/import/types';
import type { BookMeta } from '@/core/wordbook/types';
import BottomSheet from '@/ui/components/BottomSheet.vue';

/**
 * 导入预览弹层：读入文件后先预览再确认（格式可手动切换并即时重新解析）。
 * - mode=book：可填词书名、选择“新建”或“覆盖已有本地词书”
 * - mode=known：导入熟词本，只合并单词
 * 解析在本页面进行（有道 XML 依赖 DOMParser）。
 */
export interface ImportSource {
  text: string;
  fileName: string;
  /** 覆盖导入时预选的目标词书 */
  targetId?: string;
}
const open = defineModel<boolean>('open', { required: true });
const props = defineProps<{ source: ImportSource | null; mode: 'book' | 'known'; localBooks?: BookMeta[] }>();
const emit = defineEmits<{ confirm: [result: ImportResult, opts: { name: string; targetId: string }] }>();

const format = ref<ImportFormatOption>('auto');
const name = ref('');
const targetId = ref('');
const PREVIEW_ROWS = 50;

watch(
  () => props.source,
  (s) => {
    if (!s) return;
    format.value = 'auto';
    targetId.value = s.targetId ?? '';
    name.value = s.fileName.replace(/\.[^.]+$/, '');
  },
  { immediate: true },
);

const result = computed<ImportResult | { error: string } | null>(() => {
  if (!props.source) return null;
  try {
    return parseWordList({ text: props.source.text, fileName: props.source.fileName, format: format.value });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});
const ok = computed(() => (result.value && 'words' in result.value ? result.value : null));
const formatLabel = (v: string) => IMPORT_FORMATS.find((f) => f.value === v)?.label ?? v;
const target = computed(() => props.localBooks?.find((b) => b.id === targetId.value));

function confirm() {
  if (!ok.value || ok.value.words.length === 0) return;
  emit('confirm', ok.value, { name: (target.value?.name ?? name.value).trim() || '导入的词书', targetId: targetId.value });
  open.value = false;
}
</script>

<template>
  <BottomSheet v-model:open="open" :title="mode === 'book' ? '导入词书' : '导入熟词'" :description="source?.fileName">
    <div class="form">
      <label class="field">
        <span class="muted">文件格式</span>
        <select v-model="format">
          <option v-for="f in IMPORT_FORMATS" :key="f.value" :value="f.value">
            {{ f.value === 'auto' && ok ? `自动识别（${formatLabel(ok.format)}）` : f.label }}
          </option>
        </select>
      </label>
      <template v-if="mode === 'book'">
        <label v-if="localBooks?.length" class="field">
          <span class="muted">导入到</span>
          <select v-model="targetId">
            <option value="">新建词书</option>
            <option v-for="b in localBooks" :key="b.id" :value="b.id">覆盖：{{ b.name }}</option>
          </select>
        </label>
        <label v-if="!targetId" class="field">
          <span class="muted">词书名称</span>
          <input v-model="name" type="text" maxlength="40" />
        </label>
      </template>
    </div>

    <p v-if="result && 'error' in result" class="err">解析失败：{{ result.error }}</p>
    <template v-else-if="ok">
      <div class="stats">
        <span><b>{{ ok.words.length }}</b> 个单词</span>
        <span v-if="ok.skipped">跳过 {{ ok.skipped }} 行</span>
        <span>{{ ok.words.filter((w) => w.trans).length }} 个带释义</span>
      </div>
      <details v-if="ok.warnings.length" class="warns">
        <summary>{{ ok.warnings.length }} 条提示</summary>
        <ul><li v-for="(w, i) in ok.warnings" :key="i">{{ w }}</li></ul>
      </details>
      <div v-if="ok.words.length" class="table" role="table" aria-label="导入预览">
        <div v-for="w in ok.words.slice(0, PREVIEW_ROWS)" :key="w.word" class="tr" role="row">
          <span class="w" role="cell">{{ w.word }}</span>
          <span class="p" role="cell">{{ w.phonetic }}</span>
          <span class="t" role="cell">{{ w.trans }}</span>
        </div>
        <div v-if="ok.words.length > PREVIEW_ROWS" class="more muted">… 另外 {{ ok.words.length - PREVIEW_ROWS }} 个</div>
      </div>
      <p v-else class="err">没有识别到英文单词，试试切换文件格式。</p>
    </template>

    <template #footer>
      <button type="button" class="btn" @click="open = false">取消</button>
      <button type="button" class="btn primary" :disabled="!ok?.words.length" @click="confirm">
        {{ mode === 'known' ? `加入 ${ok?.words.length ?? 0} 个熟词` : target ? `覆盖导入 ${ok?.words.length ?? 0} 词` : `导入 ${ok?.words.length ?? 0} 词` }}
      </button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.stats { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 14px 0 8px; color: var(--text-2); }
.stats b { color: var(--text); font-size: 18px; }
.warns { font-size: 13px; color: var(--warn); margin-bottom: 8px; }
.warns ul { margin: 4px 0; padding-left: 18px; }
.table { border: 1px solid var(--border); border-radius: 10px; max-height: 260px; overflow: auto; font-size: 13px; }
.tr { display: grid; grid-template-columns: minmax(6em, 1fr) minmax(0, .8fr) minmax(0, 2fr); gap: 8px; padding: 6px 10px; border-top: 1px solid var(--border); }
.tr:first-child { border-top: 0; }
.w { font-weight: 600; overflow-wrap: anywhere; }
.p, .t { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { padding: 6px 10px; border-top: 1px solid var(--border); }
.err { color: var(--danger); }
@media (max-width: 480px) { .tr { grid-template-columns: minmax(6em, 1fr) minmax(0, 1.6fr); } .p { display: none; } }
</style>
