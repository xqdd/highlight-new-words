<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import { STORAGE_KEYS } from '@/core/storage/keys';
import type { SegmentSyncState, SyncPhase, SyncStatus } from '@/core/sync/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { relativeTime } from '../lib/books';
import { useOptions } from '../lib/context';
import { errorText, showToast } from '../lib/toast';

/**
 * storage.sync 跨设备同步：总开关、分类开关、用量（字节/项数进度条）、各数据段状态、最近同步时间与错误、立即同步。
 * 状态由 background 写入 storage `syncState`，这里只读并监听。
 */
const { settings } = useOptions();
const status = ref<SyncStatus>();

const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
  if (area === 'local' && changes[STORAGE_KEYS.syncState]) status.value = changes[STORAGE_KEYS.syncState]!.newValue as SyncStatus;
};
browser.storage.onChanged.addListener(onStorage);
onScopeDispose(() => browser.storage.onChanged.removeListener(onStorage));
sendToBackground('getSyncStatus', {})
  .then((s) => (status.value = s))
  .catch(() => undefined);

const syncing = ref(false);
async function syncNow() {
  syncing.value = true;
  try {
    status.value = await sendToBackground('syncNow', {});
    showToast(status.value.error ? '同步出错：' + status.value.error : '同步完成', { tone: status.value.error ? 'error' : 'info' });
  } catch (err) {
    showToast('同步失败：' + errorText(err), { tone: 'error' });
  } finally {
    syncing.value = false;
  }
}

const PHASE: Record<SyncPhase, string> = { disabled: '未开启', idle: '已同步', pending: '等待同步', syncing: '同步中', error: '出错' };
const STATE: Record<SegmentSyncState, { label: string; tone: string }> = {
  synced: { label: '已同步', tone: 'ok' },
  reduced: { label: '仅单词', tone: 'warn' },
  skipped: { label: '超出配额', tone: 'err' },
  kept: { label: '保留远端', tone: 'muted' },
};
const KIND_LABEL: Record<string, string> = { settings: '设置', knownWords: '熟词本', localBooks: '导入的词书' };

const usage = computed(() => status.value?.usage);
const pct = computed(() => (usage.value ? Math.min(100, (usage.value.bytes / usage.value.quotaBytes) * 100) : 0));
const kb = (n: number) => (n / 1024).toFixed(1);
const segLabel = (s: { kind: string; label: string }) => (s.kind === 'localBooks' ? s.label : KIND_LABEL[s.kind] ?? s.label);
</script>

<template>
  <SettingsSection id="sync" title="跨设备同步" description="设置、熟词本与导入的词书通过浏览器账号（chrome.storage.sync）同步；云端生词本各设备自行拉取">
    <ToggleSwitch v-model="settings.sync.enabled" label="开启跨设备同步" description="需要浏览器登录账号并开启“扩展程序”同步" />
    <template v-if="settings.sync.enabled">
      <div class="kinds">
        <ToggleSwitch v-model="settings.sync.include.settings" label="设置" />
        <ToggleSwitch v-model="settings.sync.include.knownWords" label="熟词本" />
        <ToggleSwitch v-model="settings.sync.include.localBooks" label="导入的词书" description="空间不足时先只同步单词、再按大小跳过" />
      </div>

      <div class="status">
        <div class="status-line">
          <span class="phase" :class="status?.phase">{{ status ? PHASE[status.phase] : '读取中…' }}</span>
          <span v-if="status?.lastPushAt || status?.lastPullAt" class="muted">
            上次上传 {{ relativeTime(status.lastPushAt) }} · 下载 {{ relativeTime(status.lastPullAt) }}
          </span>
          <span class="spacer" />
          <button type="button" class="btn small" :disabled="syncing" @click="syncNow"><AppIcon name="sync" :size="16" :class="{ spin: syncing }" />立即同步</button>
        </div>
        <p v-if="status?.error" class="err">{{ status.error }}</p>
        <template v-if="usage">
          <div class="meter" role="meter" :aria-valuenow="Math.round(pct)" aria-valuemin="0" aria-valuemax="100" aria-label="同步空间用量">
            <span :style="{ width: pct + '%' }" :class="{ high: pct > 85 }" />
          </div>
          <div class="usage muted">
            <span>已用 {{ kb(usage.bytes) }} / {{ kb(usage.quotaBytes) }} KB</span>
            <span>{{ usage.items }} / {{ usage.maxItems }} 项</span>
          </div>
          <ul class="segs">
            <li v-for="s in usage.segments" :key="s.id">
              <span class="seg-name">{{ segLabel(s) }}</span>
              <span class="muted">{{ kb(s.bytes) }} KB</span>
              <span class="badge" :class="STATE[s.state].tone">{{ STATE[s.state].label }}</span>
            </li>
          </ul>
        </template>
      </div>
    </template>
  </SettingsSection>
</template>

<style scoped>
.kinds { display: flex; flex-direction: column; padding-left: 12px; border-left: 2px solid var(--border); }
.status { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: var(--surface-2); }
.status-line { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; }
.phase { font-weight: 700; }
.phase.idle { color: var(--success); }
.phase.error { color: var(--danger); }
.phase.pending, .phase.syncing { color: var(--accent); }
.spacer { flex: 1; }
.meter { height: 8px; border-radius: 999px; background: var(--border); overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--accent); border-radius: inherit; transition: width .3s; }
.meter span.high { background: var(--danger); }
.usage { display: flex; justify-content: space-between; font-size: 12px; }
.segs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.segs li { display: flex; align-items: center; gap: 10px; min-height: 36px; border-top: 1px solid var(--border); font-size: 13px; }
.seg-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--surface); color: var(--text-2); font-weight: 600; white-space: nowrap; }
.badge.ok { color: var(--success); }
.badge.warn { color: var(--warn); }
.badge.err { color: var(--danger); background: var(--danger-soft); }
.err { color: var(--danger); margin: 0; font-size: 13px; }
.btn.small { min-height: 32px; padding: 4px 12px; font-size: 13px; }
@media (pointer: coarse) { .btn.small { min-height: 40px; } }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
