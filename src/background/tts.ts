import { browser } from 'wxt/browser';
import { getSettings } from '@/core/settings/store';

export interface SpeakResult {
  spoken: boolean;
  reason?: 'disabled' | 'unavailable' | 'error';
}

/** 已安装的语音名缓存：设置里保存的 voiceName 在另一设备（storage.sync 同步过来）上可能不存在 */
let voiceNames: Promise<Set<string>> | undefined;
function getVoiceNames(): Promise<Set<string>> {
  voiceNames ??= browser.tts
    .getVoices()
    .then((vs) => new Set(vs.map((v) => v.voiceName).filter((n): n is string => !!n)))
    .catch(() => new Set<string>());
  return voiceNames;
}

/**
 * 朗读单词（旧版 v2 行为：卡片打开时按 ttsToggle 自动发音，voice 选项透传给 chrome.tts.speak）。
 * - force=false 时遵循“自动发音”开关（卡片打开时调用）；force=true 用于发音按钮
 * - 设置的 voiceName 在本机不存在时去掉 voiceName，只按 lang 选择语音，避免静默失败
 * - 没有 chrome.tts（部分移动端浏览器）时返回 unavailable，调用方可退回页面 speechSynthesis
 * 新的朗读会打断上一条（enqueue 默认 false）。
 */
export async function speak(text: string, force = false): Promise<SpeakResult> {
  const word = text.trim();
  if (!word) return { spoken: false, reason: 'error' };
  const { tts } = await getSettings();
  if (!force && !tts.enabled) return { spoken: false, reason: 'disabled' };
  if (!browser.tts?.speak) return { spoken: false, reason: 'unavailable' };
  const voice = { ...tts.voice };
  const names = voice.voiceName ? await getVoiceNames() : undefined;
  // getVoices 失败/为空时无法判断，保留原设置
  if (voice.voiceName && names && names.size > 0 && !names.has(voice.voiceName)) {
    delete voice.voiceName;
    delete voice.extensionId;
  }
  try {
    await browser.tts.speak(word, { ...voice, rate: tts.rate });
    return { spoken: true };
  } catch (e) {
    console.warn('[hnw] TTS 失败', e);
    return { spoken: false, reason: 'error' };
  }
}
