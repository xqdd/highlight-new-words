<script setup lang="ts">
import { computed, onScopeDispose, ref, toRaw } from 'vue';
import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import { requestOriginAccess } from '@/core/platform';
import { saveSettings } from '@/core/settings/store';
import { STORAGE_KEYS } from '@/core/storage/keys';
import type { BackendSyncStatus, SyncPhase, WebDavTestResult } from '@/core/sync/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { relativeTime } from '../lib/books';
import { useOptions } from '../lib/context';
import { errorText, showToast } from '../lib/toast';

/**
 * WebDAV 同步后端配置（settings.sync.webdav，实现见 core/sync/webdav-service.ts）：
 * 服务器预设（坚果云 / Nextcloud / 群晖）+ 地址、账号、密码（或应用密码）、目录；同步内容；自动同步方式；
 * 测试连接（逐步结果）、状态（storage `webdavSyncState`，background 写）与立即同步。
 *
 * 主机权限：Chrome/Edge 的 host_permissions 已覆盖 http/https；Firefox 可撤销，所以“测试连接”“立即同步”“开启”的点击处理里
 * 第一句就调用 platform 的 requestOriginAccess(url)（Firefox 要求在用户操作的同步调用栈内发起，之前不能有 await）。
 */
const { settings } = useOptions();
const dav = computed(() => settings.value.sync.webdav);
const status = ref<BackendSyncStatus>();

const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
  if (area === 'local' && changes[STORAGE_KEYS.webdavSyncState]) status.value = changes[STORAGE_KEYS.webdavSyncState]!.newValue as BackendSyncStatus;
};
browser.storage.onChanged.addListener(onStorage);
onScopeDispose(() => browser.storage.onChanged.removeListener(onStorage));
sendToBackground('getSyncBackends', {})
  .then((s) => (status.value = s.webdav))
  .catch(() => undefined);

interface ServerPreset {
  id: string;
  name: string;
  url: string;
  hint: string;
}
/** 常见 WebDAV 服务：点选后填入地址模板（尖括号部分需用户替换） */
const PRESETS: ServerPreset[] = [
  { id: 'jianguoyun', name: '坚果云', url: 'https://dav.jianguoyun.com/dav/', hint: '密码处填“应用密码”：坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用' },
  { id: 'nextcloud', name: 'Nextcloud', url: 'https://<服务器>/remote.php/dav/files/<用户名>/', hint: '建议在 Nextcloud 设置 → 安全 中创建应用密码' },
  { id: 'synology', name: '群晖 NAS', url: 'https://<NAS 地址>:5006/', hint: '需在套件中心安装并启用 WebDAV Server（HTTPS 默认端口 5006）' },
];
const presetHint = computed(() => PRESETS.find((p) => dav.value.url.startsWith(p.url.split('<')[0]!))?.hint);
function usePreset(p: ServerPreset) {
  settings.value.sync.webdav.url = p.url;
}

/** 地址是否完整（不含模板占位符、协议为 http/https） */
const urlError = computed(() => {
  const url = dav.value.url.trim();
  if (!url) return '';
  if (url.includes('<')) return '请把尖括号中的内容替换为你的服务器信息';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '地址需以 https:// 开头';
    return u.protocol === 'http:' ? 'http 明文传输，密码可能被截获，建议使用 https' : '';
  } catch {
    return '地址格式不正确';
  }
});
const urlValid = computed(() => !!dav.value.url.trim() && (!urlError.value || urlError.value.startsWith('http 明文')));
const complete = computed(() => urlValid.value && !!dav.value.username.trim() && !!dav.value.password);
const showPassword = ref(false);

/** 等防抖保存落盘后再让 background 读设置（webdavSyncNow 使用已保存的配置） */
function flushSettings() {
  return saveSettings(structuredClone(toRaw(settings.value)));
}

// ---------- 测试连接 ----------
const testing = ref(false);
const testResult = ref<WebDavTestResult>();
function testConnection() {
  // Firefox：权限申请必须是点击处理的第一个异步调用
  const granted = requestOriginAccess(dav.value.url.trim());
  testing.value = true;
  testResult.value = undefined;
  void granted
    .then(async (ok) => {
      if (!ok) {
        testResult.value = { ok: false, message: '没有获得访问该服务器的权限，请在浏览器弹窗中允许', steps: [] };
        return;
      }
      const { url, username, password, dir } = dav.value;
      testResult.value = await sendToBackground('webdavTest', { url: url.trim(), username: username.trim(), password, dir: dir.trim() });
    })
    .catch((err) => (testResult.value = { ok: false, message: errorText(err), steps: [] }))
    .finally(() => (testing.value = false));
}

// ---------- 开启 / 立即同步 ----------
function setEnabled(on: boolean) {
  if (!on) {
    settings.value.sync.webdav.enabled = false;
    return;
  }
  const granted = requestOriginAccess(dav.value.url.trim());
  void granted.then((ok) => {
    if (ok) {
      settings.value.sync.webdav.enabled = true;
      showToast('已开启 WebDAV 同步，稍后自动进行第一次同步');
    } else showToast('没有获得访问该服务器的权限，无法开启', { tone: 'error' });
  });
}

const syncing = ref(false);
function syncNow() {
  if (!urlValid.value) {
    showToast('请先填写正确的服务器地址', { tone: 'error' });
    return;
  }
  const granted = requestOriginAccess(dav.value.url.trim());
  syncing.value = true;
  void granted
    .then(async (ok) => {
      if (!ok) throw new Error('没有获得访问该服务器的权限');
      await flushSettings();
      status.value = await sendToBackground('webdavSyncNow', {});
      if (status.value.error) showToast('WebDAV 同步出错：' + status.value.error, { tone: 'error' });
      else showToast('WebDAV 同步完成');
    })
    .catch((err) => showToast('同步失败：' + errorText(err), { tone: 'error' }))
    .finally(() => (syncing.value = false));
}

const PHASE: Record<SyncPhase, string> = { disabled: '未开启', idle: '已同步', pending: '等待同步', syncing: '同步中', error: '出错' };
const INTERVALS = [
  { value: 0, label: '不定时' },
  { value: 15, label: '每 15 分钟' },
  { value: 30, label: '每 30 分钟' },
  { value: 60, label: '每小时' },
  { value: 180, label: '每 3 小时' },
  { value: 720, label: '每 12 小时' },
  { value: 1440, label: '每天' },
];
const kb = (n: number) => (n / 1024).toFixed(1);
</script>

<template>
  <SettingsSection id="webdav" title="WebDAV" description="同步到坚果云、Nextcloud、群晖等网盘，不受浏览器账号和 100 KB 空间限制，不同浏览器之间也能同步">
    <template #actions>
      <ToggleSwitch :model-value="dav.enabled" aria-label="开启 WebDAV 同步" :disabled="!complete" @update:model-value="setEnabled" />
    </template>

    <div class="presets" role="group" aria-label="常用服务">
      <button v-for="p in PRESETS" :key="p.id" type="button" class="chip" @click="usePreset(p)">{{ p.name }}</button>
    </div>

    <div class="form">
      <label class="field">
        <span class="label">服务器地址</span>
        <input v-model.trim="settings.sync.webdav.url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://dav.jianguoyun.com/dav/" />
        <span v-if="urlError" class="field-note" :class="{ bad: !urlValid }">{{ urlError }}</span>
        <span v-else-if="presetHint" class="field-note">{{ presetHint }}</span>
      </label>
      <div class="two">
        <label class="field">
          <span class="label">账号</span>
          <input v-model.trim="settings.sync.webdav.username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" />
        </label>
        <label class="field">
          <span class="label">密码或应用密码</span>
          <span class="pw">
            <input v-model="settings.sync.webdav.password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" />
            <button type="button" class="eye" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button>
          </span>
        </label>
      </div>
      <label class="field">
        <span class="label">目录</span>
        <input v-model.trim="settings.sync.webdav.dir" type="text" autocapitalize="off" spellcheck="false" placeholder="highlight-new-words" />
        <span class="field-note">同步文件为 目录/hnw-sync.json，目录不存在时自动创建</span>
      </label>
      <p class="muted small">密码只保存在本机，不会写进 WebDAV 上的同步文件。若想在其他设备自动填好，可在下方“凭据随同步上传”中勾选。</p>
    </div>

    <div class="row">
      <button type="button" class="btn" :disabled="!complete || testing" @click="testConnection">
        <AppIcon name="link" :size="16" />{{ testing ? '测试中…' : '测试连接' }}
      </button>
      <button v-if="dav.enabled" type="button" class="btn primary" :disabled="syncing" @click="syncNow">
        <AppIcon name="sync" :size="16" :class="{ spin: syncing }" />立即同步
      </button>
    </div>
    <div v-if="testResult" class="test" :class="testResult.ok ? 'ok' : 'bad'" role="status">
      <strong>{{ testResult.ok ? '连接正常' : '连接失败' }}</strong>
      <span>{{ testResult.message }}</span>
      <ol v-if="testResult.steps.length" class="steps">
        <li v-for="s in testResult.steps" :key="s.step" :class="{ fail: !s.ok }">
          <span class="mark">{{ s.ok ? '✓' : '✕' }}</span>{{ s.step }}<span v-if="s.detail" class="muted"> · {{ s.detail }}</span>
        </li>
      </ol>
    </div>

    <template v-if="dav.enabled">
      <div class="status">
        <div class="status-line">
          <span class="phase" :class="status?.phase">{{ status ? PHASE[status.phase] : '读取中…' }}</span>
          <span v-if="status?.lastSyncAt" class="muted">上次同步 {{ relativeTime(status.lastSyncAt) }}</span>
          <span v-if="status?.remoteBytes" class="muted">远端 {{ kb(status.remoteBytes) }} KB</span>
        </div>
        <p v-if="status?.error" class="err">{{ status.error }}</p>
        <p v-else-if="status?.notice" class="muted small">{{ status.notice }}</p>
      </div>

      <div class="sub">
        <h3>同步内容</h3>
        <ToggleSwitch v-model="settings.sync.webdav.include.settings" label="设置" />
        <ToggleSwitch v-model="settings.sync.webdav.include.knownWords" label="本地熟词本" />
        <ToggleSwitch v-model="settings.sync.webdav.include.localBooks" label="导入的词书" />
        <ToggleSwitch v-model="settings.sync.webdav.include.sourceBooks" label="有道 / 欧路生词本缓存" description="新设备不用重新登录拉取即可高亮；会增加文件大小" />
      </div>
      <div class="sub">
        <h3>自动同步</h3>
        <ToggleSwitch v-model="settings.sync.webdav.autoSync.onChange" label="数据变化后同步" description="改动后约 10 秒同步，连续改动最多等 1 分钟" />
        <ToggleSwitch v-model="settings.sync.webdav.autoSync.onStartup" label="浏览器启动时同步" />
        <label class="interval">
          <span class="label">定时同步</span>
          <select v-model.number="settings.sync.webdav.autoSync.intervalMinutes">
            <option v-for="i in INTERVALS" :key="i.value" :value="i.value">{{ i.label }}</option>
          </select>
        </label>
      </div>
    </template>
    <p v-else-if="!complete" class="muted small">填写地址、账号和密码后可以测试连接并开启。</p>
  </SettingsSection>
</template>

<style scoped>
.presets { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 4px 14px; min-height: 34px; cursor: pointer; font-size: 13px; }
.chip:hover { border-color: var(--accent); }
@media (pointer: coarse) { .chip { min-height: 40px; } }
.form { display: flex; flex-direction: column; gap: 10px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 560px) { .two { grid-template-columns: 1fr; } }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.label { font-weight: 550; font-size: 13px; }
.field input[type='url'] { font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 10px; min-height: 36px; width: 100%; }
@media (pointer: coarse) { .field input { min-height: 44px; } }
.field-note { font-size: 12px; color: var(--text-2); }
.field-note.bad { color: var(--danger); }
.pw { display: flex; gap: 6px; }
.pw input { flex: 1; min-width: 0; }
.eye { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm); padding: 0 10px; cursor: pointer; font-size: 12px; color: var(--text-2); flex: none; }
.small { font-size: 12px; margin: 0; }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 480px) { .row .btn { flex: 1; } }
.test { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
.test.ok { background: color-mix(in srgb, var(--success) 12%, transparent); }
.test.ok strong { color: var(--success); }
.test.bad { background: var(--danger-soft); }
.test.bad strong { color: var(--danger); }
.steps { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.mark { display: inline-block; width: 1.4em; color: var(--success); font-weight: 700; }
.steps li.fail .mark { color: var(--danger); }
.status { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); }
.status-line { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; }
.phase { font-weight: 700; }
.phase.idle { color: var(--success); }
.phase.error { color: var(--danger); }
.phase.pending, .phase.syncing { color: var(--accent); }
.err { color: var(--danger); margin: 0; font-size: 13px; }
.sub { display: flex; flex-direction: column; padding-top: 8px; border-top: 1px solid var(--border); }
.sub h3 { margin: 0 0 2px; font-size: 14px; }
.interval { display: flex; align-items: center; gap: 12px; min-height: var(--tap); }
.interval .label { flex: 1; font-size: 14px; }
.interval select { width: auto; min-width: 9em; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
