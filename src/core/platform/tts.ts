/**
 * 跨浏览器朗读垫片。
 *
 * - Chrome / Edge：扩展 `tts` API（`browser.tts`，service worker 中可用，能选扩展提供的语音）
 * - Firefox（桌面与 Android）：没有 `tts` API，回退到 Web Speech 的 `speechSynthesis`。
 *   Firefox MV3 后台是事件页（有 window），因此 background 中也能直接用 speechSynthesis；
 *   Chrome 的 service worker 里没有 speechSynthesis，但那里总有 `browser.tts`。
 * - 两者都没有（极少数移动端浏览器）时返回 `unavailable`，调用方可在页面上下文（内容脚本/扩展页）再调用一次本模块。
 *
 * 语音选项沿用设置中的 `tts.voice`（`chrome.tts.speak` 选项子集）：
 * `voiceName` 在 speechSynthesis 中按 `SpeechSynthesisVoice.name` 匹配，匹配不到时只按 `lang` 选择。
 */
import { browser } from 'wxt/browser';

export interface PlatformSpeakOptions {
  voiceName?: string;
  lang?: string;
  /** 只对扩展 tts 有意义（指定提供语音的扩展），speechSynthesis 忽略 */
  extensionId?: string;
  /** 语速，1 为正常（两个引擎含义一致） */
  rate?: number;
}

export type TtsEngine = 'tts' | 'speech';

export interface PlatformSpeakResult {
  spoken: boolean;
  engine?: TtsEngine;
  reason?: 'unavailable' | 'error';
}

/** 统一的语音描述（options 的语音下拉框用） */
export interface PlatformVoice {
  voiceName: string;
  lang?: string;
  extensionId?: string;
  engine: TtsEngine;
}

interface TtsApiLike {
  speak(text: string, options?: Record<string, unknown>): Promise<void>;
  stop?(): void;
  getVoices?(): Promise<Array<{ voiceName?: string; lang?: string; extensionId?: string }>>;
}

/** 扩展 tts API（Firefox 上为 undefined） */
function ttsApi(): TtsApiLike | undefined {
  const api = (browser as unknown as { tts?: TtsApiLike }).tts;
  return typeof api?.speak === 'function' ? api : undefined;
}

function speechApi(): SpeechSynthesis | undefined {
  const s = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  return s && typeof (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'function' ? s : undefined;
}

/** 当前上下文可用的朗读引擎；都不可用时为 undefined */
export function getTtsEngine(): TtsEngine | undefined {
  if (ttsApi()) return 'tts';
  if (speechApi()) return 'speech';
  return undefined;
}

/**
 * speechSynthesis 的语音列表首次读取常为空，要等 `voiceschanged`；
 * 某些平台（无语音引擎的 Linux 等）永远为空，所以最多等 timeoutMs。
 */
function loadSpeechVoices(s: SpeechSynthesis, timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      s.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(s.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    s.addEventListener('voiceschanged', done);
  });
}

/** 列出可用语音（扩展 tts 优先，否则 speechSynthesis） */
export async function getPlatformVoices(): Promise<PlatformVoice[]> {
  const tts = ttsApi();
  if (tts?.getVoices) {
    const list = await tts.getVoices().catch(() => []);
    const out: PlatformVoice[] = [];
    for (const v of list) if (v.voiceName) out.push({ voiceName: v.voiceName, lang: v.lang, extensionId: v.extensionId, engine: 'tts' });
    return out;
  }
  const s = speechApi();
  if (!s) return [];
  const voices = await loadSpeechVoices(s);
  return voices.map((v) => ({ voiceName: v.name, lang: v.lang, engine: 'speech' as const }));
}

/** 按设置挑选 speechSynthesis 语音：先精确匹配名称，再按语言前缀（en → en-US/en-GB），都没有则交给浏览器默认 */
function pickSpeechVoice(voices: SpeechSynthesisVoice[], opts: PlatformSpeakOptions): SpeechSynthesisVoice | undefined {
  if (opts.voiceName) {
    const byName = voices.find((v) => v.name === opts.voiceName);
    if (byName) return byName;
  }
  const lang = (opts.lang || 'en').toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase() === lang) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(lang.split('-')[0]! + '-') && v.default) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(lang.split('-')[0]!))
  );
}

/**
 * 朗读文本：新的朗读会打断上一条（与 chrome.tts 的 enqueue=false 一致）。
 * speechSynthesis 分支在开始播放（onstart）或出错时返回，不等整句读完。
 */
export async function speakText(text: string, opts: PlatformSpeakOptions = {}): Promise<PlatformSpeakResult> {
  const tts = ttsApi();
  if (tts) {
    const options: Record<string, unknown> = { lang: opts.lang, voiceName: opts.voiceName, extensionId: opts.extensionId, rate: opts.rate };
    // chrome.tts 对值为 undefined 的键也会校验，去掉未设置的项
    for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];
    try {
      await tts.speak(text, options);
      return { spoken: true, engine: 'tts' };
    } catch (e) {
      console.warn('[hnw] tts.speak 失败', e);
      return { spoken: false, engine: 'tts', reason: 'error' };
    }
  }

  const s = speechApi();
  if (!s) return { spoken: false, reason: 'unavailable' };
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = opts.lang || 'en';
  if (opts.rate) utter.rate = opts.rate;
  const voice = pickSpeechVoice(await loadSpeechVoices(s), opts);
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  }
  s.cancel();
  return new Promise<PlatformSpeakResult>((resolve) => {
    // 无语音引擎时部分平台既不触发 start 也不触发 error，3 秒后按“已提交”处理，避免调用方一直等待
    const timer = setTimeout(() => resolve({ spoken: true, engine: 'speech' }), 3000);
    utter.onstart = () => {
      clearTimeout(timer);
      resolve({ spoken: true, engine: 'speech' });
    };
    utter.onerror = (ev) => {
      clearTimeout(timer);
      // 被下一条朗读打断（interrupted/canceled）不算失败
      const interrupted = ev.error === 'interrupted' || ev.error === 'canceled';
      if (!interrupted) console.warn('[hnw] speechSynthesis 失败', ev.error);
      resolve(interrupted ? { spoken: true, engine: 'speech' } : { spoken: false, engine: 'speech', reason: 'error' });
    };
    s.speak(utter);
  });
}

/** 停止当前朗读 */
export function stopSpeaking(): void {
  const tts = ttsApi();
  if (tts?.stop) tts.stop();
  else speechApi()?.cancel();
}
