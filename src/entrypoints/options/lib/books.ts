import type { Settings } from '@/core/settings/schema';
import { getProviderInfo } from '@/core/source/providers';
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
  if (b.kind === 'local') return '导入';
  return b.short;
}

export function isBookEnabled(settings: Settings, id: string): boolean {
  return settings.books.enabled.includes(id);
}

/** 启用/停用词书：启用时追加到末尾（优先级最低），停用时移除 */
export function toggleBook(settings: Settings, id: string, on = !isBookEnabled(settings, id)) {
  const list = settings.books.enabled.filter((x) => x !== id);
  settings.books.enabled = on ? [...list, id] : list;
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
