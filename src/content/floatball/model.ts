import type { StatusSummary } from '@/core/messaging/protocol';

/**
 * 悬浮球的纯逻辑（无 DOM 依赖，便于单测）：显示条件、位置吸附与夹取、点按位置取词、隐藏站点规则。
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
 * 底栏同步状态的中性文案：底栏在每次打开菜单时都会出现，不能把某个来源“未登录/授权失效”的原话常驻成像报错一样的提示。
 * - 有需要处理的项：只说“N 项同步待处理”（点按去选项页对应位置），从未配置过（never）的项用中性灰点，真正出错（error）才用红点
 * - 其他情况沿用 background 的总述（“已全部同步”“正在同步…”“未开启任何同步”）
 */
export function syncFootText(st: Pick<StatusSummary, 'level' | 'text' | 'items'>): { level: string; text: string } {
  const problems = st.items.filter((i) => i.level === 'error' || i.level === 'never');
  if (problems.length === 0) return { level: st.level, text: st.text };
  const synced = st.items.filter((i) => i.level === 'ok').length;
  const pending = problems.length === 1 ? `${problems[0]!.name}待设置` : `${problems.length} 项同步待设置`;
  return {
    level: problems.some((i) => i.level === 'error') ? 'warn' : 'off',
    text: synced > 0 ? `已同步 ${synced} 项 · ${pending}` : pending,
  };
}
