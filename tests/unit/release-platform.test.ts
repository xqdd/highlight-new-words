import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { patchFirefoxManifest, GECKO_ID } from '@/core/platform/manifest';
import { originPatternOf } from '@/core/platform/permissions';
import { getPlatformVoices, speakText } from '@/core/platform/tts';
import { detectCapabilities } from '@/core/platform/capabilities';

describe('release: firefox manifest 补丁', () => {
  it('补 gecko 设置并去掉 tts 权限，保留其他字段', () => {
    const m = { permissions: ['storage', 'tts', 'tabs'], browser_specific_settings: { safari: { strict_min_version: '1' } } };
    patchFirefoxManifest(m);
    expect(m.permissions).toEqual(['storage', 'tabs']);
    const bss = m.browser_specific_settings as Record<string, any>;
    expect(bss.gecko.id).toBe(GECKO_ID);
    expect(bss.gecko.data_collection_permissions.required).toEqual(['none']);
    expect(bss.gecko_android.strict_min_version).toBe('142.0');
    expect(bss.safari).toBeDefined();
  });
});

describe('release: 权限模式', () => {
  it('URL 转源模式（去掉路径与端口）', () => {
    expect(originPatternOf('https://dav.jianguoyun.com/dav/a')).toBe('https://dav.jianguoyun.com/*');
    expect(originPatternOf('http://192.168.1.2:5005/webdav')).toBe('http://192.168.1.2/*');
  });
});

describe('release: TTS 回退到 speechSynthesis', () => {
  // 模拟 Firefox：没有扩展 tts API
  const b = browser as unknown as { tts?: unknown };
  let savedTts: unknown;
  beforeEach(() => {
    savedTts = b.tts;
    b.tts = undefined;
  });
  afterEach(() => {
    b.tts = savedTts;
    vi.unstubAllGlobals();
  });

  it('无扩展 tts 时用 speechSynthesis，按 lang 选语音', async () => {
    const spoken: any[] = [];
    const voices = [
      { name: 'Zh', lang: 'zh-CN', default: true },
      { name: 'Uk', lang: 'en-GB', default: false },
      { name: 'Us', lang: 'en-US', default: true },
    ];
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''; rate = 1; voice: any; onstart?: () => void; onerror?: (e: any) => void;
      constructor(public text: string) {}
    });
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => voices,
      cancel: () => {},
      addEventListener() {}, removeEventListener() {},
      speak: (u: any) => { spoken.push(u); u.onstart?.(); },
    });
    const res = await speakText('serendipity', { lang: 'en-US', rate: 1.2 });
    expect(res).toEqual({ spoken: true, engine: 'speech' });
    expect(spoken[0].voice.name).toBe('Us');
    expect(spoken[0].rate).toBe(1.2);
    expect((await getPlatformVoices()).map((v) => v.voiceName)).toEqual(['Zh', 'Uk', 'Us']);
    expect(detectCapabilities().speechSynthesis).toBe(true);
  });

  it('两者都没有时返回 unavailable', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    expect(await speakText('x')).toEqual({ spoken: false, reason: 'unavailable' });
  });
});
