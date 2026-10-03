import { effectiveBookRole } from '@/core/known/sources';
import { MY_WORDS_BOOK_ID, type Settings } from '@/core/settings/schema';
import { getProviderInfo } from '@/core/source/providers';
import { toggleEnabledBooks } from '@/core/wordbook/enable';
import type { BookCategory, BookMeta } from '@/core/wordbook/types';

/** 词书分组标题与顺序（分组按 BookMeta.category；data 分片新增分类时在此补充标题即可，未知分类归入“其他”） */
export const CATEGORY_GROUPS: { category: BookCategory; title: string; hint: string }[] = [
  { category: 'level', title: '难度分级', hint: '按词汇难度分级（如 CEFR），选择适合自己的一档' },
  { category: 'exam', title: '考试词书', hint: '从中考到 GRE，可多选组合' },
  { category: 'frequency', title: '词频分级', hint: '按英语语料出现频率分段，越靠后越少见' },
  { category: 'other', title: '其他', hint: '' },
];

/** 词书类别徽标文案 */
export function bookKindLabel(b: BookMeta): string {
  if (b.kind === 'source') return getProviderInfo(b.providerId ?? '')?.name ?? '云端生词本';
  if (b.kind === 'local') return b.id === MY_WORDS_BOOK_ID ? '本地' : '导入';
  return b.short;
}

/**
 * 只显示书名的地方用的带归属名称：本地“我的生词本”与欧路默认分组“我的生词本”同名，必须带上归属才能区分。
 * 来源词书的 name 已是“欧路词典 · 分组名”；本地词书补“本地 · ”。
 */
export function bookDisplayName(b: Pick<BookMeta, 'kind' | 'name'>): string {
  return b.kind === 'local' ? `本地 · ${b.name}` : b.name;
}

/** 来源词书当前是否作为熟词本使用（provider 声明或用户指定）：熟词本不进高亮词书列表，在“熟词”页管理 */
export function isKnownRoleBook(settings: Settings, b: BookMeta): boolean {
  return b.kind === 'source' && !!b.sync && effectiveBookRole(b.sync, settings) === 'known';
}

export function isBookEnabled(settings: Settings, id: string): boolean {
  return settings.books.enabled.includes(id);
}

/**
 * 启用/停用词书：启用时追加到末尾（优先级最低），停用时移除。
 * 传入 books（词书元数据）时，难度分级、词频分级按组内单选处理（见 core/wordbook/enable.ts）
 */
export function toggleBook(settings: Settings, id: string, on = !isBookEnabled(settings, id), books: readonly BookMeta[] = []) {
  settings.books.enabled = toggleEnabledBooks(settings.books.enabled, id, on, books);
}

/** 调整启用顺序（优先级），delta=-1 上移 */
export function moveBook(settings: Settings, id: string, delta: number) {
  const list = [...settings.books.enabled];
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  settings.books.enabled = list;
}

/** 数字千分位（词数展示） */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前 / 日期 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return '从未';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

/** 中文界面的日期时间：2026/10/1 16:15（不随浏览器语言变成 en-US 的 10/1/2026, 4:15 PM） */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * 分类内的显示顺序：全量书按难度排序，增量书（delta，如“六级新增”）紧跟在它的全量书之后，
 * 避免“专四”这类同级书插在“考研”与“考研新增”之间。
 */
export function orderCategoryBooks<T extends Pick<BookMeta, 'id' | 'level' | 'delta'>>(list: T[]): T[] {
  const full = list.filter((b) => !b.delta).sort((a, b) => a.level - b.level);
  const deltas = list.filter((b) => b.delta);
  const out: T[] = [];
  for (const b of full) out.push(b, ...deltas.filter((d) => d.delta!.of === b.id));
  // 找不到全量书的增量书放最后（数据不完整时不丢书）
  for (const d of deltas) if (!out.includes(d)) out.push(d);
  return out;
}

/**
 * “全选”要勾选的书：只选全量书，不选增量书——增量书完全包含在对应全量书中，一起选只会重复计数。
 * 词频分级、难度分级是包含关系（3000 之外包含 5000 之外…），不提供全选。
 */
export function selectAllIds(list: Pick<BookMeta, 'id' | 'delta'>[]): string[] {
  return list.filter((b) => !b.delta).map((b) => b.id);
}

/** 增量书的全量书已启用：增量书已被包含，列表中置灰说明 */
export function deltaCoveredBy(settings: Settings, b: Pick<BookMeta, 'delta'>, byId: Map<string, Pick<BookMeta, 'short'>>): string | undefined {
  if (!b.delta || !isBookEnabled(settings, b.delta.of)) return undefined;
  return byId.get(b.delta.of)?.short ?? b.delta.of;
}

/** 徽标文字：一般最多 3 个字符（“六级”“有道”）；带“+”的增量简称保留加号（“GRE+”“雅思+”），不与全量书重复 */
export function bookBadge(label: string): string {
  const s = label.replace(/词典$/, '');
  return s.endsWith('+') ? s.slice(0, 4) : s.slice(0, 3);
}

/**
 * 已启用词书的去重词数（并集）：逐本加载词表求并集（内置词书合计不到 1MB，用户词书来自本地缓存）。
 * 加载失败的书按其 size 估算（结果标为估算）。
 */
export async function unionWordCount(ids: string[], load: (id: string) => Promise<{ words(): Iterable<string> } | undefined>, sizeOf: (id: string) => number): Promise<{ count: number; exact: boolean }> {
  const all = new Set<string>();
  let extra = 0;
  let exact = true;
  const loaded = await Promise.all(ids.map((id) => load(id).catch(() => undefined)));
  loaded.forEach((book, i) => {
    if (!book) {
      extra += sizeOf(ids[i]!);
      exact = false;
      return;
    }
    for (const w of book.words()) all.add(w);
  });
  return { count: all.size + extra, exact };
}
