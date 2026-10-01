<script setup lang="ts">
import { ref } from 'vue';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import { useOptions } from '../lib/context';
import { showToast } from '../lib/toast';

/** 站点规则：禁用高亮的站点（含子域名），以标签形式增删；也可在 popup 中一键禁用当前站点 */
const { settings } = useOptions();
const input = ref('');

/** 从输入中提取 hostname：支持粘贴完整网址 */
function toHost(s: string): string {
  const t = s.trim().toLowerCase();
  if (!t) return '';
  try {
    return new URL(t.includes('://') ? t : 'https://' + t).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
function add() {
  const hosts = input.value.split(/[\s,，]+/).map(toHost).filter(Boolean);
  if (!hosts.length) return showToast('请输入网址或域名', { tone: 'error' });
  settings.value.sites.disabled = [...new Set([...settings.value.sites.disabled, ...hosts])];
  input.value = '';
}
function remove(host: string) {
  settings.value.sites.disabled = settings.value.sites.disabled.filter((h) => h !== host);
  showToast(`已恢复在 ${host} 上高亮`, { action: { label: '撤销', run: () => (settings.value.sites.disabled = [...settings.value.sites.disabled, host]) } });
}
</script>

<template>
  <SettingsSection id="sites" title="站点规则" description="以下站点（含子域名）不高亮生词">
    <form class="add" @submit.prevent="add">
      <input v-model="input" type="text" inputmode="url" placeholder="例如 github.com" aria-label="添加禁用站点" autocapitalize="off" spellcheck="false" />
      <button type="submit" class="btn" :disabled="!input.trim()"><AppIcon name="plus" :size="16" />禁用</button>
    </form>
    <ul v-if="settings.sites.disabled.length" class="chips">
      <li v-for="h in settings.sites.disabled" :key="h">
        <AppIcon name="globe" :size="14" />
        <span>{{ h }}</span>
        <button type="button" :aria-label="'移除 ' + h" @click="remove(h)"><AppIcon name="close" :size="14" /></button>
      </li>
    </ul>
    <p v-else class="muted empty">还没有禁用的站点。</p>
  </SettingsSection>
</template>

<style scoped>
.add { display: flex; gap: 8px; }
.add input { flex: 1; min-width: 0; }
.chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.chips li { display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; min-height: 36px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); max-width: 100%; }
.chips span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips button { width: 30px; height: 30px; border-radius: 50%; border: 0; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.chips button:hover { background: var(--danger-soft); color: var(--danger); }
.empty { margin: 0; }
</style>
