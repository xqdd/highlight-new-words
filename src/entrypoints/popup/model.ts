import type { BookCategory, BookMeta } from '@/core/wordbook/types';
import type { KnownWordsData } from '@/core/known/types';
import type { StatusItem, StatusLevel } from '@/core/messaging/protocol';
import { SOURCE_NOT_CONNECTED_TEXT } from '@/core/source/connect-status';
import type { BackendSyncStatus, SyncStatus } from '@/core/sync/types';
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
  sync: '#sync/sync',
  webdav: '#sync/webdav',
  appearance: '#appearance/presets',
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
 * - no-access：用户收回了“访问网站”权限（Chrome/Edge 改成“点击时/特定网站”、Firefox 未授予），内容脚本不会注入，需先授权
 * - not-injected：普通网页但内容脚本未应答（扩展安装/更新前打开的页面），刷新后生效
 * - paused：总开关关闭
 * - site-off：本站已禁用
 * - active：正常高亮
 */
export type PageStatus = 'loading' | 'unsupported' | 'no-access' | 'not-injected' | 'paused' | 'site-off' | 'active';

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
  /** 是否有访问所有网站的权限（缺省视为有）；没有但本页内容脚本已应答（单独授权了本站）时仍按正常处理 */
  hostAccess?: boolean;
}): PageStatus {
  if (!input.loaded) return 'loading';
  if (!isScriptableUrl(input.url)) return 'unsupported';
  if (!input.enabled) return 'paused';
  if (input.siteDisabled) return 'site-off';
  if (!input.contentReady && input.hostAccess === false) return 'no-access';
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
  level: '难度分级',
  exam: '考试分级',
  frequency: '词频分级',
  other: '其他',
};
const CATEGORY_ORDER: BookCategory[] = ['user', 'level', 'exam', 'frequency', 'other'];

export interface BookGroup {
  category: BookCategory;
  title: string;
  books: BookMeta[];
}

/** 按类别分组（用户词书 → 难度分级 → 考试 → 词频 → 其他），组内保持 registry 顺序（内置词书按 level） */
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

// ---------------- 总同步状态 ----------------

/**
 * 一种同步方式（某个生词本来源 / 浏览器账号同步 / WebDAV）在 popup 中的一行。
 * - `action=sync`：可直接“立即同步”
 * - `action=fix`：出错或未完成配置，按钮跳转到设置页对应位置处理
 */
export interface SyncChannel {
  /** 来源为 `source:<providerId>`，其余为后端 id */
  id: string;
  kind: 'source' | 'storage-sync' | 'webdav';
  label: string;
  status: StatusText;
  action: 'sync' | 'fix';
  /** 正在同步（后台任务进行中，按钮禁用并转圈）；退避等待中（pending）不算，用户仍可手动同步 */
  running?: boolean;
  /** 处理入口（options hash 路由） */
  route: string;
  providerId?: string;
  /** 原始错误文案：status.text 被改写成短句（见 friendlyChannels）时保留，供“详情”展开与修复动作判断 */
  detail?: string;
  /** 上次成功同步时间 ms（0=从未成功；undefined=未知）：区分“未登录”（从没成功过）与“登录已过期” */
  lastSyncAt?: number;
  /** 出错 / 待处理行的补充说明（如“上次成功 3 小时前”），列表中以次要文字显示在状态后 */
  since?: string;
}

/** 状态严重程度：总状态取最严重的一项（出错 > 待处理 > 同步中 > 正常 > 未开启） */
const TONE_RANK: Record<Tone, number> = { error: 4, warn: 3, busy: 2, ok: 1, muted: 0 };

/**
 * 按来源汇总生词本同步状态（每个启用的来源一行）：同步中 > 失败（列出失败本数与首个错误）> 尚未同步 > 最近成功时间。
 * 来源已启用但还没有任何生词本时，提示去设置页连接（可能未登录或未填 token）。
 */
export function summarizeSourceChannels(
  books: BookMeta[],
  sources: Record<string, { enabled: boolean }>,
  providers: readonly { id: string; name: string }[],
  now = Date.now(),
): SyncChannel[] {
  const out: SyncChannel[] = [];
  for (const p of providers) {
    const own = books.filter((b) => b.kind === 'source' && b.providerId === p.id && b.sync);
    // 未启用且没有缓存书的来源不展示（未使用）；关闭了但有旧缓存的同样不展示，避免误导为“正在同步”
    if (!sources[p.id]?.enabled) continue;
    const base = { id: `source:${p.id}`, kind: 'source' as const, label: p.name, providerId: p.id, route: `${OPTIONS_ROUTES.sources}/provider-${p.id}` };
    if (!own.length) {
      out.push({ ...base, status: { text: SOURCE_NOT_CONNECTED_TEXT, tone: 'muted' }, action: 'fix' });
      continue;
    }
    if (own.some((b) => b.sync!.status === 'syncing')) {
      out.push({ ...base, status: { text: '同步中…', tone: 'busy' }, action: 'sync', running: true });
      continue;
    }
    const failed = own.filter((b) => b.sync!.status === 'error');
    if (failed.length) {
      const prefix = own.length > 1 ? `${failed.length}/${own.length} 本失败：` : '同步失败：';
      const lastOk = Math.max(...own.map((b) => b.sync!.lastSyncAt));
      // 从没成功过：未连接（中性），与后台 sourceItem 口径一致
      if (!lastOk) {
        out.push({ ...base, status: { text: SOURCE_NOT_CONNECTED_TEXT, tone: 'muted' }, action: 'fix', detail: failed[0]!.sync!.error, lastSyncAt: 0 });
        continue;
      }
      out.push({
        ...base,
        status: { text: prefix + (failed[0]!.sync!.error || '未知错误'), tone: 'error' },
        action: 'fix',
        lastSyncAt: lastOk,
        since: lastOk ? `上次成功 ${formatAgo(lastOk, now)}` : undefined,
      });
      continue;
    }
    const last = Math.max(...own.map((b) => b.sync!.lastSyncAt));
    if (!last) {
      out.push({ ...base, status: { text: `${own.length} 本尚未同步`, tone: 'warn' }, action: 'sync' });
      continue;
    }
    const words = own.reduce((n, b) => n + (b.sync!.wordCount ?? 0), 0);
    out.push({
      ...base,
      status: { text: `${own.length} 本 · ${formatCount(words)} 词 · ${formatAgo(last, now)}`, tone: 'ok' },
      action: 'sync',
    });
  }
  return out;
}

/** WebDAV 同步状态文案（未开启返回 undefined，不占行） */
export function summarizeWebdav(status: BackendSyncStatus | undefined, now = Date.now()): StatusText | undefined {
  if (!status?.enabled || status.phase === 'disabled') return undefined;
  switch (status.phase) {
    case 'syncing':
      return { text: '同步中…', tone: 'busy' };
    case 'pending':
      return { text: status.notice || '等待自动重试', tone: 'busy' };
    case 'error':
      return { text: status.error || '同步出错', tone: 'error' };
    default:
      return status.lastSyncAt
        ? { text: `${formatAgo(status.lastSyncAt, now)}同步`, tone: 'ok' }
        : { text: '尚未同步', tone: 'warn' };
  }
}

/** 浏览器账号（chrome.storage.sync）一行的简短文案（行标题已说明是哪种方式，这里不再重复“跨设备”） */
export function summarizeStorageSync(status: SyncStatus | undefined, now = Date.now()): StatusText | undefined {
  if (!status?.enabled || status.phase === 'disabled') return undefined;
  const skipped = status.usage?.segments.filter((s) => s.state === 'skipped').length ?? 0;
  switch (status.phase) {
    case 'syncing':
      return { text: '同步中…', tone: 'busy' };
    case 'pending':
      return { text: status.notice || '等待同步本机更改', tone: 'busy' };
    case 'error':
      return { text: status.error || '同步出错', tone: 'error' };
    default: {
      const last = Math.max(status.lastPushAt, status.lastPullAt);
      if (!last) return { text: '尚未同步', tone: 'warn' };
      return skipped
        ? { text: `${formatAgo(last, now)}同步 · ${skipped} 项超出配额`, tone: 'warn' }
        : { text: `${formatAgo(last, now)}同步`, tone: 'ok' };
    }
  }
}

/**
 * 组装总同步状态：各来源 + 浏览器账号同步 + WebDAV（未开启的后端不占行）。
 * 出错 / 超配额的行 action=fix，引导去设置页处理。
 */
export function buildSyncChannels(input: {
  books: BookMeta[];
  sources: Record<string, { enabled: boolean }>;
  providers: readonly { id: string; name: string }[];
  storageSync?: SyncStatus;
  webdav?: BackendSyncStatus;
  now?: number;
}): SyncChannel[] {
  const now = input.now ?? Date.now();
  const rows = summarizeSourceChannels(input.books, input.sources, input.providers, now);
  const ss = summarizeStorageSync(input.storageSync, now);
  if (ss) {
    rows.push({
      id: 'storage-sync',
      kind: 'storage-sync',
      label: '浏览器账号',
      status: ss,
      action: ss.tone === 'error' || ss.tone === 'warn' ? 'fix' : 'sync',
      running: input.storageSync?.phase === 'syncing',
      route: OPTIONS_ROUTES.sync,
    });
  }
  const dav = summarizeWebdav(input.webdav, now);
  if (dav) {
    rows.push({
      id: 'webdav',
      kind: 'webdav',
      label: 'WebDAV',
      status: dav,
      action: dav.tone === 'error' ? 'fix' : 'sync',
      running: input.webdav?.phase === 'syncing',
      route: OPTIONS_ROUTES.webdav,
    });
  }
  return rows;
}

/**
 * background 总状态级别 → popup 色调（pending 退避中会自动重试，按“进行中”显示）。
 * never（从未同步成功：未连接 / 尚未同步）是中性状态，用灰色，不当作警告（口径见 core/source/connect-status）。
 */
const LEVEL_TONE: Record<StatusLevel, Tone> = { error: 'error', busy: 'busy', pending: 'busy', never: 'muted', ok: 'ok', off: 'muted' };

/**
 * background `getStatusSummary` 的条目 → popup 行（background 统一计算文案，与选项页一致；本文件的
 * buildSyncChannels 只在后台不支持该消息时兜底）。关闭（off）的条目不占行；出错的条目给“处理”入口。
 */
export function channelsFromStatusItems(items: StatusItem[], now = Date.now()): SyncChannel[] {
  return items
    .filter((it) => it.level !== 'off')
    .map((it) => {
      const kind: SyncChannel['kind'] = it.kind === 'source' ? 'source' : it.id === 'webdav' ? 'webdav' : 'storage-sync';
      const providerId = kind === 'source' ? it.id.replace(/^source:/, '') : undefined;
      // 从未成功过的来源（后台给 level=never + “未连接”，原因在 detail）需要用户先去连接 / 登录；
      // 只是“尚未同步”（已列出生词本但没同步过）的先试一次同步
      const neverFailed = it.level === 'never' && !/^尚未同步/.test(it.text);
      // 正常行带上次同步时间（后台文案不含时间）；出错 / 待处理行把上次成功时间放进 since
      const text = it.level === 'ok' && it.lastSyncAt ? `${it.text} · ${formatAgo(it.lastSyncAt, now)}` : it.text;
      const showSince = (it.level === 'error' || it.level === 'pending' || it.level === 'never') && it.lastSyncAt > 0;
      return {
        id: it.id,
        kind,
        label: it.name,
        status: { text, tone: LEVEL_TONE[it.level] },
        action: it.level === 'error' || neverFailed ? 'fix' : 'sync',
        lastSyncAt: it.lastSyncAt,
        since: showSince ? `上次成功 ${formatAgo(it.lastSyncAt, now)}` : undefined,
        ...(it.detail ? { detail: it.detail } : {}),
        running: it.level === 'busy',
        // 同步后端直接定位到同步页对应小节（比 href 更精确）；来源用后台给的位置
        route: kind === 'webdav' ? OPTIONS_ROUTES.webdav : kind === 'storage-sync' ? OPTIONS_ROUTES.sync : it.href || OPTIONS_ROUTES.sources,
        providerId,
      };
    });
}

/** 总状态一句话：没有任何同步方式 / 全部正常（取最近时间）/ 最严重的一项 */
export function overallSyncStatus(channels: SyncChannel[]): StatusText {
  if (!channels.length) return { text: '未开启任何同步', tone: 'muted' };
  const worst = channels.reduce((a, b) => (TONE_RANK[b.status.tone] > TONE_RANK[a.status.tone] ? b : a));
  const problems = channels.filter((c) => c.status.tone === 'error').length;
  switch (worst.status.tone) {
    case 'error':
      return { text: problems > 1 ? `${problems} 项同步出错` : `${worst.label}同步出错`, tone: 'error' };
    case 'warn':
      // 直接说是什么事（“有道词典：未登录”），比“需要处理”更好懂
      return { text: `${worst.label}：${worst.status.text}`, tone: 'warn' };
    case 'busy':
      // 只有排队 / 退避等待（pending）的项时不说“正在同步”、也不用强调色，避免看起来一直卡在同步中
      return channels.some((c) => c.running) ? { text: '正在同步…', tone: 'busy' } : { text: '等待自动同步', tone: 'muted' };
    default: {
      // 未连接的来源（新装默认启用有道但没登录）：中性灰色说明，不算告警
      const idle = channels.find((c) => c.status.text === SOURCE_NOT_CONNECTED_TEXT);
      if (idle) return { text: `${idle.label}：${SOURCE_NOT_CONNECTED_TEXT}`, tone: 'muted' };
      return { text: channels.length > 1 ? `${channels.length} 项同步正常` : '同步正常', tone: 'ok' };
    }
  }
}

// ---------------- 行内译文 ----------------

/** popup 本地记住上次使用的行内译文模式（快速开关重新打开时恢复），只是本机界面偏好，不进 settings */
export const LAST_INLINE_MODE_KEY = 'hnw:popup:lastInlineMode';

/** 行内译文快速开关：关闭 → 恢复上次的显示方式（无记录或记录无效时用第一个，即“词后”）；modes 需包含全部开启方式（含 hover） */
export function nextInlineMode<M extends string>(current: M | 'off', last: string | null, modes: readonly M[]): M | 'off' {
  if (current !== 'off') return 'off';
  return (modes as readonly string[]).includes(last ?? '') ? (last as M) : modes[0]!;
}

// ---------------- 顶部状态位 ----------------

/**
 * 出错行“处理”按钮的具体动词：按错误文案判断用户要做的事（重新登录 / 更新授权 / 检查服务器…），
 * 让用户在 popup 里一眼知道怎么修；识别不出时用“去处理”。
 */
export function syncFixVerb(c: Pick<SyncChannel, 'kind' | 'status' | 'detail'>): string {
  const t = c.detail ?? c.status.text;
  // 未连接（从没同步成功过）：去选项页连接（登录网页版或填写 token），与选项页来源卡片的主按钮一致
  if (c.status.text === SOURCE_NOT_CONNECTED_TEXT) return '去连接';
  // 从没登录过（短句已判定为“未登录”）是“去登录”，不是“重新登录”
  if (/^未登录/.test(c.status.text)) return '去登录';
  if (/登录|cookie|会话|过期/i.test(t)) return '重新登录';
  if (/token|授权|密钥|凭据|401|403/i.test(t)) return c.kind === 'webdav' ? '检查账号' : '更新授权';
  if (c.kind === 'webdav' && /连接|服务器|网络|超时|fetch|ECONN|404|5\d\d/i.test(t)) return '检查服务器';
  if (/配额|空间|quota/i.test(t)) return '清理空间';
  if (/尚未连接|未连接/.test(t)) return '去连接';
  return '去处理';
}

/** 顶部状态位（告警条）：一行文字 + 可选处理按钮；正常时不显示 */
export interface StatusAlert {
  tone: 'error' | 'warn';
  text: string;
  /** 按钮：route=跳设置页对应位置；sheet=就地弹出同步面板（多项出错时，不长距离滚动） */
  action?: { label: string; route?: string; sheet?: boolean };
  /** 可“稍后提醒”：同步出错可暂时收起（长期故障不一直占位）；离线提示随网络恢复自动消失，不需要 */
  dismissible?: boolean;
}

/**
 * 顶部状态位取最需要用户处理的一项：离线 > 同步出错（一项时直接给具体修复动作，多项时“查看”滚到同步卡片）。
 * 网站未授权不在这里提示——本站卡片会直接切换成授权态，避免同一问题出现两处。
 */
export function resolveStatusAlert(input: { online: boolean; channels: SyncChannel[] }): StatusAlert | undefined {
  if (!input.online) return { tone: 'warn', text: '已离线：改动先存本地，联网后自动同步' };
  const errors = input.channels.filter((c) => c.status.tone === 'error');
  if (errors.length === 1) {
    const c = errors[0]!;
    return { tone: 'error', text: `${c.label}：${c.status.text}`, action: { label: syncFixVerb(c), route: c.route }, dismissible: true };
  }
  if (errors.length > 1) {
    // 三项及以上只给数量，手机上也能一行放下
    const who = errors.length > 2 ? `${errors.length} 项` : errors.map((c) => c.label).join('、');
    // 按钮写明数量：行首被截断（窄屏）时也能看懂要做什么
    return { tone: 'error', text: `${who}同步出错`, action: { label: `${errors.length} 项需处理`, sheet: true }, dismissible: true };
  }
  return undefined;
}

/** 告警条“稍后提醒”：同一条告警收起 24 小时；文案变化（出现新的错误）时立即重新显示 */
export const ALERT_SNOOZE_KEY = 'hnw:popup:alertSnooze';
export const ALERT_SNOOZE_MS = 24 * 3600e3;

export function isAlertSnoozed(alert: StatusAlert, snooze: { text: string; at: number } | null, now = Date.now()): boolean {
  return !!alert.dismissible && !!snooze && snooze.text === alert.text && now - snooze.at < ALERT_SNOOZE_MS;
}

/**
 * 同步错误改写成给用户看的短句（后台文案偏技术：带主机名括注、原始 fetch 异常、重复的修复说明）。
 * 修复说明由行内按钮（syncFixVerb：重新登录 / 更新授权…）承担，这里只说“出了什么事”；原文放进 detail 供展开查看。
 * 识别不出时原样返回（不丢信息）。
 */
export function friendlySyncError(text: string, opts: { neverSynced?: boolean } = {}): { short: string; detail?: string } {
  // 来源多本时的前缀“1/2 本失败：”保留在短句前
  const m = text.match(/^(\d+\/\d+ 本失败：|同步失败：)?([\s\S]*)$/);
  const prefix = m?.[1] === '同步失败：' ? '' : m?.[1] ?? '';
  const body = m?.[2] ?? text;
  const rules: [RegExp, (r: RegExpMatchArray) => string][] = [
    // 行内按钮已是“检查服务器”，短句只说连不上哪台服务器
    [/无法连接.*?服务器[（(]([^）)]+)[）)]/, (r) => `连不上服务器 ${r[1]}`],
    [/无法连接|Failed to fetch|NetworkError|ECONN|网络/i, () => '连不上服务器，请检查网络'],
    // 后台“未登录或登录已失效”是同一句：从没同步成功过 = 新用户未登录；成功过 = 登录过期
    [/未登录|登录已(失效|过期)|NO_LOGIN/i, () => (opts.neverSynced ? '未登录' : '登录已过期')],
    [/用户名或密码错误/, () => '用户名或密码错误'],
    [/(授权|token).*(无效|失效|过期)|(无效|失效|过期).*(授权|token)/i, () => '授权已失效'],
    [/拒绝访问|无权限/, () => '没有访问权限'],
    [/路径不存在/, () => '同步目录不存在'],
    [/请求频率|频繁|429/, () => '请求太频繁，稍后自动重试'],
    [/存储空间不足|quota|配额/i, () => '存储空间不足'],
    [/HTTP (\d{3})/, (r) => `服务器出错（HTTP ${r[1]}）`],
  ];
  for (const [re, fmt] of rules) {
    const r = body.match(re);
    if (r) {
      const short = prefix + fmt(r);
      return short === text ? { short } : { short, detail: text };
    }
  }
  return { short: text };
}

/** 出错 / 待处理行（warn，如未登录）的状态文案改成短句，原文存入 detail（修复动作仍按原文判断） */
export function friendlyChannels(channels: SyncChannel[]): SyncChannel[] {
  return channels.map((c) => {
    if (c.status.tone !== 'error' && c.status.tone !== 'warn') return c;
    const f = friendlySyncError(c.status.text, { neverSynced: c.lastSyncAt === 0 });
    return f.detail ? { ...c, status: { ...c.status, text: f.short }, detail: f.detail } : c;
  });
}

/**
 * 同步面板的主操作：有需要用户处理的行（出错优先，其次未登录等待处理）时，主按钮换成第一项的修复动作——
 * 这时“全部同步”大概率还会失败；没有时返回 undefined（主按钮为“全部同步”）。
 */
export function primaryFixChannel(channels: SyncChannel[]): SyncChannel | undefined {
  const fixes = channels.filter((c) => c.action === 'fix');
  return fixes.find((c) => c.status.tone === 'error') ?? fixes[0];
}

/**
 * 标为熟词后的提示：本地熟词本一定写入；远端删除失败（离线、登录失效）时明确说“未同步”，不显示成全部完成。
 */
export function markKnownToast(
  word: string,
  res: { deleted: { deleted: string[]; failed: { word: string; error: string }[] }[] },
  online: boolean,
): { text: string; failed: boolean } {
  const removed = res.deleted.reduce((n, r) => n + r.deleted.length, 0);
  const failed = res.deleted.flatMap((r) => r.failed);
  if (failed.length) {
    const reason = online ? failed[0]!.error : '当前离线';
    return { text: `${word} 已标为熟词，但未能从生词本删除（${reason}），稍后可在详情中重试`, failed: true };
  }
  return { text: `已将 ${word} 标为熟词${removed ? `，并从生词本删除 ${removed} 个词形` : ''}`, failed: false };
}

/**
 * 横向预设条的初始滚动位置：选中项在首屏内时从最左开始（不裁掉第一张）；
 * 否则让选中项完整可见，并在右侧露出约半张下一项，提示还能继续滑动。
 */
export function presetScrollLeft(input: {
  itemLeft: number;
  itemWidth: number;
  viewport: number;
  peek: number;
  max: number;
  /** 各项左缘对应的滚动位置（升序）：结果对齐到其中一项，保证最左边那张也完整显示、不被裁掉半张 */
  snaps?: number[];
}): number {
  const { itemLeft, itemWidth, viewport, peek, max, snaps } = input;
  if (itemLeft + itemWidth + peek <= viewport) return 0;
  const target = Math.max(0, Math.min(max, itemLeft + itemWidth + peek - viewport));
  const snapped = snaps?.find((x) => x >= target);
  return snapped === undefined ? target : Math.min(max, snapped);
}

/** popup 样式面板中的一个预设选项（mark 由调用方决定类型，这里只做分组排序） */
export interface PresetChip<M> {
  id: string;
  name: string;
  mark: M;
}

/** popup 样式面板的一组预设：带小标题，与选项页“样式预设 / 单色样式”的分组保持一致 */
export interface PresetSection<M> {
  key: 'combo' | 'single';
  title: string;
  items: PresetChip<M>[];
}

/**
 * 把预设拆成“组合预设”和“单色”两组（顺序与选项页、悬浮球一致：都来自 presetGroups，组合在前、单色在后）。
 * extra 是当前正在用但不在列表中的样式（自定义 / 旧版配色），放在组合预设最前，保证当前选中项总能看到。
 */
export function buildPresetSections<M>(
  combos: PresetChip<M>[],
  singles: PresetChip<M>[],
  extra?: PresetChip<M>,
): PresetSection<M>[] {
  return [
    { key: 'combo', title: '组合预设', items: extra ? [extra, ...combos] : combos },
    { key: 'single', title: `单色（${singles.length}）`, items: singles },
  ];
}
