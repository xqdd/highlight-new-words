/**
 * 页面高亮用的颜色计算：解析 CSS 颜色、相对亮度、按对比度自动提亮/压暗。
 * 只支持主题中常见的 #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()，其他写法（命名色、hsl 等）返回 null，调用方原样使用。
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const d = hex.split('').map((c) => parseInt(c + c, 16));
      return { r: d[0]!, g: d[1]!, b: d[2]!, a: (d[3] ?? 255) / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a };
}

/** WCAG 相对亮度（0 黑 ~ 1 白） */
export function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(c: Rgba, to: Rgba, t: number): Rgba {
  return { r: c.r + (to.r - c.r) * t, g: c.g + (to.g - c.g) * t, b: c.b + (to.b - c.b) * t, a: c.a };
}

function toCss(c: Rgba): string {
  const r = (v: number) => Math.round(v);
  return c.a >= 1 ? `rgb(${r(c.r)}, ${r(c.g)}, ${r(c.b)})` : `rgba(${r(c.r)}, ${r(c.g)}, ${r(c.b)}, ${+c.a.toFixed(3)})`;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
/** 典型浅色/深色页面背景，用于估算对比度 */
export const LIGHT_PAGE_BG: Rgba = WHITE;
export const DARK_PAGE_BG: Rgba = { r: 24, g: 24, b: 27, a: 1 };

/**
 * 让文字色在给定背景上达到目标对比度：不足时逐步向白（深色背景）或黑（浅色背景）混合，尽量保留色相。
 * 已满足或无法解析时返回 null（表示无需覆盖）。
 */
export function ensureContrast(color: string, bg: Rgba, target = 4.5): string | null {
  const c = parseColor(color);
  if (!c || contrast(c, bg) >= target) return null;
  const to = luminance(bg) < 0.5 ? WHITE : BLACK;
  for (let t = 0.1; t <= 1; t += 0.05) {
    const next = mix(c, to, t);
    if (contrast(next, bg) >= target) return toCss(next);
  }
  return toCss(to);
}

/** 背景色是否“实心”（不透明度高，文字颜色应由主题自行保证可读，不随页面明暗调整） */
export function isOpaque(color: string): boolean {
  const c = parseColor(color);
  return !!c && c.a >= 0.6;
}

/** 由计算后的文字颜色判断上下文是否深色背景：浅色文字 ≈ 深色背景 */
export function isLightText(computedColor: string): boolean {
  const c = parseColor(computedColor);
  return !!c && c.a > 0.3 && luminance(c) > 0.4;
}
