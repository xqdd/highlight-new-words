/** 颜色工具：解析 #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba()，输出 #RRGGBB(AA) */
export interface ParsedColor {
  hex: string;
  alpha: number;
}

export function parseColor(input: string): ParsedColor | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) {
    const [r, g, b, a] = m[1]!.split('').map((c) => c + c);
    return { hex: `#${r}${g}${b}`, alpha: a ? parseInt(a, 16) / 255 : 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return { hex: `#${m[1]}`, alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('');
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { hex, alpha: a };
  }
  return null;
}

export function formatHexAlpha(hex: string, alpha: number): string {
  if (alpha >= 0.999) return hex;
  return hex + Math.round(Math.max(0, alpha) * 255).toString(16).padStart(2, '0');
}
