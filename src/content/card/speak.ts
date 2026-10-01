import { sendToBackground } from '@/core/messaging';
import { playAudioBase64 } from '@/core/platform/audio';
import { speakText } from '@/core/platform/tts';
import type { Settings } from '@/core/settings/schema';

/**
 * 在线真人发音（settings.tts.source 为有道/欧路的美音、英音时）：后台下载音频、本上下文用 Web Audio 播放。
 * 返回是否已播放；来源为系统语音、下载失败或浏览器不允许自动播放时返回 false，调用方退回系统语音。
 * 卡片、popup、选项页试听共用。
 */
export async function speakOnline(text: string, tts: Settings['tts']): Promise<boolean> {
  const source = tts.source ?? 'system';
  if (source === 'system') return false;
  const res = await sendToBackground('ttsAudio', { word: text, source }).catch(() => undefined);
  return !!res?.audio && (await playAudioBase64(res.audio));
}

/**
 * 卡片发音（发音按钮与打开卡片时的自动发音共用）：
 * 1. 选了在线真人发音时先用它（force=false 时同样受自动发音开关控制），失败退回系统语音；
 * 2. 系统语音请 background 朗读（遵循 settings.tts，force=false 时受自动发音开关控制）。
 *    background 没有可用朗读引擎、又没带 fallback 参数时（如没有 chrome.tts 的平台上的旧版后台）会返回 reason='unavailable'，
 *    此时在页面上下文用 platform 的 speakText（Web Speech）兜底朗读，避免完全无声（release #4）。
 *    reason='disabled'（自动发音关闭）、'error' 不兜底；后台不可达（扩展已重载等）时静默。
 */
export async function speakWord(text: string, force: boolean, tts: Settings['tts']): Promise<void> {
  if (!force && !tts.enabled) return;
  if (await speakOnline(text, tts)) return;
  const res = await sendToBackground('tts', { text, force }).catch(() => undefined);
  if (res && !res.spoken && res.reason === 'unavailable') await speakText(text, { ...tts.voice, rate: tts.rate });
}
