import type { StatusSummary } from '@/core/messaging/protocol';
import { SOURCE_NOT_CONNECTED_TEXT } from '@/core/source/connect-status';

/**
 * 悬浮球的纯逻辑（无 DOM 依赖，便于单测）：显示条件、位置吸附与夹取、点按位置取词、拖动取词的准星位置、隐藏站点规则。
 */

/** 记忆的位置：贴哪一侧 + 垂直位置（视口高度比例 0–1，球心） */
export interface FloatBallPos {
  side: 'left' | 'right';
  y: number;
}

export const DEFAULT_POS: FloatBallPos = { side: 'right', y: 0.62 };

/** 球直径（px）：触控目标 ≥ 44px */
export const BALL_SIZE = 46;
/** 贴边时与屏幕边缘的间距（展开状态） */
export const EDGE_GAP = 8;
/**
 * 上下避让区（px）：顶部状态栏/地址栏收起区与底部系统导航条、手势条附近不放球，
 * 避免与系统手势（下拉通知、上滑回桌面）冲突；左右边缘的返回手势只在“从边缘向内滑”时触发，球离边缘留出 EDGE_GAP。
 */
export const SAFE_TOP = 72;
export const SAFE_BOTTOM = 96;

/**
 * 是否显示悬浮球：只在“主要输入是触屏、且没有悬停能力”的设备上显示（手机、平板），PC（含触屏笔记本）不显示。
 * 不用 UA 判断：桌面模式的手机浏览器 UA 是桌面的，但媒体特性仍是 coarse/none。
 */
export function isTouchPrimary(mm: (q: string) => boolean): boolean {
  return mm('(hover: none) and (pointer: coarse)');
}

/** 站点是否命中规则列表（含子域名，与 sites.disabled 的 isSiteDisabled 同口径） */
export function hostMatches(rules: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return rules.some((rule) => {
    const r = rule.trim().toLowerCase();
    return !!r && (host === r || host.endsWith('.' + r));
  });
}

/** 加入/移出站点规则（移出时连同父域规则一起去掉） */
export function toggleHostRule(rules: readonly string[], hostname: string, add: boolean): string[] {
  const host = hostname.toLowerCase();
  const rest = rules.filter((r) => {
    const rr = r.trim().toLowerCase();
    return !(rr && (host === rr || host.endsWith('.' + rr)));
  });
  return add ? [...rest, host] : rest;
}

/** 把记忆的比例位置换算成球心 y（px），夹在上下避让区之间 */
export function clampCenterY(ratio: number, viewportH: number): number {
  const min = SAFE_TOP + BALL_SIZE / 2;
  const max = Math.max(min, viewportH - SAFE_BOTTOM - BALL_SIZE / 2);
  const y = (Number.isFinite(ratio) ? ratio : DEFAULT_POS.y) * viewportH;
  return Math.min(max, Math.max(min, y));
}

/** 拖动结束：按球心横坐标吸附到较近的一侧，垂直位置记为比例 */
export function snapPosition(centerX: number, centerY: number, viewportW: number, viewportH: number): FloatBallPos {
  const side = centerX < viewportW / 2 ? 'left' : 'right';
  const y = clampCenterY(centerY / Math.max(1, viewportH), viewportH) / Math.max(1, viewportH);
  return { side, y: Math.round(y * 1000) / 1000 };
}

/** 解析存储中的位置（损坏时用默认值） */
export function parsePos(raw: unknown): FloatBallPos {
  const r = raw as Partial<FloatBallPos> | null | undefined;
  if (!r || (r.side !== 'left' && r.side !== 'right') || typeof r.y !== 'number' || !(r.y >= 0 && r.y <= 1)) return { ...DEFAULT_POS };
  return { side: r.side, y: r.y };
}

/** 英文单词（含内部撇号与连字符）：取词模式与字幕面板分词共用 */
export const WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

/**
 * 文本中 offset 处的英文单词（点按取词）：offset 落在单词内或紧挨单词末尾都算；不在单词上返回 null。
 * 返回单词及其在文本中的起止下标。
 */
export function wordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) return { word: m[0], start, end };
    if (start > offset) break;
  }
  return null;
}

/** 句子分词：交替的单词 / 非单词片段（保留原文所有字符，渲染后与原句完全一致） */
export function tokenize(text: string): Array<{ text: string; word: boolean }> {
  const out: Array<{ text: string; word: boolean }> = [];
  let last = 0;
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), word: false });
    out.push({ text: m[0], word: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), word: false });
  return out;
}

/**
 * 底栏同步状态文案：与 popup 同步行同一口径（未连接中性灰、出错红），底栏在每次打开菜单时都会出现，
 * 不把某个来源“未登录/授权失效”的原话常驻成像报错一样的提示（点按去选项页对应位置）。
 * - 有出错项（成功过之后再失败）：“X同步出错” / “N 项同步出错”，红点
 * - 只有从未同步成功过的项（never）：“X未连接”（口径见 core/source/connect-status），灰点，不算告警
 * - 其他情况沿用 background 的总述（“已全部同步”“正在同步…”“未开启任何同步”）
 */
export function syncFootText(st: Pick<StatusSummary, 'level' | 'text' | 'items'>): { level: string; text: string } {
  const errors = st.items.filter((i) => i.level === 'error');
  const idle = st.items.filter((i) => i.level === 'never');
  if (errors.length === 0 && idle.length === 0) return { level: st.level, text: st.text };
  const synced = st.items.filter((i) => i.level === 'ok').length;
  let problem: string;
  if (errors.length) problem = errors.length === 1 ? `${errors[0]!.name}同步出错` : `${errors.length} 项同步出错`;
  else if (idle.length === 1) problem = `${idle[0]!.name}${idle[0]!.text === SOURCE_NOT_CONNECTED_TEXT ? SOURCE_NOT_CONNECTED_TEXT : '尚未同步'}`;
  else problem = `${idle.length} 项${SOURCE_NOT_CONNECTED_TEXT}`;
  return {
    level: errors.length ? 'error' : 'off',
    text: synced > 0 ? `已同步 ${synced} 项 · ${problem}` : problem,
  };
}

// ---------------- 浮层坐标系（屏幕实际可见区域） ----------------

/**
 * 浮层宿主铺满的区域：屏幕实际可见区域（visualViewport），用宿主自身的局部坐标（单位 = 未缩放时的 CSS px）表示。
 *
 * 为什么不直接用 position:fixed 的视口：手机上页面横向溢出（如 nowrap 导航）时，布局视口会被撑宽到内容宽度，
 * fixed 的 left:0/right:0 抽屉跟着变宽、右侧落到屏幕外；双指放大时 fixed 元素也随页面放大、跑出屏幕。
 * 宿主用 transform 平移到可见区域左上角并按 1/scale 缩小，子元素的 fixed 以宿主为包含块，始终落在屏幕内且大小不随缩放变化。
 */
export interface OverlayFrame {
  /** 可见区域左上角相对布局视口的偏移（CSS px，即 clientX/clientY 坐标系） */
  x: number;
  y: number;
  /** 双指缩放倍数 */
  scale: number;
  /** 宿主局部坐标系下的宽高 */
  width: number;
  height: number;
}

/** 按 visualViewport 计算浮层区域；浏览器不支持 visualViewport 时退回布局视口（不平移不缩放） */
export function computeOverlayFrame(
  vv: Pick<VisualViewport, 'offsetLeft' | 'offsetTop' | 'scale' | 'width' | 'height'> | null | undefined,
  fallback: { width: number; height: number },
): OverlayFrame {
  if (!vv || !(vv.width > 0) || !(vv.height > 0)) return { x: 0, y: 0, scale: 1, ...fallback };
  const scale = vv.scale > 0 ? vv.scale : 1;
  return { x: vv.offsetLeft, y: vv.offsetTop, scale, width: vv.width * scale, height: vv.height * scale };
}

/** clientX/clientY（及 getBoundingClientRect）坐标 → 浮层宿主局部坐标 */
export function toFrameLocal(frame: OverlayFrame, clientX: number, clientY: number): { x: number; y: number } {
  return { x: (clientX - frame.x) * frame.scale, y: (clientY - frame.y) * frame.scale };
}

/** 宿主局部坐标 → clientX/clientY（toFrameLocal 的逆运算），用于在页面上按浮层中的位置取词 */
export function fromFrameLocal(frame: OverlayFrame, x: number, y: number): { x: number; y: number } {
  return { x: x / frame.scale + frame.x, y: y / frame.scale + frame.y };
}

// ---------------- 拖动取词 ----------------

/** 准星在球心正上方的距离（px，宿主局部坐标）：球半径 23 + 约 37px 间隙，避开按在球上的手指 */
export const AIM_OFFSET = 60;
/**
 * 贴边区（px，球心到左右屏幕边缘的距离）：球心在此范围内视为“挪位置”，不显示准星、松手不取词。
 * 拖到边缘是挪位置的自然动作，若此时准星恰好压在正文单词上也不应弹卡片。
 */
export const AIM_EDGE_ZONE = 56;

/**
 * 拖动中的准星位置（宿主局部坐标）：球心正上方 AIM_OFFSET；球心在贴边区内、或准星超出屏幕顶部时返回 null（不取词）。
 */
export function dragAimPoint(centerX: number, centerY: number, viewportW: number): { x: number; y: number } | null {
  if (centerX < AIM_EDGE_ZONE || centerX > viewportW - AIM_EDGE_ZONE) return null;
  const y = centerY - AIM_OFFSET;
  return y < 0 ? null : { x: centerX, y };
}

/** 取词点是否真的落在单词框内（caretRangeFromPoint 在空白处也会返回最近的字符），tol 为四周容差 */
export function pointInRect(r: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, x: number, y: number, tol: number): boolean {
  return x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol;
}
