/**
 * 播放内存中的音频数据（在线真人发音，见 background/tts.ts#fetchVoiceAudio）。
 * 用 Web Audio 解码播放而不是 <audio src>：不发起页面网络请求，不受网站 CSP（media-src）限制，内容脚本、popup、options 通用。
 * 浏览器自动播放策略：页面没有过用户交互时 AudioContext 无法启动（悬停自动发音可能遇到），此时返回 false，由调用方退回系统语音。
 */
let ctx: AudioContext | undefined;
let current: AudioBufferSourceNode | undefined;

/** 真人录音不套用语速设置：改变播放速率会连带改变音高，听起来失真 */
export async function playAudioBase64(b64: string): Promise<boolean> {
  try {
    ctx ??= new AudioContext();
    if (ctx.state !== 'running') {
      // resume 在没有用户激活时可能一直挂起，限时等待
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
      // resume 之后状态可能已变，TS 按上面的判断收窄了类型，这里重新按 AudioContextState 判断
      if ((ctx.state as AudioContextState) !== 'running') return false;
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    // 新的朗读打断上一条（与系统语音行为一致）
    current?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    current = src;
    return true;
  } catch {
    return false;
  }
}
