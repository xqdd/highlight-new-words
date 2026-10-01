<script setup lang="ts">
import { computed, ref } from 'vue';
import { sendToBackground } from '@/core/messaging';
import { base64ToBytes } from '@/core/sync/codec';
import type { BackupDiffCount, BackupImportMode, BackupImportPreview } from '@/core/sync/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import BottomSheet from '@/ui/components/BottomSheet.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import FileDrop from '../components/FileDrop.vue';
import { downloadFile, readBackupFile } from '../lib/download';
import { errorText, showToast } from '../lib/toast';

/**
 * 手动备份（实现见 core/sync/backup.ts，经 background 消息 exportBackup / previewBackupImport / importBackup）：
 * - 导出：单个 JSON（可选 gzip），可选包含来源生词本缓存与凭据（凭据在文件里是明文，需额外确认）；
 * - 导入：选择文件 → 选“合并 / 覆盖” → 预览新增/删除/更新/冲突数量 → 确认（覆盖需二次确认）。
 */

// ---------- 导出 ----------
const includeSourceBooks = ref(false);
const includeCredentials = ref(false);
const compress = ref(false);
const exporting = ref(false);

async function exportNow() {
  exporting.value = true;
  try {
    const r = await sendToBackground('exportBackup', {
      includeSourceBooks: includeSourceBooks.value,
      includeCredentials: includeCredentials.value,
      compress: compress.value,
    });
    // base64ToBytes 返回的 Uint8Array 底层总是普通 ArrayBuffer，这里收窄类型以满足 BlobPart
    downloadFile(r.encoding === 'gzip-base64' ? (base64ToBytes(r.content) as Uint8Array<ArrayBuffer>) : r.content, r.fileName, r.mime);
    const c = r.counts;
    const skipped = c.skippedCredentials ? `；${c.skippedCredentials} 项凭据未包含` : '';
    showToast(`已导出：${c.knownWords} 个熟词、${c.localBooks} 本导入词书${c.sourceBooks ? `、${c.sourceBooks} 本来源生词本` : ''}${c.credentials ? `、${c.credentials} 项凭据` : ''}${skipped}`);
  } catch (err) {
    showToast('导出失败：' + errorText(err), { tone: 'error' });
  } finally {
    exporting.value = false;
  }
}

// ---------- 导入 ----------
const sheetOpen = ref(false);
const fileName = ref('');
const content = ref('');
const mode = ref<BackupImportMode>('merge');
const preview = ref<BackupImportPreview>();
const previewError = ref('');
const loading = ref(false);
const confirmOverwrite = ref(false);

async function onFile(file: File) {
  fileName.value = file.name;
  content.value = await readBackupFile(file);
  mode.value = 'merge';
  confirmOverwrite.value = false;
  sheetOpen.value = true;
  await loadPreview();
}

async function loadPreview() {
  loading.value = true;
  previewError.value = '';
  preview.value = undefined;
  try {
    preview.value = await sendToBackground('previewBackupImport', { content: content.value, mode: mode.value });
  } catch (err) {
    previewError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

function setMode(m: BackupImportMode) {
  mode.value = m;
  confirmOverwrite.value = false;
  void loadPreview();
}

async function doImport() {
  if (mode.value === 'overwrite' && !confirmOverwrite.value) {
    confirmOverwrite.value = true;
    return;
  }
  loading.value = true;
  try {
    const r = await sendToBackground('importBackup', { content: content.value, mode: mode.value });
    showToast(r.message, { tone: r.ok ? 'info' : 'error', duration: 5000 });
    if (r.ok) sheetOpen.value = false;
  } catch (err) {
    showToast('导入失败：' + errorText(err), { tone: 'error' });
  } finally {
    loading.value = false;
  }
}

/** 预览表格行：只展示备份中存在的类别 */
const rows = computed(() => {
  const p = preview.value;
  if (!p) return [];
  const list: { label: string; c: BackupDiffCount }[] = [
    { label: '熟词', c: p.knownWords },
    { label: '导入的词书', c: p.localBooks },
  ];
  if (p.sourceBooks) list.push({ label: '来源生词本', c: p.sourceBooks });
  return list;
});
const exportedAt = computed(() => (preview.value?.exportedAt ? new Date(preview.value.exportedAt).toLocaleString() : ''));
</script>

<template>
  <SettingsSection id="backup" title="手动备份" description="导出为一个文件，换电脑、重装或不想用云同步时导入恢复">
    <div class="sub">
      <h3>导出</h3>
      <ToggleSwitch v-model="includeSourceBooks" label="包含有道 / 欧路生词本缓存" description="不包含时，导入后需重新登录同步" />
      <ToggleSwitch v-model="includeCredentials" label="包含凭据（token、WebDAV 密码）" description="只包含你在下方勾选“随同步上传”的凭据；凭据在备份文件中是明文，请妥善保管文件" />
      <ToggleSwitch v-model="compress" label="压缩（.json.gz）" description="文件更小，但无法直接用文本编辑器查看" />
      <button type="button" class="btn primary" :disabled="exporting" @click="exportNow"><AppIcon name="download" :size="16" />{{ exporting ? '导出中…' : '导出备份' }}</button>
    </div>
    <div class="sub">
      <h3>导入</h3>
      <FileDrop accept=".json,.gz,application/json,application/gzip" title="选择备份文件，或拖到这里" hint="支持本扩展导出的 .json / .json.gz" compact @file="onFile" />
    </div>

    <BottomSheet v-model:open="sheetOpen" title="导入备份" :description="fileName">
      <div class="imp">
        <SegmentedControl
          :model-value="mode"
          :options="[
            { value: 'merge', label: '合并' },
            { value: 'overwrite', label: '覆盖' },
          ]"
          @update:model-value="setMode"
        />
        <p class="muted small">
          {{
            mode === 'merge'
              ? '合并：两边的数据都保留，同一项以较新的修改为准（与跨设备同步规则相同）。'
              : '覆盖：本机的设置、熟词本、导入的词书换成备份中的内容，本机多出的会被删除（并同步到其他设备）。同步配置和未包含在备份中的凭据不变。'
          }}
        </p>
        <p v-if="loading && !preview" class="muted">正在分析…</p>
        <p v-if="previewError" class="err">{{ previewError }}</p>
        <template v-if="preview">
          <p class="meta muted">备份时间 {{ exportedAt }}{{ preview.device ? ' · 来自设备 ' + preview.device.slice(0, 8) : '' }}</p>
          <div class="table" role="table" aria-label="导入预览">
            <div class="tr th" role="row">
              <span role="columnheader">类别</span><span role="columnheader">新增</span><span role="columnheader">删除</span><span role="columnheader">更新</span><span role="columnheader">冲突</span>
            </div>
            <div v-for="r in rows" :key="r.label" class="tr" role="row">
              <span role="cell">{{ r.label }}</span>
              <span role="cell" :class="{ pos: r.c.added }">{{ r.c.added }}</span>
              <span role="cell" :class="{ neg: r.c.removed }">{{ r.c.removed }}</span>
              <span role="cell">{{ r.c.updated }}</span>
              <span role="cell" :class="{ warn: r.c.conflicts }">{{ r.c.conflicts }}</span>
            </div>
          </div>
          <p class="muted small">
            设置：{{ preview.settings.willApply ? '将使用备份中的设置' : preview.settings.changed ? '本机设置较新，保留本机' : '与本机相同' }}
            <template v-if="preview.credentials.length"> · 将写入凭据：{{ preview.credentials.join('、') }}</template>
          </p>
          <p class="summary">{{ preview.summary }}</p>
          <p v-if="confirmOverwrite" class="err">再点一次“确认覆盖”：本机多出的 {{ preview.total.removed }} 项数据将被删除，且会同步到其他设备。</p>
        </template>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="sheetOpen = false">取消</button>
        <button type="button" class="btn primary" :class="{ danger: mode === 'overwrite' }" :disabled="!preview || loading" @click="doImport">
          {{ mode === 'overwrite' ? (confirmOverwrite ? '确认覆盖' : '覆盖导入') : '合并导入' }}
        </button>
      </template>
    </BottomSheet>
  </SettingsSection>
</template>

<style scoped>
.sub { display: flex; flex-direction: column; gap: 4px; }
.sub + .sub { padding-top: 10px; border-top: 1px solid var(--border); }
.sub h3 { margin: 0; font-size: 14px; }
.sub > .btn { align-self: flex-start; margin-top: 6px; }
@media (max-width: 480px) { .sub > .btn { align-self: stretch; } }
.imp { display: flex; flex-direction: column; gap: 10px; }
.small { font-size: 12px; margin: 0; }
.meta { margin: 0; font-size: 12px; }
.table { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; font-size: 13px; }
.tr { display: grid; grid-template-columns: 1.6fr repeat(4, 1fr); gap: 4px; padding: 8px 10px; }
.tr + .tr { border-top: 1px solid var(--border); }
.tr span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.th { background: var(--surface-2); color: var(--text-2); font-size: 12px; font-weight: 600; }
.pos { color: var(--success); font-weight: 650; }
.neg { color: var(--danger); font-weight: 650; }
.warn { color: var(--warn); font-weight: 650; }
.summary { margin: 0; font-weight: 600; }
.err { color: var(--danger); margin: 0; font-size: 13px; }
.btn.primary.danger { background: var(--danger); color: #fff; }
</style>
