<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { sendToBackground } from '@/core/messaging';
import { getBrowserFamily, getPlatformVoices } from '@/core/platform';
import type { Settings } from '@/core/settings/schema';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingRow from '@/ui/components/SettingRow.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useOptions } from '../lib/context';

/**
 * 发音：自动发音开关、发音来源（只列英文/未标注语言的声音，同旧版）、语速、试听。
 * 语音列表走 platform 垫片：有 chrome.tts 时列扩展语音，Firefox / 无 tts 的移动端列 Web Speech 语音。
 * “获取更多声音”指向 Chrome 商店的 TTS 扩展，只在 Chrome 上显示（Edge/Firefox 跳过去也装不了）。
 */
const { settings } = useOptions();
interface VoiceOption { key: string; label: string; voice: Settings['tts']['voice'] }
const voices = ref<VoiceOption[]>([]);
const isChrome = getBrowserFamily() === 'chrome';

onMounted(async () => {
  const list = await getPlatformVoices().catch(() => []);
  voices.value = list
    .filter((v) => !v.lang || /^(en|xx)/i.test(v.lang))
    .map((v) => ({
      key: `${v.voiceName}|${v.lang}`,
      label: `${v.voiceName}${v.lang && !/^xx/i.test(v.lang) ? '（' + v.lang + '）' : ''}`,
      voice: { voiceName: v.voiceName, lang: v.lang, extensionId: v.extensionId },
    }));
});

function currentKey() {
  const v = settings.value.tts.voice;
  return `${v.voiceName}|${v.lang}`;
}
function select(key: string) {
  const v = voices.value.find((o) => o.key === key);
  settings.value.tts.voice = v ? v.voice : { lang: 'en' };
}
</script>

<template>
  <SettingsSection id="tts" title="发音">
    <ToggleSwitch v-model="settings.tts.enabled" label="打开卡片时自动发音" />
    <SettingRow label="声音" for-id="tts-voice" stack>
      <select id="tts-voice" :value="voices.some((v) => v.key === currentKey()) ? currentKey() : ''" @change="select(($event.target as HTMLSelectElement).value)">
        <option value="">系统默认英文</option>
        <option v-for="v in voices" :key="v.key" :value="v.key">{{ v.label }}</option>
      </select>
    </SettingRow>
    <SettingRow :label="`语速 ${settings.tts.rate.toFixed(1)}×`" for-id="tts-rate" stack>
      <input id="tts-rate" v-model.number="settings.tts.rate" type="range" min="0.5" max="2" step="0.1" />
    </SettingRow>
    <div class="row">
      <button class="btn" type="button" @click="sendToBackground('tts', { text: 'serendipity', force: true })"><AppIcon name="volume" :size="16" />试听</button>
      <a v-if="isChrome" href="https://chrome.google.com/webstore/detail/speakit/pgeolalilifpodheeocdmbhehgnkkbak" target="_blank" rel="noopener">获取更多声音</a>
    </div>
  </SettingsSection>
</template>

<style scoped>
input[type='range'] { width: 100%; accent-color: var(--accent); min-height: var(--tap); }
.row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
</style>
