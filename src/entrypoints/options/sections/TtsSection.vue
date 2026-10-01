<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { speakWord } from '@/content/card/speak';
import { getPlatformVoices } from '@/core/platform';
import type { Settings, TtsSource } from '@/core/settings/schema';
import AppIcon from '@/ui/components/AppIcon.vue';
import SettingRow from '@/ui/components/SettingRow.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useOptions } from '../lib/context';

/**
 * 发音：自动发音开关、发音来源（系统语音 / 有道、欧路真人发音）、系统语音的声音（只列英文/未标注语言的声音，同旧版）、语速、试听。
 * 语音列表走 platform 垫片：有 chrome.tts 时列扩展语音，Firefox / 无 tts 的移动端列 Web Speech 语音。
 */
const { settings } = useOptions();
interface VoiceOption { key: string; label: string; voice: Settings['tts']['voice'] }
const voices = ref<VoiceOption[]>([]);

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
    <SettingRow label="发音来源" for-id="tts-source" stack>
      <select id="tts-source" :value="settings.tts.source ?? 'system'" @change="settings.tts.source = ($event.target as HTMLSelectElement).value as TtsSource">
        <option value="system">系统语音</option>
        <option value="youdao-us">有道真人发音（美音）</option>
        <option value="youdao-uk">有道真人发音（英音）</option>
        <option value="eudic-us">欧路真人发音（美音）</option>
        <option value="eudic-uk">欧路真人发音（英音）</option>
      </select>
    </SettingRow>
    <p v-if="(settings.tts.source ?? 'system') !== 'system'" class="muted small">需要联网，朗读的单词会发送给所选词典；下载失败或浏览器不允许播放时自动改用下面的系统语音。</p>
    <SettingRow :label="(settings.tts.source ?? 'system') === 'system' ? '声音' : '系统语音（备用）'" for-id="tts-voice" stack>
      <select id="tts-voice" :value="voices.some((v) => v.key === currentKey()) ? currentKey() : ''" @change="select(($event.target as HTMLSelectElement).value)">
        <option value="">系统默认英文</option>
        <option v-for="v in voices" :key="v.key" :value="v.key">{{ v.label }}</option>
      </select>
    </SettingRow>
    <SettingRow :label="`语速 ${settings.tts.rate.toFixed(1)}×`" for-id="tts-rate" stack>
      <input id="tts-rate" v-model.number="settings.tts.rate" type="range" min="0.5" max="2" step="0.1" />
    </SettingRow>
    <div class="row">
      <button class="btn" type="button" @click="speakWord('serendipity', true, settings.tts)"><AppIcon name="volume" :size="16" />试听</button>
    </div>
  </SettingsSection>
</template>

<style scoped>
input[type='range'] { width: 100%; accent-color: var(--accent); min-height: var(--tap); }
.row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
</style>
