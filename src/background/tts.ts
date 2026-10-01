import { getPlatformVoices, getTtsEngine, speakText } from '@/core/platform/tts';
import { getSettings } from '@/core/settings/store';
import type { MsgReturn, BackgroundProtocol } from '@/core/messaging/protocol';
import type { TtsSource } from '@/core/settings/schema';

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

/** 在线发音音频缓存（来源+单词 -> base64）：同一单词反复点发音不重复下载；service worker 回收后自然清空 */
const voiceCache = new Map<string, string>();
const VOICE_CACHE_MAX = 60;

/**
 * 各在线来源的音频地址（都是非官方公开接口，2026-10 实测返回 mp3）：
 * - 有道 dictvoice：type=1 英音、type=2 美音
 * - 欧路 speakweb：txt 为 "QYN" + 单词的 base64（欧路网页版生词本里真人发音链接的写法），发音人与网页一致（美音女声、英音男声）
 */
function voiceUrl(word: string, source: Exclude<TtsSource, 'system'>): string {
  if (source === 'eudic-us' || source === 'eudic-uk') {
    const voice = source === 'eudic-uk' ? 'en_uk_male' : 'en_us_female';
    return `https://api.frdic.com/api/v2/speech/speakweb?langid=en&voicename=${voice}&txt=${encodeURIComponent(`QYN${btoa(word)}`)}`;
  }
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${source === 'youdao-uk' ? 1 : 2}`;
}

/**
 * 下载真人发音（有道/欧路），转成 base64 交给调用方用 Web Audio 播放。
 * 在后台下载：扩展对 https 站点有主机权限，不受页面 CORS/CSP 限制（页面里直接用 <audio> 加载外站会被不少网站的 CSP 拦截）。
 * 失败（网络、接口变化、返回非音频）时 audio 为空，调用方退回系统语音。
 */
export async function fetchVoiceAudio(word: string, source: Exclude<TtsSource, 'system'>): Promise<{ audio?: string }> {
  const w = word.trim().toLowerCase();
  // 只有英文字母、连字符、撇号、空格的才请求（欧路 txt 用 btoa 编码，非 Latin-1 字符会抛错）
  if (!w || !/^[a-z' -]+$/.test(w)) return {};
  const key = `${source}:${w}`;
  const hit = voiceCache.get(key);
  if (hit) return { audio: hit };
  try {
    // 不带 cookie：发音接口无需登录，也避免把词典的登录态附在这类请求上（隐私政策中的承诺）
    const res = await fetch(voiceUrl(w, source), { credentials: 'omit' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio/')) return {};
    const bytes = new Uint8Array(await res.arrayBuffer());
    // 分块拼字符串再 btoa：一次性 String.fromCharCode(...bytes) 在大数组上会超出参数个数上限
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const audio = btoa(bin);
    voiceCache.set(key, audio);
    if (voiceCache.size > VOICE_CACHE_MAX) voiceCache.delete(voiceCache.keys().next().value!);
    return { audio };
  } catch {
    return {};
  }
}
