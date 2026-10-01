import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { browser, type Browser } from 'wxt/browser';
import { CompositeDictionary, PackagedDictionary } from '@/core/dict/packaged';
import type { DictEntry, Dictionary } from '@/core/dict/types';
import { getKnownData } from '@/core/known/store';
import type { KnownWordsData } from '@/core/known/types';
import { sendToBackground, sendToTab } from '@/core/messaging';
import type { BookId, Settings } from '@/core/settings/schema';
import { SESSION_KEYS, STORAGE_KEYS } from '@/core/storage/keys';
import type { SyncStatus } from '@/core/sync/types';
import { DefaultWordBookRegistry, createExtensionLoaders } from '@/core/wordbook/registry';
import type { WordBook } from '@/core/wordbook/types';
import { UserBooksDictionary } from '@/core/wordbook/user-book';

/**
 * popup 数据层：目标标签页、本页生词（实时）、熟词本、跨设备同步状态、释义查询与“单词 → 命中词书”。
 * 设置读写走 useSettings、词书列表走 useBooks，这里只负责 popup 特有的数据。
 */

/**
 * 解析 popup 要展示的目标标签页：
 * - `?tabId=`：QA 截图脚本把 popup 当普通标签页打开时指定目标页
 * - 正常情况：当前窗口的活动标签页
 * - 活动标签页是扩展自身页面时（如 Edge Android 把 popup 作为整页打开），取最近访问的非扩展页面
 */
async function resolveTargetTab(): Promise<Browser.tabs.Tab | undefined> {
  const qaTabId = Number(new URLSearchParams(location.search).get('tabId'));
  if (qaTabId) return browser.tabs.get(qaTabId).catch(() => undefined);
  const self = browser.runtime.getURL('/');
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active && !active.url?.startsWith(self)) return active;
  const all = await browser.tabs.query({});
  return all
    .filter((t) => !t.url?.startsWith(self))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

export function usePopupData(settings: Ref<Settings | null>) {
  const loaded = ref(false);
  const tabId = ref<number>();
  const url = ref<string>();
  const hostname = ref('');
  /** 目标页 favicon（仅 http/https/data 地址，避免 chrome:// 图标加载报错） */
  const favIconUrl = ref('');
  /** 内容脚本是否应答（未注入时需刷新页面） */
  const contentReady = ref(false);
  /** 本页已高亮的不同词条（合并所有 frame，来自 background 徽章数据） */
  const pageLemmas = ref<string[]>([]);
  /** popup 中刚标为熟词、等待页面复核上报的词：先从列表隐藏，撤销时恢复 */
  const hiddenLemmas = ref(new Set<string>());
  const known = ref<KnownWordsData>({ words: {}, removed: {} });
  const syncStatus = ref<SyncStatus>();
  /** 已查询到的释义（lemma -> 词条），按需增量补充 */
  const entries = shallowRef(new Map<string, DictEntry>());
  /** 启用的词书实例（按优先级），用于判断单词命中了哪些词书 */
  const enabledBooks = shallowRef<WordBook[]>([]);
  /** 词典来源版本：启用词书变化后递增，界面据此重新查询已展示词的释义 */
  const dictVersion = ref(0);

  const packaged = new PackagedDictionary();
  let dictionary: Dictionary = packaged;
  /** 已发起查询的词，避免重复请求 */
  const requested = new Set<string>();

  const visibleLemmas = computed(() => pageLemmas.value.filter((w) => !hiddenLemmas.value.has(w)));

  async function refreshPageWords(): Promise<void> {
    if (tabId.value === undefined) return;
    const res = await sendToBackground('getTabWords', { tabId: tabId.value }).catch(() => ({ lemmas: [] as string[] }));
    pageLemmas.value = res.lemmas;
    // 页面已复核（熟词不再上报）后，隐藏集合中不再出现的词可以清掉
    const still = new Set(res.lemmas);
    hiddenLemmas.value = new Set([...hiddenLemmas.value].filter((w) => still.has(w)));
  }

  /** 查询释义：只查尚未请求过的词 */
  async function lookup(words: Iterable<string>): Promise<void> {
    const todo = [...words].filter((w) => !requested.has(w));
    if (!todo.length) return;
    todo.forEach((w) => requested.add(w));
    const version = dictVersion.value;
    const found = await dictionary.lookupMany(todo);
    // 查询期间词典已切换：丢弃旧结果（新版本会重新查询）
    if (version !== dictVersion.value) return;
    if (found.size) entries.value = new Map([...entries.value, ...found]);
  }

  /** 加载启用的词书：用于“命中词书”标签，以及用户词书自带释义（优先于打包词典） */
  async function loadEnabledBooks(ids: BookId[]): Promise<void> {
    const registry = new DefaultWordBookRegistry(createExtensionLoaders());
    const books = (await Promise.all(ids.map((id) => registry.load(id).catch(() => undefined)))).filter(
      (b): b is WordBook => !!b,
    );
    enabledBooks.value = books;
    dictionary = new CompositeDictionary([new UserBooksDictionary(books.filter((b) => b.meta.kind !== 'builtin')), packaged]);
    // 词典来源变化后重新查询已展示的词
    requested.clear();
    entries.value = new Map();
    dictVersion.value++;
  }

  /** 单词命中的启用词书 id（按优先级）。熟词本中的词也可用来展示“曾属于哪本书” */
  function booksOf(lemma: string): BookId[] {
    return enabledBooks.value.filter((b) => b.has(lemma)).map((b) => b.meta.id);
  }

  async function init(): Promise<void> {
    const tab = await resolveTargetTab();
    tabId.value = tab?.id;
    url.value = tab?.url;
    favIconUrl.value = /^(https?:|data:)/.test(tab?.favIconUrl ?? '') ? tab!.favIconUrl! : '';
    try {
      hostname.value = tab?.url ? new URL(tab.url).hostname : '';
    } catch {
      hostname.value = '';
    }
    const [, state, knownData, status] = await Promise.all([
      refreshPageWords(),
      // 内容脚本可能未注入（浏览器内置页、扩展安装前打开的页面），失败视为未就绪
      tab?.id !== undefined ? sendToTab(tab.id, 'getPageState', {}).catch(() => null) : null,
      getKnownData(),
      sendToBackground('getSyncStatus', {}).catch(() => undefined),
    ]);
    contentReady.value = !!state;
    known.value = knownData;
    syncStatus.value = status;
    loaded.value = true;
  }

  // 启用词书变化（含 popup 内切换）时重新加载
  watch(
    () => settings.value?.books.enabled.join('\n'),
    (key) => {
      if (key !== undefined && settings.value) void loadEnabledBooks([...settings.value.books.enabled]);
    },
    { immediate: true },
  );

  // 存储变化：本页生词（session）、熟词本、同步状态
  const onChanged = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
    if (area === 'session' && changes[SESSION_KEYS.tabWords]) void refreshPageWords();
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.knownWords]) void getKnownData().then((d) => (known.value = d));
    const sync = changes[STORAGE_KEYS.syncState];
    if (sync?.newValue) syncStatus.value = sync.newValue as SyncStatus;
  };
  browser.storage.onChanged.addListener(onChanged);
  onScopeDispose(() => browser.storage.onChanged.removeListener(onChanged));

  void init();

  return {
    loaded,
    tabId,
    url,
    hostname,
    favIconUrl,
    contentReady,
    pageLemmas: visibleLemmas,
    hiddenLemmas,
    known,
    syncStatus,
    entries,
    enabledBooks,
    dictVersion,
    lookup,
    booksOf,
    refreshPageWords,
  };
}
