<script setup lang="ts">
import { ref } from 'vue';
import { browser } from 'wxt/browser';
import { resetSettings } from '@/core/settings/store';
import AppIcon from '@/ui/components/AppIcon.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingRow from '@/ui/components/SettingRow.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import { useOptions } from '../lib/context';
import { showToast } from '../lib/toast';
import SitesSection from '../sections/SitesSection.vue';
import SyncSection from '../sections/SyncSection.vue';
import TtsSection from '../sections/TtsSection.vue';

/** 更多：发音、站点规则、跨设备同步、界面主题、引导与恢复默认 */
const { settings, navigate } = useOptions();
const version = browser.runtime.getManifest().version;
const confirmReset = ref(false);

async function reset() {
  confirmReset.value = false;
  settings.value = await resetSettings();
  showToast('已恢复默认设置（词书、熟词本不受影响）');
}
</script>

<template>
  <TtsSection />
  <SitesSection />
  <SyncSection />

  <SettingsSection id="ui" title="界面">
    <SettingRow label="设置页与弹窗主题" stack>
      <SegmentedControl
        v-model="settings.ui.theme"
        :options="[
          { value: 'auto', label: '跟随系统' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ]"
      />
    </SettingRow>
  </SettingsSection>

  <SettingsSection id="about" title="其他">
    <div class="links">
      <button type="button" class="btn" @click="navigate('welcome')"><AppIcon name="sparkle" :size="16" />重新运行快速设置引导</button>
      <a class="btn" href="https://github.com/XQDD/highlight_new_words" target="_blank" rel="noopener"><AppIcon name="link" :size="16" />使用说明</a>
    </div>
    <div v-if="confirmReset" class="confirm">
      <span>恢复默认设置？已导入的词书、云端生词本与熟词本不受影响。</span>
      <div class="links">
        <button type="button" class="btn" @click="confirmReset = false">取消</button>
        <button type="button" class="btn danger-fill" @click="reset">恢复默认</button>
      </div>
    </div>
    <button v-else type="button" class="btn danger" @click="confirmReset = true">恢复默认设置</button>
    <p class="muted ver">版本 {{ version }}</p>
  </SettingsSection>
</template>

<style scoped>
.links { display: flex; flex-wrap: wrap; gap: 8px; }
.links .btn { text-decoration: none; color: var(--text); }
.confirm { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: var(--danger-soft); }
.danger-fill { background: var(--danger) !important; color: #fff !important; border-color: transparent; }
.btn.danger { align-self: flex-start; }
.ver { margin: 0; }
</style>
