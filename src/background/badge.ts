import { browser } from 'wxt/browser';
import { SESSION_KEYS } from '@/core/storage/keys';

/**
 * 徽章计数：每个标签页已高亮的“不同词条”数量（合并所有 frame）。
 * 数据存在 storage.session（MV3 service worker 被回收后仍可恢复，浏览器关闭即清空）。
 * 结构：{ [tabId]: { url: 当前页面 URL（不含 #hash）, frames: { [frameId]: lemmas[] } } }
 *
 * 清零时机（与旧版 v2 一致：URL 变化即清零）：
 * - 整页导航：tabs.onUpdated status=loading 带 url
 * - SPA 路由切换（history.pushState/replaceState）：tabs.onUpdated 只带 url 变化。
 *   只看去掉 #hash 后的 URL，锚点跳转不清零。内容脚本在路由切换后按页面实际高亮重新全量上报（engine 负责）。
 */
export interface TabEntry {
  url?: string;
  frames: Record<string, string[]>;
}
type TabWords = Record<string, TabEntry>;

/** 徽章最多显示 4 个字符 */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 999 ? '999+' : String(count);
}

/** 用于比较的 URL：去掉 hash，锚点跳转不算换页 */
export function pageKey(url: string): string {
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) : url;
}

async function load(): Promise<TabWords> {
  const res = await browser.storage.session.get(SESSION_KEYS.tabWords);
  const raw = (res[SESSION_KEYS.tabWords] as Record<string, TabEntry | Record<string, string[]>> | undefined) ?? {};
  // 兼容早期结构 { [tabId]: { [frameId]: lemmas[] } }
  const out: TabWords = {};
  for (const [tab, v] of Object.entries(raw)) out[tab] = 'frames' in v && typeof v.frames === 'object' && !Array.isArray(v.frames) ? (v as TabEntry) : { frames: v as Record<string, string[]> };
  return out;
}

async function save(data: TabWords): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEYS.tabWords]: data });
}

/** 串行化读改写，避免多个 frame 同时上报时互相覆盖 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function union(entry: TabEntry | undefined): string[] {
  const set = new Set<string>();
  for (const list of Object.values(entry?.frames ?? {})) list.forEach((w) => set.add(w));
  return [...set];
}

async function render(tabId: number, count: number): Promise<void> {
  try {
    await browser.action.setBadgeText({ tabId, text: badgeText(count) });
  } catch {
    // 标签页已关闭
  }
}

/**
 * 内容脚本上报本 frame 已高亮的不同词条（全量）。
 * frameUrl 为上报 frame 所在页面 URL（顶层 frame 时用于记录当前页面，避免旧页面迟到的上报污染新页面）。
 */
export function reportFrameWords(tabId: number, frameId: number, lemmas: string[], frameUrl?: string): Promise<void> {
  return serial(async () => {
    const data = await load();
    const entry = (data[tabId] ??= { frames: {} });
    if (frameId === 0 && frameUrl) {
      const key = pageKey(frameUrl);
      // 顶层页面已换（URL 不同）：丢弃其他 frame 的旧数据
      if (entry.url && entry.url !== key) entry.frames = {};
      entry.url = key;
    }
    entry.frames[frameId] = [...new Set(lemmas)];
    await save(data);
    await render(tabId, union(entry).length);
  });
}

export function getTabWords(tabId: number): Promise<string[]> {
  return serial(async () => union((await load())[tabId]));
}

export function clearTab(tabId: number, opts: { keepBadge?: boolean; url?: string } = {}): Promise<void> {
  return serial(async () => {
    const data = await load();
    if (opts.url !== undefined) data[tabId] = { url: pageKey(opts.url), frames: {} };
    else if (data[tabId]) delete data[tabId];
    else return;
    await save(data);
    if (!opts.keepBadge) await render(tabId, 0);
  });
}

/** URL 变化处理（纯逻辑）：返回是否需要清零。只有去掉 hash 后不同才算换页 */
export function shouldClearOnUrlChange(prevUrl: string | undefined, nextUrl: string): boolean {
  return !prevUrl || pageKey(prevUrl) !== pageKey(nextUrl);
}

function onUrlChanged(tabId: number, url: string): Promise<void> {
  return serial(async () => {
    const data = await load();
    if (!shouldClearOnUrlChange(data[tabId]?.url, url)) return;
    data[tabId] = { url: pageKey(url), frames: {} };
    await save(data);
    await render(tabId, 0);
  });
}

/** 导航（整页加载或 SPA 路由切换）时清空该标签页计数；关闭时删除记录；预渲染替换标签页时迁移记录 */
export function setupBadge(): void {
  void browser.action.setBadgeBackgroundColor({ color: '#d97706' }).catch(() => {});
  // 白色文字（Chrome 110+ 支持；旧版本无此 API）
  void browser.action.setBadgeTextColor?.({ color: '#ffffff' })?.catch(() => {});
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) void onUrlChanged(tabId, info.url);
  });
  browser.tabs.onRemoved.addListener((tabId) => void clearTab(tabId, { keepBadge: true }));
  browser.tabs.onReplaced.addListener((added, removed) => {
    void serial(async () => {
      const data = await load();
      if (!data[removed]) return;
      data[added] = data[removed]!;
      delete data[removed];
      await save(data);
      await render(added, union(data[added]).length);
    });
  });
}
