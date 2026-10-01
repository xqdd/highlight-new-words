<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { listSyncCredentials, type SyncCredentialInfo } from '@/core/sync/credentials';
import BottomSheet from '@/ui/components/BottomSheet.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useOptions } from '../lib/context';

/**
 * 凭据随同步上传（追加需求 v4 第 12 条，逻辑见 core/sync/credentials.ts）：
 * 每项凭据（各来源 API token、WebDAV 连接信息）默认不上传，用户逐项打开；打开前弹出风险说明需确认。
 * 后端自身的凭据不会写进它自己（WebDAV 密码不会上传到 WebDAV），由 excludedBackends 说明。
 */
const { settings } = useOptions();
const creds = computed(() => listSyncCredentials(settings.value));

const BACKEND_NAME: Record<string, string> = { 'storage-sync': '浏览器账号同步', webdav: 'WebDAV' };
const pending = ref<SyncCredentialInfo | null>(null);
// 关闭弹层（点取消、遮罩或 Esc）都视为取消
const sheetOpen = computed({ get: () => !!pending.value, set: (v) => !v && cancelUpload() });
function cancelUpload() {
  pending.value = null;
  syncToggleDom();
}

const listEl = ref<HTMLElement | null>(null);

/**
 * 把开关的原生 checkbox 拉回到设置中的真实值。
 * 打开前要先确认：点击时浏览器已把 checkbox 勾上，而设置未变、Vue 不会重渲染，开关会一直显示“开”，
 * 所以弹层打开期间和取消后都要手动复位，确认后才由设置变化把它勾上。
 */
function syncToggleDom() {
  void nextTick(() => {
    for (const c of creds.value) {
      const input = listEl.value?.querySelector<HTMLInputElement>(`[data-cred="${c.id}"] input[type=checkbox]`);
      if (input) input.checked = c.upload;
    }
  });
}

function setUpload(c: SyncCredentialInfo, on: boolean) {
  if (on) {
    pending.value = c;
    syncToggleDom();
  } else settings.value.credentialSync = { ...settings.value.credentialSync, [c.id]: false };
}
function confirmUpload() {
  if (!pending.value) return;
  settings.value.credentialSync = { ...settings.value.credentialSync, [pending.value.id]: true };
  pending.value = null;
}
const excludedText = (c: SyncCredentialInfo) => c.excludedBackends.map((b) => BACKEND_NAME[b] ?? b).join('、');
</script>

<template>
  <SettingsSection id="credentials" title="凭据随同步上传" description="token、密码默认只保存在本机，换设备需要重新填写。打开后会随同步自动带到你的其他设备">
    <div ref="listEl" class="list">
      <div v-for="c in creds" :key="c.id" class="item" :data-cred="c.id">
        <ToggleSwitch :model-value="c.upload" :label="c.label" @update:model-value="(v: boolean) => setUpload(c, v)">
          <span v-if="!c.present" class="badge">本机未填写</span>
        </ToggleSwitch>
        <p v-if="c.excludedBackends.length" class="muted small">不会上传到{{ excludedText(c) }}本身（避免用它自己的密码保存它自己）</p>
      </div>
    </div>
    <p class="muted small">此开关本身会同步到各设备；只有在设备上也打开时才会采用远端凭据。</p>

    <BottomSheet v-model:open="sheetOpen" title="确认上传凭据？" :description="pending?.label">
      <p class="risk">{{ pending?.risk }}</p>
      <template #footer>
        <button type="button" class="btn" @click="cancelUpload">取消</button>
        <button type="button" class="btn primary" @click="confirmUpload">我了解风险，打开</button>
      </template>
    </BottomSheet>
  </SettingsSection>
</template>

<style scoped>
.list { display: flex; flex-direction: column; }
.item + .item { border-top: 1px solid var(--border); }
.small { font-size: 12px; margin: 0 0 8px; }
.badge { margin-left: 8px; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.risk { margin: 0; padding: 12px; border-radius: 10px; background: color-mix(in srgb, var(--warn) 12%, transparent); line-height: 1.6; }
</style>
