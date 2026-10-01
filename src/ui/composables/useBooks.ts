import { onScopeDispose, ref } from 'vue';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/core/storage/keys';
import { DefaultWordBookRegistry, createExtensionLoaders } from '@/core/wordbook/registry';
import type { BookMeta } from '@/core/wordbook/types';

/**
 * 可用词书列表（来源词书 + 本地导入词书 + 内置词书，见 WordBookRegistry#list）。
 * 用户词书索引（同步状态、词数、重命名）变化时自动刷新。
 */
export function useBooks() {
  const books = ref<BookMeta[]>([]);
  async function reload() {
    books.value = await new DefaultWordBookRegistry(createExtensionLoaders()).list();
  }
  const onChanged = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && (changes[STORAGE_KEYS.sourceBooks] || changes[STORAGE_KEYS.localBooks])) void reload();
  };
  browser.storage.onChanged.addListener(onChanged);
  onScopeDispose(() => browser.storage.onChanged.removeListener(onChanged));
  void reload();
  return { books, reload };
}
