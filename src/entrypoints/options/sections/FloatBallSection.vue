<script setup lang="ts">
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useOptions } from '../lib/context';
import { showToast } from '../lib/toast';

/**
 * 悬浮球（v10，settings.floatBall，实现见 floatball 模块）：全局开关 + 已隐藏的网站。
 * 悬浮球只在触屏设备显示；用户在悬浮球菜单里点“在本站隐藏”后只能在这里恢复，所以列表逐个可移除（带撤销）。
 */
const { settings } = useOptions();

function restore(host: string) {
  settings.value.floatBall.hiddenSites = settings.value.floatBall.hiddenSites.filter((h) => h !== host);
  showToast(`已在 ${host} 恢复悬浮球`, {
    action: { label: '撤销', run: () => (settings.value.floatBall.hiddenSites = [...settings.value.floatBall.hiddenSites, host]) },
  });
}
</script>

<template>
  <SettingsSection id="floatball" title="悬浮球" description="手机、平板上的快捷入口：点按单词查词、本页生词、快捷设置、同步状态">
    <ToggleSwitch v-model="settings.floatBall.enabled" label="手机/平板显示悬浮球" description="只在触屏设备显示，电脑上不显示。可拖到屏幕边缘，片刻不用会半隐藏" />
    <div v-if="settings.floatBall.enabled" class="hidden-sites">
      <span class="lbl">已隐藏悬浮球的网站</span>
      <ul v-if="settings.floatBall.hiddenSites.length" class="chips">
        <li v-for="h in settings.floatBall.hiddenSites" :key="h">
          <AppIcon name="globe" :size="14" />
          <span>{{ h }}</span>
          <button type="button" :aria-label="'在 ' + h + ' 恢复悬浮球'" @click="restore(h)"><AppIcon name="close" :size="14" /></button>
        </li>
      </ul>
      <p v-else class="muted small">没有。在悬浮球菜单中点“在本站隐藏”的网站会列在这里，点 × 即可恢复。</p>
    </div>
  </SettingsSection>
</template>

<style scoped>
.hidden-sites { display: flex; flex-direction: column; gap: 8px; }
.lbl { font-size: 13px; font-weight: 600; color: var(--text-2); }
.small { font-size: 12px; margin: 0; }
.chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.chips li { display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; min-height: 36px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); max-width: 100%; }
.chips span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips button { width: 30px; height: 30px; border-radius: 50%; border: 0; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; }
.chips button:hover { background: var(--danger-soft); color: var(--danger); }
@media (pointer: coarse) { .chips button { width: 36px; height: 36px; } }
</style>
