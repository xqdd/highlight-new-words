<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import { createDefaultSourceSettings } from '@/core/settings/defaults';
import { SOURCE_PROVIDER_INFOS } from '@/core/source/providers';
import { STORAGE_KEYS } from '@/core/storage/keys';
import { getSourceIndex } from '@/core/wordbook/user-store';
import type { BookMeta, SourceBookIndex, SourceSyncStatus } from '@/core/wordbook/types';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { formatCount, isBookEnabled, relativeTime, toggleBook } from '../lib/books';
import { useOptions } from '../lib/context';
import { errorText, showToast } from '../lib/toast';

/**
 * 云端生词本来源（有道 / 欧路 / 将来更多）：每个来源一张卡片，列出其下的多个远端生词本，
 * 每本独立显示词数、同步状态与时间、错误，可单独同步与启用；来源级设置：自动同步、标记熟词时删除、API token。
 * 来源列表按 SOURCE_PROVIDER_INFOS 渲染，新增来源无需改 UI。
 */
const { settings, books } = useOptions();

// 来源级状态（列表刷新时间/错误）只在 sourceBooks 索引中，useBooks 不带，这里单独读取并监听
const index = ref<SourceBookIndex>({ books: {}, providers: {} });
const loadIndex = async () => (index.value = await getSourceIndex());
const onStorage = (changes: Record<string, unknown>, area: string) => {
  if (area === 'local' && changes[STORAGE_KEYS.sourceBooks]) void loadIndex();
};
browser.storage.onChanged.addListener(onStorage);
onScopeDispose(() => browser.storage.onChanged.removeListener(onStorage));
void loadIndex();

/** 正在进行的操作：providerId 或 bookId */
const busy = ref(new Set<string>());
function setBusy(key: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(key);
  else next.delete(key);
  busy.value = next;
}

const providers = computed(() =>
  SOURCE_PROVIDER_INFOS.map((info) => {
    const list = books.value.filter((b) => b.kind === 'source' && b.providerId === info.id);
    const lastSync = Math.max(0, ...list.map((b) => b.sync?.lastSyncAt ?? 0));
    return {
      info,
      // settings.sources[id] 的响应式引用，模板中直接 v-model；normalizeSettings 已按默认值补齐已知来源
      cfg: settings.value.sources[info.id] ?? createDefaultSourceSettings(),
      books: list,
      words: list.reduce((n, b) => n + b.size, 0),
      lastSync,
      listError: index.value.providers[info.id]?.error,
    };
  }),
);

async function syncProvider(providerId: string, bookIds?: string[]) {
  const key = bookIds?.[0] ?? providerId;
  setBusy(key, true);
  try {
    const results = await sendToBackground('syncSourceBooks', { providerId, bookIds });
    if (!results.length) showToast('没有可同步的生词本，请确认已登录');
    else {
      const failed = results.filter((r) => !r.ok);
      const words = results.reduce((n, r) => n + (r.count ?? 0), 0);
      if (failed.length) showToast(failed.map((r) => r.message).join('；'), { tone: 'error' });
      else showToast(`同步完成：${results.length} 本，共 ${formatCount(words)} 词`);
    }
  } catch (err) {
    showToast('同步失败：' + errorText(err), { tone: 'error' });
  } finally {
    setBusy(key, false);
  }
}

async function refreshList(providerId: string) {
  setBusy(providerId, true);
  try {
    const list = await sendToBackground('refreshSourceBooks', { providerId });
    showToast(`发现 ${list.length} 个生词本`);
  } catch (err) {
    showToast('获取生词本列表失败：' + errorText(err), { tone: 'error' });
  } finally {
    setBusy(providerId, false);
  }
}

const STATUS: Record<SourceSyncStatus, { label: string; tone: string }> = {
  never: { label: '未同步', tone: 'muted' },
  syncing: { label: '同步中', tone: 'info' },
  ok: { label: '已同步', tone: 'ok' },
  empty: { label: '为空', tone: 'warn' },
  error: { label: '失败', tone: 'err' },
};
function bookStatus(b: BookMeta) {
  if (busy.value.has(b.id)) return STATUS.syncing;
  return STATUS[b.sync?.status ?? 'never'];
}

function open(url: string) {
  void browser.tabs.create({ url });
}
const initial = (name: string) => name.slice(0, 1);
</script>

<template>
  <div id="providers" class="providers">
    <SettingsSection v-for="p in providers" :id="'provider-' + p.info.id" :key="p.info.id" :title="p.info.name" flush>
      <template #actions>
        <ToggleSwitch v-model="p.cfg.enabled" :aria-label="'启用' + p.info.name" />
      </template>

      <div class="summary">
        <span class="logo" :class="p.info.id">{{ initial(p.info.name) }}</span>
        <div class="sum-text">
          <template v-if="p.cfg.enabled">
            <strong>{{ p.books.length ? `${p.books.length} 个生词本 · ${formatCount(p.words)} 词` : '尚未同步' }}</strong>
            <span class="muted">{{ p.lastSync ? '上次同步 ' + relativeTime(p.lastSync) : '登录网页版后点击“同步”' }}</span>
          </template>
          <span v-else class="muted">已关闭：不自动同步，已同步的生词本仍可在词书页启用</span>
        </div>
      </div>

      <template v-if="p.cfg.enabled">
        <div class="actions">
          <button type="button" class="btn primary" :disabled="busy.has(p.info.id)" @click="syncProvider(p.info.id)">
            <AppIcon name="sync" :size="16" :class="{ spin: busy.has(p.info.id) }" />{{ busy.has(p.info.id) ? '同步中…' : '全部同步' }}
          </button>
          <button v-if="p.info.capabilities.multiBook" type="button" class="btn" :disabled="busy.has(p.info.id)" @click="refreshList(p.info.id)">
            <AppIcon name="refresh" :size="16" />刷新列表
          </button>
          <button type="button" class="btn" @click="open(p.info.loginUrl)"><AppIcon name="link" :size="16" />登录网页版</button>
        </div>
        <p v-if="p.listError" class="err">{{ p.listError }}</p>

        <ul v-if="p.books.length" class="books">
          <li v-for="b in p.books" :key="b.id">
            <ToggleSwitch :model-value="isBookEnabled(settings, b.id)" :aria-label="'启用 ' + (b.sync?.name ?? b.name)" @update:model-value="(v: boolean) => toggleBook(settings, b.id, v)" />
            <div class="info">
              <div class="line">
                <strong>{{ b.sync?.name ?? b.name }}</strong>
                <span class="badge" :class="bookStatus(b).tone">{{ bookStatus(b).label }}</span>
                <span v-if="b.sync?.orphaned" class="badge warn">远端已删除</span>
              </div>
              <span class="muted">{{ formatCount(b.size) }} 词 · {{ b.sync?.lastSyncAt ? relativeTime(b.sync.lastSyncAt) : '从未同步' }}</span>
              <span v-if="(b.sync?.status === 'error' || b.sync?.status === 'empty') && b.sync.error" class="err small">{{ b.sync.error }}</span>
            </div>
            <button type="button" class="icon-btn" :disabled="busy.has(b.id) || busy.has(p.info.id)" :aria-label="'同步 ' + b.name" title="同步这一本" @click="syncProvider(p.info.id, [b.id])">
              <AppIcon name="sync" :size="18" :class="{ spin: busy.has(b.id) }" />
            </button>
          </li>
        </ul>

        <div class="settings">
          <ToggleSwitch v-model="p.cfg.autoSync" label="每天自动同步" description="打开浏览器后检查，超过 24 小时未同步的生词本自动更新" />
          <ToggleSwitch
            v-if="p.info.capabilities.delete"
            v-model="p.cfg.deleteOnKnown"
            label="标记熟词时，从该生词本删除"
            description="同时删除同一原形的各种词形（如 ran、running 对应 run）。远端删除后无法通过撤销恢复"
          />
          <div v-if="p.info.capabilities.apiToken" class="token">
            <label :for="'token-' + p.info.id">
              <span class="label">API token（可选）</span>
              <span class="muted">填写后可按生词本分类分别同步；仅保存在本机，不参与跨设备同步</span>
            </label>
            <div class="token-row">
              <input :id="'token-' + p.info.id" v-model.trim="p.cfg.apiToken" type="password" autocomplete="off" placeholder="NIS xxxxxxxx" />
              <a v-if="p.info.tokenUrl" class="btn" :href="p.info.tokenUrl" target="_blank" rel="noopener">获取</a>
            </div>
          </div>
        </div>
      </template>
    </SettingsSection>
  </div>
</template>

<style scoped>
.providers { display: flex; flex-direction: column; gap: 16px; scroll-margin-top: 72px; }
.summary { display: flex; align-items: center; gap: 12px; padding: 0 18px 12px; }
.logo { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; font-weight: 800; font-size: 18px; color: #fff; flex: none; background: #64748b; }
.logo.youdao { background: #e53935; }
.logo.eudic { background: #1e6fd9; }
.sum-text { display: flex; flex-direction: column; min-width: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 12px; }
.books { list-style: none; margin: 0; padding: 0; }
.books li { display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 18px; border-top: 1px solid var(--border); }
.books li :deep(.toggle) { flex: none; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-weight: 600; white-space: nowrap; }
.badge.ok { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
.badge.err { background: var(--danger-soft); color: var(--danger); }
.badge.warn { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
.badge.info { background: var(--accent-soft); color: var(--accent); }
.icon-btn { width: 40px; height: 40px; border: 0; border-radius: 10px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; flex: none; }
.icon-btn:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.icon-btn:disabled { opacity: .5; }
.settings { display: flex; flex-direction: column; gap: 4px; padding: 8px 18px 12px; border-top: 1px solid var(--border); }
.token { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; }
.token label { display: flex; flex-direction: column; }
.token .label { font-weight: 550; }
.token-row { display: flex; gap: 8px; }
.token-row input { flex: 1; min-width: 0; }
.err { color: var(--danger); margin: 0 18px 10px; font-size: 13px; }
.err.small { margin: 0; font-size: 12px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 480px) {
  .summary, .actions { padding-left: 14px; padding-right: 14px; }
  .books li { padding-left: 14px; padding-right: 8px; }
  .settings { padding: 8px 14px 12px; }
  .actions .btn { flex: 1 1 auto; }
}
</style>
