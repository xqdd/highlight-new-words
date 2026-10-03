import type { BookId } from '../settings/schema';
import type { BookCategory } from './types';

/**
 * 组内单选的词书分类：都是包含体系，同时启用多档没有意义——
 * 难度分级（level）选 B2 = B2+C1+C2；词频分级（frequency）“3000 之外”已包含 5000、8000、12000 之外的词。
 */
export const SINGLE_CHOICE_CATEGORIES: ReadonlySet<BookCategory> = new Set<BookCategory>(['level', 'frequency']);

/**
 * 启用/停用一本词书后的启用列表（选项页、首次引导、popup、悬浮球快捷设置共用）：
 * 启用时追加到末尾（优先级最低），停用时移除；启用的是单选分类中的一档时，同时停用同分类的其他档。
 * @param books 词书元数据，用来判断分类；查不到的词书按普通词书处理
 */
export function toggleEnabledBooks(
  enabled: readonly BookId[],
  id: BookId,
  on: boolean,
  books: readonly { id: BookId; category: BookCategory }[],
): BookId[] {
  const rest = enabled.filter((b) => b !== id);
  if (!on) return rest;
  const category = books.find((b) => b.id === id)?.category;
  if (!category || !SINGLE_CHOICE_CATEGORIES.has(category)) return [...rest, id];
  const sameGroup = new Set(books.filter((b) => b.category === category).map((b) => b.id));
  return [...rest.filter((b) => !sameGroup.has(b)), id];
}
