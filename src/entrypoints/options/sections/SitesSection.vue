<script setup lang="ts">
import { computed } from 'vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import SiteRulesEditor from '../components/SiteRulesEditor.vue';
import { normalizeSiteRules, type SiteRules } from '@/core/sites/rules';
import { useOptions } from '../lib/context';
import { showToast } from '../lib/toast';

/** 生词高亮与阅读辅助可独立限定网站；未配置阅读规则时继承高亮规则。 */
const { settings } = useOptions();
const independent = computed(() => settings.value.readingSites !== undefined);
function setIndependent(enabled: boolean) {
  if (enabled) settings.value.readingSites = normalizeSiteRules({});
  else {
    const previous = settings.value.readingSites;
    delete settings.value.readingSites;
    if (previous) showToast('原文阅读已继承生词高亮规则', { action: { label: '撤销', run: () => { settings.value.readingSites = previous; } } });
  }
}
function setReadingRules(value: SiteRules) { settings.value.readingSites = value; }
</script>

<template>
  <SettingsSection id="sites" title="网站规则">
    <div class="rule-section">
      <h3>生词高亮</h3>
      <SiteRulesEditor v-model="settings.sites" label="生词高亮" />
    </div>
    <div class="rule-section reading-sites">
      <div class="reading-heading">
        <h3>原文阅读</h3>
        <label class="independent"><input type="checkbox" :checked="independent" @change="setIndependent(($event.target as HTMLInputElement).checked)">独立设置网站规则</label>
      </div>
      <SiteRulesEditor v-if="independent" :model-value="settings.readingSites!" label="原文阅读" @update:model-value="setReadingRules" />
      <p v-else class="muted inherited">继承生词高亮的网站规则</p>
    </div>
  </SettingsSection>
</template>

<style scoped>
.rule-section { min-width: 0; }
h3 { font-size: 14px; font-weight: 650; margin: 0 0 14px; }
.reading-sites { border-top: 1px solid var(--border); padding-top: 18px; margin-top: 6px; }
.reading-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.reading-heading h3 { margin: 0; }
.independent { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; }
.inherited { margin: 0; font-size: 13px; }
</style>
