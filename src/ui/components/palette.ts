import type { MarkStyle } from '@/core/theme/themes';
import { formatHexAlpha, parseColor } from '@/ui/color';

/**
 * 配色工具（options / popup 共用，纯函数便于单测）：
 * - 预设色板：参照不背单词“下划线颜色”色板与 Relingo 取色器预设，挑选在浅色、深色网页上都可辨认的 12 色
 * - 高亮样式类型识别与“按颜色着色”：同一个颜色按样式类型落到背景 / 文字 / 下划线上
 * - HSV <-> HEX 转换：自绘取色器（SV 面板 + 色相条）使用
 */

export interface PaletteColor {
  name: string;
  hex: string;
}

/** 预设色板：Relingo 品牌橙排第一，其余按色相排列 */
export const HIGHLIGHT_PALETTE: readonly PaletteColor[] = [
  { name: '橙', hex: '#ff7008' },
  { name: '琥珀', hex: '#f59e0b' },
  { name: '黄', hex: '#eab308' },
  { name: '青柠', hex: '#65a30d' },
  { name: '绿', hex: '#10b981' },
  { name: '青', hex: '#0d9488' },
  { name: '天蓝', hex: '#0ea5e9' },
  { name: '蓝', hex: '#2563eb' },
  { name: '靛', hex: '#6366f1' },
  { name: '紫', hex: '#8b5cf6' },
  { name: '粉', hex: '#ec4899' },
  { name: '红', hex: '#ef4444' },
];

/** 背景型高亮使用的默认透明度：半透明底色在深浅色页面都能保持文字可读 */
export const BACKGROUND_ALPHA = 0.28;
/** “下划线 + 浅底”中浅底的透明度 */
export const TINT_ALPHA = 0.12;

/**
 * 高亮样式类型（options“样式”选择器的选项），与 MarkStyle 的对应关系：
 * - background：只有背景色
 * - text：只有文字色
 * - underline/wavy/dashed/dotted：对应 underline 线型；有背景时视为“下划线 + 浅底”
 */
export type MarkKind = 'background' | 'text' | 'underline' | 'wavy' | 'dashed' | 'dotted';

export const MARK_KINDS: { value: MarkKind; label: string }[] = [
  { value: 'background', label: '背景' },
  { value: 'text', label: '文字色' },
  { value: 'underline', label: '下划线' },
  { value: 'dashed', label: '虚线' },
  { value: 'wavy', label: '波浪线' },
  { value: 'dotted', label: '点线' },
];

export function markKind(mark: MarkStyle): MarkKind {
  if (mark.underline === 'solid') return 'underline';
  if (mark.underline !== 'none') return mark.underline;
  if (!mark.background && mark.color) return 'text';
  return 'background';
}

/**
 * 样式的主色（不含透明度），用于色板选中态、按词书分色的色块。
 * v5 多维样式：有装饰线取线色，否则背景色，否则文字色，否则边框色；“无样式”返回默认橙。
 */
export function markPrimaryColor(mark: MarkStyle): string {
  const raw =
    (mark.underline !== 'none' ? mark.underlineColor || mark.color : '') || mark.background || mark.color || mark.borderColor || '';
  return parseColor(raw)?.hex ?? '#ff7008';
}

/** 保持透明度换色：opaqueAlpha 为原色不透明时使用的透明度（背景需要半透明才不遮字） */
function recolor(raw: string, hex: string, opaqueAlpha = 1): string {
  const a = parseColor(raw)?.alpha ?? 1;
  return formatHexAlpha(hex, a < 1 ? a : opaqueAlpha);
}

/**
 * 保持样式的形态（线型、背景形态、边框、字重等）只换颜色，返回完整 MarkStyle：
 * - 装饰线、边框颜色直接替换；背景保留原透明度（原色不透明时：有装饰线用 TINT_ALPHA，否则 BACKGROUND_ALPHA）；
 * - 文字色只在它是主色（无背景、无装饰线）时替换，背景 + 文字色的组合（旧版配色）保留文字色保证对比度；
 * - “无样式”（只有行内译文）没有可换的颜色，原样返回。
 */
export function tintMark(base: MarkStyle, color: string): MarkStyle {
  const hex = parseColor(color)?.hex ?? color;
  const hasLine = base.underline !== 'none';
  const next: MarkStyle = { ...base };
  if (hasLine) next.underlineColor = hex;
  if (base.border && base.border !== 'none') next.borderColor = hex;
  if (base.background) next.background = recolor(base.background, hex, hasLine ? TINT_ALPHA : BACKGROUND_ALPHA);
  if (base.color && !base.background && !hasLine) next.color = hex;
  return next;
}

/**
 * 切换样式类型并保留主色：用于“样式”选择器。
 * withTint 仅对下划线类有效，表示叠加同色浅底（Relingo underline-annotated 样式）。
 */
export function buildMark(kind: MarkKind, color: string, withTint = false): MarkStyle {
  const hex = parseColor(color)?.hex ?? color;
  switch (kind) {
    case 'background':
      return { background: formatHexAlpha(hex, BACKGROUND_ALPHA), color: '', underline: 'none', underlineColor: '' };
    case 'text':
      return { background: '', color: hex, underline: 'none', underlineColor: '' };
    default:
      return {
        background: withTint ? formatHexAlpha(hex, TINT_ALPHA) : '',
        color: '',
        underline: kind === 'underline' ? 'solid' : kind,
        underlineColor: hex,
      };
  }
}

// ---------------- HSV ----------------

export interface Hsv {
  /** 0-360 */
  h: number;
  /** 0-1 */
  s: number;
  /** 0-1 */
  v: number;
}

export function hexToHsv(hex: string): Hsv {
  const parsed = parseColor(hex)?.hex ?? '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(parsed.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
