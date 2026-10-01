import { computed, onScopeDispose, ref } from 'vue';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '@/core/storage/keys';
import { getSourceIndex } from '@/core/wordbook/user-store';
import type { SourceBookIndex, SourceBookState } from '@/core/wordbook/types';

/**
 * 来源词书索引（storage `sourceBooks`）的响应式只读视图：各书同步状态、角色、能否加/删词，以及来源级列表刷新错误。
 * useBooks 只给出 BookMeta（不含熟词角色的书的完整状态），熟词来源、单词操作目标等需要完整 SourceBookState 时用这里。
 */
export function useSourceIndex() {
  const index = ref<SourceBookIndex>({ books: {}, providers: {} });
  const load = async () => (index.value = await getSourceIndex());
  const onStorage = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && changes[STORAGE_KEYS.sourceBooks]) void load();
  };
  browser.storage.onChanged.addListener(onStorage);
  onScopeDispose(() => browser.storage.onChanged.removeListener(onStorage));
  void load();
  /** 全部来源词书状态（按来源、名称排序，便于分组展示） */
  const states = computed<SourceBookState[]>(() =>
    Object.values(index.value.books).sort((a, b) => a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name)),
  );
  return { index, states };
}
