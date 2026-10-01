import { getPlatformVoices, getTtsEngine, speakText } from '@/core/platform/tts';
import { getSettings } from '@/core/settings/store';
import type { MsgReturn, BackgroundProtocol } from '@/core/messaging/protocol';

export type SpeakResult = MsgReturn<BackgroundProtocol, 'tts'>;

/** 已安装的语音名缓存：设置里保存的 voiceName 在另一设备（storage.sync 同步过来）上可能不存在 */
let voiceNames: Promise<Set<string>> | undefined;
function getVoiceNames(): Promise<Set<string>> {
  voiceNames ??= getPlatformVoices()
    .then((vs) => new Set(vs.map((v) => v.voiceName).filter(Boolean)))
    .catch(() => new Set<string>());
  return voiceNames;
}

/**
 * 朗读单词（旧版 v2 行为：卡片打开时按 ttsToggle 自动发音，voice 选项透传给 chrome.tts.speak）。
 * 引擎选择交给 platform 垫片 speakText：
 * - Chrome / Edge：扩展 tts API（service worker 中可用）
 * - Firefox：没有 tts API，事件页后台用 speechSynthesis（Web Speech）
 * - 两者都没有（无 chrome.tts 的移动端 Chromium，SW 中也没有 speechSynthesis）：返回 fallback 参数，
 *   sendToBackground 会在调用方页面上下文（内容脚本 / popup / options）用 Web Speech 朗读，调用方无需额外处理
 * - force=false 时遵循“自动发音”开关（卡片打开时调用）；force=true 用于发音按钮
 * - 设置的 voiceName 在本机不存在时去掉 voiceName，只按 lang 选择语音，避免静默失败
 * 新的朗读会打断上一条（enqueue 默认 false）。
 */
export async function speak(text: string, force = false): Promise<SpeakResult> {
  const word = text.trim();
  if (!word) return { spoken: false, reason: 'error' };
  const { tts } = await getSettings();
  if (!force && !tts.enabled) return { spoken: false, reason: 'disabled' };
  const voice = { ...tts.voice };
  if (!getTtsEngine()) return { spoken: false, reason: 'unavailable', fallback: { text: word, lang: voice.lang, voiceName: voice.voiceName, rate: tts.rate } };
  const names = voice.voiceName ? await getVoiceNames() : undefined;
  // getVoices 失败/为空时无法判断，保留原设置
  if (voice.voiceName && names && names.size > 0 && !names.has(voice.voiceName)) {
    delete voice.voiceName;
    delete voice.extensionId;
  }
  const res = await speakText(word, { ...voice, rate: tts.rate });
  return res.spoken ? { spoken: true } : { spoken: false, reason: res.reason ?? 'error' };
}
