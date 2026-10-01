/**
 * YouTube 字幕内生词译文（注解）的样式：契约、缺省值、内置预设、解析与预设匹配。
 * 字幕压在视频画面上，样式与页面行内译文（TranslationStyle）相互独立：缺省是近黑底 + 暖黄字，
 * 视频画面再亮、用户把字幕背景调成透明时仍清楚。渲染见 content/sites/youtube/captions.ts#buildCaptionCss。
 */
import type { TranslationBracket } from './themes';

/** 字幕注解样式（存于 Settings.youtube.captionStyle，所有字段可选，缺省值见 CAPTION_STYLE_DEFAULTS） */
export interface CaptionGlossStyle {
  /** 注解文字颜色，空串=跟随字幕文字颜色（缺省 undefined 为暖黄） */
  color?: string;
  /** 注解底色，空串=无底色（改用黑色描边保证可读） */
  background?: string;
  /** 注解字号相对字幕字号的比例 0.55–1（不低于字幕字号的 55%，否则手机上看不清） */
  fontScale?: number;
  /** 括号（上方、下方、词后都适用），缺省不加 */
  bracket?: TranslationBracket;
  bold?: boolean;
  italic?: boolean;
}

export interface ResolvedCaptionGlossStyle {
  color: string;
  background: string;
  fontScale: number;
  bracket: TranslationBracket;
  bold: boolean;
  italic: boolean;
}

/** 缺省（即改造前的固定样式）：近乎不透明的近黑底 + 暖黄字（对比度 ≥ 7:1），字号为字幕字号的 0.64 */
export const CAPTION_STYLE_DEFAULTS: ResolvedCaptionGlossStyle = {
  color: '#ffe08a',
  background: 'rgba(0,0,0,.86)',
  fontScale: 0.64,
  bracket: 'none',
  bold: false,
  italic: false,
};

export interface CaptionGlossPreset {
  id: string;
  name: string;
  desc: string;
  style: CaptionGlossStyle;
}

/**
 * 内置字幕注解预设：选用时先清回缺省再写入预设字段（见 applyCaptionPreset）。
 * 无底色的预设靠黑色描边保证在亮画面上可读；浅色底预设配深色字。
 */
export const CAPTION_GLOSS_PRESETS: readonly CaptionGlossPreset[] = [
  { id: 'classic', name: '暖黄深底', desc: '默认，近黑底 + 暖黄字，任何画面都清楚', style: {} },
  { id: 'white', name: '白字深底', desc: '与字幕同色，靠深底区分', style: { color: '#ffffff' } },
  { id: 'cyan', name: '青字深底', desc: '冷色注解，和暖色画面区分开', style: { color: '#67e8f9' } },
  { id: 'outline', name: '黄字描边', desc: '无底色，黑色描边，不遮挡画面', style: { background: '' } },
  { id: 'gray-bracket', name: '灰字括号', desc: '无底色浅灰字加括号，最低调', style: { color: '#e5e7eb', background: '', bracket: 'paren' } },
  { id: 'tag', name: '黄底黑字', desc: '亮黄标签，扫一眼就看到', style: { color: '#1f2328', background: 'rgba(255,224,138,.95)', bold: true } },
  { id: 'large', name: '大字', desc: '注解字号接近字幕，适合手机', style: { fontScale: 0.8 } },
];

const PRESET_FIELDS = ['color', 'background', 'fontScale', 'bracket', 'bold', 'italic'] as const;

export function resolveCaptionStyle(s: CaptionGlossStyle | undefined): ResolvedCaptionGlossStyle {
  const d = CAPTION_STYLE_DEFAULTS;
  return {
    color: s?.color ?? d.color,
    background: s?.background ?? d.background,
    fontScale: Math.min(1, Math.max(0.55, s?.fontScale ?? d.fontScale)),
    bracket: s?.bracket ?? d.bracket,
    bold: s?.bold ?? d.bold,
    italic: s?.italic ?? d.italic,
  };
}

/** 选用预设：清掉全部样式字段后写入预设值（“暖黄深底”即回到缺省） */
export function applyCaptionPreset(current: CaptionGlossStyle | undefined, presetId: string): CaptionGlossStyle {
  const preset = CAPTION_GLOSS_PRESETS.find((p) => p.id === presetId);
  return preset ? { ...preset.style } : { ...current };
}

/** 当前样式匹配哪个预设（双方补齐缺省值后逐字段比较，颜色忽略大小写）；无匹配返回 undefined（界面显示“自定义”） */
export function matchCaptionPreset(s: CaptionGlossStyle | undefined): CaptionGlossPreset | undefined {
  const cur = resolveCaptionStyle(s);
  return CAPTION_GLOSS_PRESETS.find((p) => {
    const want = resolveCaptionStyle(p.style);
    return PRESET_FIELDS.every((f) => {
      const a = cur[f];
      const b = want[f];
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.001;
      if (typeof a === 'string' && typeof b === 'string') return a.replace(/\s/g, '').toLowerCase() === b.replace(/\s/g, '').toLowerCase();
      return a === b;
    });
  });
}
