import type { BookCategory, BookMeta } from '@/core/wordbook/types';
import type { KnownWordsData } from '@/core/known/types';
import type { SyncStatus } from '@/core/sync/types';
import type { BookId } from '@/core/settings/schema';

/**
 * popup 的纯逻辑（无 DOM / browser 依赖，便于单测）：页面状态判定、同步状态文案、词书分组与启用切换等。
 */

/** 状态色调：决定状态点/文字颜色 */
export type Tone = 'ok' | 'warn' | 'error' | 'muted' | 'busy';

export interface StatusText {
  text: string;
  tone: Tone;
}

/** 单词列表的一行 */
export interface WordRow {
  word: string;
  meaning: string;
  /** 命中词书的高亮色（CSS 颜色），用于行首色点；熟词本为空 */
  swatch?: string;
  /** 命中词书简称，如“六级” */
  badge?: string;
}

/**
 * 设置页路由（options 使用 `#页面/页内锚点` 的 hash 路由；锚点不存在时只切到对应页面）。
 * 集中在这里，设置页调整分组时只需改这一处。
 */
export const OPTIONS_ROUTES = {
  home: '',
  books: '#books/enabled',
  importBooks: '#books/mine',
  sources: '#sources',
  known: '#known',
  sync: '#more/sync',
} as const;

// ---------------- 时间 ----------------

/** 相对时间文案：刚刚 / x 分钟前 / x 小时前 / x 天前 / M月D日 */
export function formatAgo(ts: number, now = Date.now()): string {
  if (!ts) return '从未';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---------------- 页面状态 ----------------

/**
 * 当前标签页的高亮状态：
 * - unsupported：浏览器内置页/扩展页等，内容脚本不会注入
 * - not-injected：普通网页但内容脚本未应答（扩展安装/更新前打开的页面），刷新后生效
 * - paused：总开关关闭
 * - site-off：本站已禁用
 * - active：正常高亮
 */
export type PageStatus = 'loading' | 'unsupported' | 'not-injected' | 'paused' | 'site-off' | 'active';

export function isScriptableUrl(url: string | undefined): boolean {
  return !!url && /^(https?|file):/i.test(url);
}

export function resolvePageStatus(input: {
  loaded: boolean;
  url?: string;
  /** 内容脚本是否应答 getPageState */
  contentReady: boolean;
  enabled: boolean;
  siteDisabled: boolean;
}): PageStatus {
  if (!input.loaded) return 'loading';
  if (!isScriptableUrl(input.url)) return 'unsupported';
  if (!input.enabled) return 'paused';
  if (input.siteDisabled) return 'site-off';
  // 内容脚本未注入时开关仍可操作（写 storage），只是需要刷新页面才能看到效果
  if (!input.contentReady) return 'not-injected';
  return 'active';
}

/**
 * 打开本站高亮：移除所有命中该 hostname 的禁用规则（含父域规则，如禁用 example.com 时打开 www.example.com）。
 * 关闭：追加精确 hostname。与 isSiteDisabled 的匹配规则保持一致。
 */
export function toggleSiteRule(disabled: string[], hostname: string, enable: boolean): string[] {
  const host = hostname.toLowerCase();
  const matches = (rule: string) => {
    const r = rule.trim().toLowerCase();
    return !!r && (host === r || host.endsWith('.' + r));
  };
  const rest = disabled.filter((r) => !matches(r));
  return enable ? rest : [...rest, host];
}

// ---------------- 词书 ----------------

const CATEGORY_TITLES: Record<BookCategory, string> = {
  user: '我的生词本',
  exam: '考试分级',
  frequency: '词频分级',
  other: '其他',
};
const CATEGORY_ORDER: BookCategory[] = ['user', 'exam', 'frequency', 'other'];

export interface BookGroup {
  category: BookCategory;
  title: string;
  books: BookMeta[];
}

/** 按类别分组（用户词书 → 考试 → 词频 → 其他），组内保持 registry 顺序（内置词书按 level） */
export function groupBooks(books: BookMeta[]): BookGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_TITLES[category],
    books: books.filter((b) => (b.category ?? 'other') === category),
  })).filter((g) => g.books.length > 0);
}

/** 启用/停用词书：启用时追加到末尾（不改变已有优先级），停用时移除 */
export function toggleEnabledBook(enabled: BookId[], id: BookId, on: boolean): BookId[] {
  const rest = enabled.filter((b) => b !== id);
  return on ? [...rest, id] : rest;
}

/** 词数展示：1234 -> 1,234；>= 10000 -> 1.2万 */
export function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return n.toLocaleString('en-US');
}

/** 来源词书一行的状态文案 */
export function sourceBookStatus(book: BookMeta, now = Date.now()): StatusText | undefined {
  const s = book.sync;
  if (!s) return undefined;
  switch (s.status) {
    case 'syncing':
      return { text: '同步中…', tone: 'busy' };
    case 'error':
      return { text: s.error || '同步失败', tone: 'error' };
    case 'never':
      return { text: '尚未同步', tone: 'warn' };
    case 'empty':
      return { text: `生词本为空 · ${formatAgo(s.lastSyncAt, now)}`, tone: 'warn' };
    default:
      return { text: `${formatAgo(s.lastSyncAt, now)}同步`, tone: s.orphaned ? 'warn' : 'ok' };
  }
}

// ---------------- 同步状态 ----------------

/** 来源生词本汇总：同步中 > 有失败 > 最近一次成功时间 */
export function summarizeSourceSync(books: BookMeta[], now = Date.now()): StatusText {
  const sources = books.filter((b) => b.kind === 'source' && b.sync);
  if (sources.length === 0) return { text: '未连接有道 / 欧路生词本', tone: 'muted' };
  if (sources.some((b) => b.sync!.status === 'syncing')) return { text: '正在同步生词本…', tone: 'busy' };
  const failed = sources.filter((b) => b.sync!.status === 'error');
  const last = Math.max(...sources.map((b) => b.sync!.lastSyncAt));
  if (failed.length) return { text: `${failed.length} 本同步失败：${failed[0]!.sync!.error || '未知错误'}`, tone: 'error' };
  if (!last) return { text: `${sources.length} 本生词本尚未同步`, tone: 'warn' };
  return { text: `${sources.length} 本生词本 · ${formatAgo(last, now)}同步`, tone: 'ok' };
}

/** 跨设备（storage.sync）同步状态文案 */
export function summarizeCloudSync(enabled: boolean, status: SyncStatus | undefined, now = Date.now()): StatusText {
  if (!enabled) return { text: '跨设备同步未开启', tone: 'muted' };
  if (!status) return { text: '跨设备同步已开启', tone: 'muted' };
  const skipped = status.usage?.segments.filter((s) => s.state === 'skipped').length ?? 0;
  switch (status.phase) {
    case 'syncing':
      return { text: '正在跨设备同步…', tone: 'busy' };
    case 'pending':
      return { text: '等待同步本机更改', tone: 'busy' };
    case 'error':
      return { text: `跨设备同步出错：${status.error || '未知错误'}`, tone: 'error' };
    case 'disabled':
      return { text: '跨设备同步未开启', tone: 'muted' };
    default: {
      const last = Math.max(status.lastPushAt, status.lastPullAt);
      const quota = skipped ? `，${skipped} 项超出配额未同步` : '';
      return { text: `跨设备已同步 · ${formatAgo(last, now)}${quota}`, tone: skipped ? 'warn' : 'ok' };
    }
  }
}

// ---------------- 熟词 ----------------

/** 最近加入的熟词（按加入时间倒序） */
export function recentKnownWords(data: KnownWordsData, limit = 100): { word: string; at: number }[] {
  return Object.entries(data.words)
    .map(([word, at]) => ({ word, at }))
    .sort((a, b) => b.at - a.at || a.word.localeCompare(b.word))
    .slice(0, limit);
}

/** 列表里展示的一行简短释义：去掉换行，截断过长内容 */
export function oneLineMeaning(text: string | undefined, max = 40): string {
  if (!text) return '';
  const line = text.replace(/\s*\n\s*/g, '；').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 按关键词过滤单词（前缀优先，其次包含） */
export function filterWords(words: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return words;
  const prefix = words.filter((w) => w.startsWith(q));
  const contains = words.filter((w) => !w.startsWith(q) && w.includes(q));
  return [...prefix, ...contains];
}

// ---------------- 颜色 ----------------

/**
 * 词书在 popup 中的色点颜色：取高亮样式的主色（背景 > 下划线色 > 文字色），
 * 半透明背景把透明度提到 1，避免小色点在浅色背景上几乎看不见。
 */
export function solidSwatch(mark: { background: string; color: string; underlineColor: string }, fallback = 'var(--accent)'): string {
  const base = mark.background || mark.underlineColor || mark.color;
  if (!base) return fallback;
  const m = base.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : base;
}
