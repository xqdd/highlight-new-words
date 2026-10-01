import { sendToBackground } from '@/core/messaging';
import { speakText } from '@/core/platform/tts';
import type { Settings } from '@/core/settings/schema';

/**
 * 卡片发音（发音按钮与打开卡片时的自动发音共用）：先请 background 朗读（遵循 settings.tts，force=false 时受自动发音开关控制）。
 * background 没有可用朗读引擎、又没带 fallback 参数时（如没有 chrome.tts 的平台上的旧版后台）会返回 reason='unavailable'，
 * 此时在页面上下文用 platform 的 speakText（Web Speech）兜底朗读，避免完全无声（release #4）。
 * reason='disabled'（自动发音关闭）、'error' 不兜底；后台不可达（扩展已重载等）时静默。
 */
export async function speakWord(text: string, force: boolean, tts: Settings['tts']): Promise<void> {
  const res = await sendToBackground('tts', { text, force }).catch(() => undefined);
  if (res && !res.spoken && res.reason === 'unavailable') await speakText(text, { ...tts.voice, rate: tts.rate });
}
