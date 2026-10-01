import { browser } from 'wxt/browser';
import type { BookId, BookRole, Settings } from '../settings/schema';
import { sourceBookKey } from '../storage/keys';
import type { SourceBookData, SourceBookState } from '../wordbook/types';

/**
 * 熟词本多来源（追加需求 v3 第 6 条）：
 * - 本地熟词本（storage `knownWords`）始终生效；
 * - 来源熟词本 = 生效角色为 known 的来源词书（如欧路“已掌握”，或用户把某个远端分组指定为熟词本），
 *   在 settings.knownBooks.enabled 中启用后参与熟词判定；
 * - 所有生效熟词本取并集，熟词优先于生词（WordMatcher 中任一候选在熟词集合中即不高亮）。
 */

/** 来源词书的生效角色：用户覆盖（settings.knownBooks.roles）> provider 声明 > 默认 new */
export function effectiveBookRole(state: Pick<SourceBookState, 'id' | 'role'>, settings: Pick<Settings, 'knownBooks'>): BookRole {
  return settings.knownBooks.roles[state.id] ?? state.role ?? 'new';
}

/** 启用中的来源熟词本 id（只返回生效角色为 known 的书，角色被改回 new 的书即使仍在 enabled 中也忽略） */
export function enabledSourceKnownBookIds(settings: Pick<Settings, 'knownBooks'>, books: Record<BookId, SourceBookState>): BookId[] {
  return settings.knownBooks.enabled.filter((id) => {
    const b = books[id];
    return !!b && effectiveBookRole(b, settings) === 'known';
  });
}

/** 读取若干来源熟词本缓存中的全部单词（小写） */
export async function readSourceKnownWords(bookIds: BookId[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (bookIds.length === 0) return out;
  const keys = bookIds.map(sourceBookKey);
  const res = await browser.storage.local.get(keys);
  for (const k of keys) {
    const data = res[k] as SourceBookData | undefined;
    for (const w of Object.keys(data?.words ?? {})) out.add(w);
  }
  return out;
}
