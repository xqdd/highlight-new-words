<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import { requestAllSitesAccess, speakText } from '@/core/platform';
import type { BookId, InlineTranslationMode } from '@/core/settings/schema';
import { isSiteDisabled } from '@/core/settings/store';
import { SOURCE_PROVIDER_INFOS, getProviderInfo } from '@/core/source/providers';
import { resolveMarkStyle } from '@/core/theme/resolve';
import { CUSTOM_THEME_ID } from '@/core/theme/themes';
import type { BookMeta } from '@/core/wordbook/types';
import MarkPreview from '@/ui/components/MarkPreview.vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useBooks } from '@/ui/composables/useBooks';
import { useSettings } from '@/ui/composables/useSettings';
import BookPicker from './components/BookPicker.vue';
import BottomSheet from './components/BottomSheet.vue';
import PopupIcon from './components/PopupIcon.vue';
import WordDetail from './components/WordDetail.vue';
import WordList from './components/WordList.vue';
import {
  LAST_INLINE_MODE_KEY,
  isScriptableUrl,
  OPTIONS_ROUTES,
  buildSyncChannels,
  channelsFromStatusItems,
  filterWords,
  formatAgo,
  formatCount,
  markKnownToast,
  nextInlineMode,
  oneLineMeaning,
  overallSyncStatus,
  presetScrollLeft,
  recentKnownWords,
  resolveStatusAlert,
  resolvePageStatus,
  solidSwatch,
  syncFixVerb,
  toggleEnabledBook,
  toggleSiteRule,
  type StatusText,
  type SyncChannel,
  type WordRow,
} from './model';
import { usePopupData } from './usePopupData';
// 预设切换与选项页共用同一实现（切换时按新样式重新着色“按词书分色”），避免两处行为不一致
import { applyPreset, presetGroups } from '../options/lib/appearance';

/**
 * 弹出页：总开关 / 本站开关、网站权限检测与授权、启用词书摘要与快速切换、样式预设快速切换、行内释义快速开关、
 * 本页生词与熟词本列表（详情 / 标为熟词 / 撤销）、总同步状态（各来源与同步方式的最近结果，出错时给处理入口）、进入设置。
 *
 * 布局：桌面 popup 固定 380px 宽；触屏（Edge Android 以整页/抽屉打开 popup）占满宽高，顶栏与底栏吸附。
 * 设置写入走 useSettings（直接改 settings.value），熟词/同步等需要 background 协调的操作走消息。
 */
const { settings } = useSettings();
const { books } = useBooks();

/**
 * 触屏整页布局判定：桌面 popup 视口本身只有约 380px 宽，不能用宽度判断；
 * 除 pointer: coarse 外再看 UA（部分移动浏览器/模拟环境下扩展页面的 pointer 媒体查询不可靠）。
 */
const touchUi = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const data = usePopupData(settings);

// 界面主题与选项页一致：auto 时不设置 data-theme，交给 prefers-color-scheme
watch(
  () => settings.value?.ui.theme,
  (theme) => {
    if (!theme || theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  },
  { immediate: true },
);

// ---------------- 页面状态 ----------------

const siteDisabled = computed(() => !!settings.value && !!data.hostname.value && isSiteDisabled(settings.value, data.hostname.value));
const pageStatus = computed(() =>
  resolvePageStatus({
    loaded: data.loaded.value && !!settings.value,
    url: data.url.value,
    contentReady: data.contentReady.value,
    enabled: !!settings.value?.enabled,
    siteDisabled: siteDisabled.value,
    hostAccess: data.hostAccess.value,
  }),
);
const siteEnabled = computed({
  get: () => !siteDisabled.value,
  set: (on: boolean) => {
    if (!settings.value || !data.hostname.value) return;
    settings.value.sites.disabled = toggleSiteRule(settings.value.sites.disabled, data.hostname.value, on);
  },
});
const pageStatusText = computed<StatusText>(() => {
  switch (pageStatus.value) {
    case 'loading':
      return { text: '读取页面…', tone: 'muted' };
    case 'unsupported':
      return { text: '浏览器内置页面无法高亮', tone: 'muted' };
    case 'paused':
      return { text: '高亮已全局暂停', tone: 'warn' };
    case 'site-off':
      return { text: '已在此网站关闭高亮', tone: 'muted' };
    case 'no-access':
      return { text: '需要授权访问此网站', tone: 'error' };
    case 'not-injected':
      return { text: '刷新页面后开始高亮', tone: 'warn' };
    default:
      // 生词数只在“本页生词”标签角标上显示，这里不重复
      return { text: '正在高亮', tone: 'ok' };
  }
});

function reloadPage() {
  if (data.tabId.value === undefined) return;
  void browser.tabs.reload(data.tabId.value);
  window.close();
}

// ---------------- 网站访问权限 ----------------

/** 缺少“访问所有网站”权限：本页不能高亮时醒目提示；本站单独授权过（页面已高亮）时只给轻提示 */
const needsAccess = computed(() => data.hostAccess.value === false);
const requestingAccess = ref(false);

/**
 * 授权按钮：requestAllSitesAccess 必须是第一句——Firefox 要求权限申请在用户点击的同步调用栈内发起，
 * 前面有任何 await 都会被拒绝。授权成功后刷新目标页让内容脚本注入（已打开的页面不会自动注入）。
 */
async function grantAccess() {
  const pending = requestAllSitesAccess();
  requestingAccess.value = true;
  const granted = await pending;
  requestingAccess.value = false;
  await data.refreshHostAccess();
  if (!granted) {
    showToast('未获得授权。也可以在浏览器的扩展详情中把“网站访问权限”改为“在所有网站上”');
    return;
  }
  if (data.tabId.value !== undefined && isScriptableUrl(data.url.value)) {
    showToast('已授权，正在刷新页面…');
    await browser.tabs.reload(data.tabId.value).catch(() => undefined);
    window.close();
  } else {
    showToast('已授权，打开的网页刷新后开始高亮');
  }
}

// ---------------- 词书 ----------------

const pickerOpen = ref(false);
const bookById = computed(() => new Map<string, BookMeta>(books.value.map((b) => [b.id, b])));
const enabledMetas = computed(() =>
  (settings.value?.books.enabled ?? []).map((id) => bookById.value.get(id)).filter((b): b is BookMeta => !!b),
);
const enabledWordTotal = computed(() => enabledMetas.value.reduce((n, b) => n + b.size, 0));
const markOf = (id: BookId) => resolveMarkStyle(settings.value!, id);

function toggleBook(id: BookId, on: boolean) {
  if (!settings.value) return;
  settings.value.books.enabled = toggleEnabledBook(settings.value.books.enabled, id, on);
}

// ---------------- 高亮样式预设 ----------------

const { main: mainPresets } = presetGroups();
/** 预设条：自定义样式在最前（当前正在用时），然后是全部非旧版预设；当前使用旧版配色时也把它放在最前 */
const presetChips = computed(() => {
  const s = settings.value;
  if (!s) return [];
  const chips = mainPresets.map((t) => ({ id: t.id, name: t.name, mark: t.mark }));
  if (s.style.themeId === CUSTOM_THEME_ID) chips.unshift({ id: CUSTOM_THEME_ID, name: '自定义', mark: s.style.custom.mark });
  else if (!chips.some((c) => c.id === s.style.themeId)) chips.unshift({ id: s.style.themeId, name: '当前', mark: resolveMarkStyle(s) });
  return chips;
});
const presetStrip = ref<HTMLElement>();

function choosePreset(id: string) {
  if (!settings.value || settings.value.style.themeId === id) return;
  applyPreset(settings.value, id);
}

/**
 * 打开时定位当前预设：在首屏内就从最左开始（不裁掉第一张），靠后时让它完整可见并露出半张下一项。
 * 不用 scrollIntoView（inline:center 会把第一张裁掉一半，还可能带动整页纵向滚动）。
 */
watch(
  presetStrip,
  (el) => {
    const chip = el?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!el || !chip) return;
    const base = el.getBoundingClientRect().left - el.scrollLeft;
    const leftOf = (c: Element) => c.getBoundingClientRect().left - base;
    // 对齐后左侧只留一个间距（gap），上一张恰好完全移出可视区，不露出一条边
    const [first, second] = el.children;
    const pad = first && second ? leftOf(second) - leftOf(first) - (first as HTMLElement).offsetWidth : 0;
    el.scrollLeft = presetScrollLeft({
      itemLeft: leftOf(chip),
      itemWidth: chip.offsetWidth,
      viewport: el.clientWidth,
      peek: chip.offsetWidth / 2,
      max: el.scrollWidth - el.clientWidth,
      snaps: [...el.children].map((c) => leftOf(c) - pad),
    });
  },
  { flush: 'post' },
);

// ---------------- 行内释义 ----------------

/** 开启时的显示方式（“关闭”由开关负责） */
const inlineShowOptions: { value: Exclude<InlineTranslationMode, 'off'>; label: string }[] = [
  { value: 'after', label: '词后括注' },
  { value: 'ruby', label: '词上方' },
];
type InlineShowMode = (typeof inlineShowOptions)[number]['value'];

function readLastInlineMode(): string | null {
  try {
    return localStorage.getItem(LAST_INLINE_MODE_KEY);
  } catch {
    return null;
  }
}

/** 行内释义快速开关：关闭时记住当前方式，再打开时恢复 */
const inlineOn = computed({
  get: () => !!settings.value && settings.value.inlineTranslation.mode !== 'off',
  set: (on: boolean) => {
    const s = settings.value;
    if (!s || on === (s.inlineTranslation.mode !== 'off')) return;
    s.inlineTranslation.mode = nextInlineMode(
      s.inlineTranslation.mode,
      readLastInlineMode(),
      inlineShowOptions.map((o) => o.value),
    );
  },
});
const inlineShowMode = computed<InlineShowMode>({
  get: () => {
    const m = settings.value?.inlineTranslation.mode;
    return inlineShowOptions.some((o) => o.value === m) ? (m as InlineShowMode) : 'after';
  },
  set: (m) => {
    if (settings.value) settings.value.inlineTranslation.mode = m;
  },
});
// 记住最近一次开启的方式（本机界面偏好，不同步）
watch(
  () => settings.value?.inlineTranslation.mode,
  (m) => {
    if (!m || m === 'off') return;
    try {
      localStorage.setItem(LAST_INLINE_MODE_KEY, m);
    } catch {
      /* 隐私模式等不可用时忽略，下次开启用默认方式 */
    }
  },
);

// ---------------- 单词列表 ----------------

type Tab = 'page' | 'known';
const tab = ref<Tab>('page');
const query = ref('');
/** 首屏最多渲染的行数，避免几百个词时一次渲染过多 DOM */
const PAGE_SIZE = 60;
const limit = ref(PAGE_SIZE);
/** 桌面 popup 列表默认在卡片内滚动（约 5 行）；“查看全部”后取消高度限制，随整页滚动 */
const listExpanded = ref(false);
watch([tab, query], () => (limit.value = PAGE_SIZE));

const knownList = computed(() => recentKnownWords(data.known.value, 200).map((k) => k.word));
const knownTotal = computed(() => Object.keys(data.known.value.words).length);
const sourceWords = computed(() => (tab.value === 'page' ? data.pageLemmas.value : knownList.value));
const filtered = computed(() => filterWords(sourceWords.value, query.value));
const shownWords = computed(() => filtered.value.slice(0, limit.value));

const rows = computed<WordRow[]>(() =>
  shownWords.value.map((word) => {
    const entry = data.entries.value.get(word);
    if (tab.value === 'known') return { word, meaning: oneLineMeaning(entry?.short, 48) };
    const first = data.booksOf(word)[0];
    const meta = first ? bookById.value.get(first) : undefined;
    return {
      word,
      meaning: oneLineMeaning(entry?.short, 48),
      swatch: first && settings.value ? solidSwatch(resolveMarkStyle(settings.value, first)) : undefined,
      // 只启用一本词书时标签没有区分意义，不显示
      badge: meta && enabledMetas.value.length > 1 ? meta.short : undefined,
    };
  }),
);

// 展示的词与词典来源变化时补查释义
watch([shownWords, data.dictVersion], ([words]) => void data.lookup(words), { immediate: true });

// ---------------- 熟词操作 ----------------

const busy = ref(new Set<string>());
function setBusy(word: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(word);
  else next.delete(word);
  busy.value = next;
}

async function markKnown(word: string) {
  setBusy(word, true);
  // 乐观更新：先从本页列表隐藏，页面复核后 background 会重新上报
  data.hiddenLemmas.value = new Set([...data.hiddenLemmas.value, word]);
  try {
    const res = await sendToBackground('markKnown', { word, lemma: word });
    // 远端删除失败（离线 / 登录失效）时如实提示“未删除”，不显示成全部完成
    const tip = markKnownToast(word, res, online.value);
    showToast(tip.text, { label: '撤销', run: () => void unmarkKnown(word) });
  } catch (e) {
    const next = new Set(data.hiddenLemmas.value);
    next.delete(word);
    data.hiddenLemmas.value = next;
    showToast(`操作失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(word, false);
  }
}

async function unmarkKnown(word: string) {
  setBusy(word, true);
  try {
    await sendToBackground('unmarkKnown', { lemma: word });
    const next = new Set(data.hiddenLemmas.value);
    next.delete(word);
    data.hiddenLemmas.value = next;
    showToast(`已将 ${word} 移出熟词本`);
  } catch (e) {
    showToast(`操作失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(word, false);
  }
}

// ---------------- 单词详情 ----------------

const detailWord = ref('');
const detailOpen = computed({
  get: () => !!detailWord.value,
  set: (v: boolean) => {
    if (!v) detailWord.value = '';
  },
});
const detailEntry = computed(() => data.entries.value.get(detailWord.value));
const detailKnown = computed(() => !!detailWord.value && detailWord.value in data.known.value.words);
const detailBooks = computed(() =>
  data.booksOf(detailWord.value).map((id) => bookById.value.get(id)).filter((b): b is BookMeta => !!b),
);
/** 命中且来源支持删除的来源词书 */
const deletableBooks = computed(() =>
  detailBooks.value.filter((b) => b.kind === 'source' && !!getProviderInfo(b.providerId ?? '')?.capabilities.delete),
);
const confirmDelete = ref(false);
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

function openDetail(word: string) {
  detailWord.value = word;
  confirmDelete.value = false;
  void data.lookup([word]);
  void refreshCollected(word);
}

/**
 * 发音：后台有 chrome.tts 时由后台朗读；后台没有朗读引擎时返回 reason='unavailable'（附 fallback 参数），
 * sendToBackground 会先用 fallback 在本页朗读，这里再兜底一次（旧版后台不带 fallback 时）直接用 Web Speech 朗读，
 * 仍不行才提示（Firefox、部分移动端没有 chrome.tts）。
 */
async function speak(word = detailWord.value) {
  if (!word) return;
  const res = await sendToBackground('tts', { text: word, force: true }).catch(() => undefined);
  if (res?.spoken) return;
  if (!res || res.reason === 'unavailable') {
    const tts = settings.value?.tts;
    const local = await speakText(word, { lang: 'en', ...tts?.voice, rate: tts?.rate });
    if (local.spoken) return;
  }
  showToast('当前浏览器没有可用的朗读语音，可在系统设置中安装英语语音');
}

// ---------------- 收藏（加入我的生词本） ----------------

/** 详情中单词是否已在任一生词本（来源或本地）；undefined = 尚未查询或后台不支持 */
const detailCollected = ref<boolean>();
async function refreshCollected(word: string) {
  detailCollected.value = undefined;
  const st = await sendToBackground('getWordState', { lemma: word }).catch(() => undefined);
  if (detailWord.value === word) detailCollected.value = st?.collected;
}

async function collect() {
  const word = detailWord.value;
  const entry = data.entries.value.get(word);
  detailCollected.value = true;
  try {
    const res = await sendToBackground('addWord', { word, lemma: word, trans: entry?.short, phonetic: entry?.phonetic });
    const failed = res.added.find((r) => !r.ok && !r.skipped);
    if (!res.ok || failed) {
      if (detailWord.value === word) detailCollected.value = false;
      showToast(`收藏失败：${failed?.error || res.message || (online.value ? '未知错误' : '当前离线')}`);
      return;
    }
    showToast(res.message || `已收藏 ${word}`, { label: '撤销', run: () => void sendToBackground('removeWord', { lemma: word }).catch(() => undefined) });
  } catch (e) {
    if (detailWord.value === word) detailCollected.value = false;
    showToast(`收藏失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function detailToggleKnown() {
  const word = detailWord.value;
  const wasKnown = detailKnown.value;
  detailWord.value = '';
  if (wasKnown) await unmarkKnown(word);
  else await markKnown(word);
}

/** 从来源生词本删除：远端删除不可撤销，第一次点击进入确认态（3 秒内再点一次执行） */
async function deleteFromSources() {
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => (confirmDelete.value = false), 3000);
    return;
  }
  const word = detailWord.value;
  const bookIds = deletableBooks.value.map((b) => b.id);
  detailWord.value = '';
  setBusy(word, true);
  try {
    const res = await sendToBackground('deleteSourceWords', { word, bookIds });
    showToast(res.message || (res.ok ? `已从生词本删除 ${word}` : `删除失败`));
  } catch (e) {
    showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(word, false);
  }
}

// ---------------- 同步 ----------------

/**
 * 总同步状态：优先用 background 的 getStatusSummary（与选项页文案一致），不支持时用本地状态兜底计算。
 * 每行一种同步方式（有道 / 欧路 / 浏览器账号 / WebDAV），出错时按钮变为“处理”，跳到设置页对应位置。
 */
const syncChannels = computed<SyncChannel[]>(() => {
  const summary = data.statusSummary.value;
  if (summary) return channelsFromStatusItems(summary.items);
  if (!settings.value) return [];
  return buildSyncChannels({
    books: books.value,
    sources: settings.value.sources,
    providers: SOURCE_PROVIDER_INFOS,
    storageSync: data.syncStatus.value,
    webdav: data.webdavStatus.value,
  });
});
const syncOverall = computed<StatusText>(() => {
  const st = overallSyncStatus(syncChannels.value);
  const last = data.statusSummary.value?.lastSyncAt;
  // 正常时带上最近同步时间（“同步正常 · 3 小时前”），折叠成一行也能看出是否在工作
  return st.tone === 'ok' && last ? { ...st, text: `${st.text} · ${formatAgo(last)}` } : st;
});
/** 同步卡片展开：有出错/待处理项时自动展开，正常时折叠成一行（用户可手动展开） */
const syncExpandedByUser = ref(false);
const syncNeedsAttention = computed(() => syncChannels.value.some((c) => c.status.tone === 'error' || c.status.tone === 'warn'));
const syncExpanded = computed(() => syncNeedsAttention.value || syncExpandedByUser.value);
const syncCard = ref<HTMLElement>();
function scrollToSync() {
  syncExpandedByUser.value = true;
  syncCard.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------- 顶部状态位（离线 / 同步出错） ----------------

const online = ref(navigator.onLine);
const onOnline = () => {
  online.value = true;
  data.refreshSummary(0);
};
const onOffline = () => (online.value = false);
addEventListener('online', onOnline);
addEventListener('offline', onOffline);
const statusAlert = computed(() => resolveStatusAlert({ online: online.value, channels: syncChannels.value }));
function runAlertAction() {
  const a = statusAlert.value?.action;
  if (!a) return;
  if (a.scroll) scrollToSync();
  else openOptions(a.route);
}
/** 正在手动同步的行 id（'all' = 全部） */
const syncingIds = ref(new Set<string>());
const syncBusy = (id: string) => syncingIds.value.has(id) || syncingIds.value.has('all');
function setSyncing(id: string, on: boolean) {
  const next = new Set(syncingIds.value);
  if (on) next.add(id);
  else next.delete(id);
  syncingIds.value = next;
}
const CHANNEL_ICON = { source: 'book', 'storage-sync': 'cloud', webdav: 'server' } as const;

/** 来源同步结果汇总为一句提示 */
function sourceResultText(label: string, results: { ok: boolean; count?: number; message: string }[]): string {
  if (!results.length) return `${label}：没有可同步的生词本`;
  const ok = results.filter((r) => r.ok);
  const failed = results.find((r) => !r.ok);
  const words = ok.reduce((n, r) => n + (r.count ?? 0), 0);
  return `${label}：${ok.length}/${results.length} 本同步成功，共 ${words} 词${failed ? `；${failed.message}` : ''}`;
}

/** 立即同步某一种方式；出错的行由按钮直接跳设置页，不走这里 */
async function syncChannel(c: SyncChannel) {
  setSyncing(c.id, true);
  try {
    if (c.kind === 'source') {
      const results = await sendToBackground('syncSourceBooks', { providerId: c.providerId });
      showToast(sourceResultText(c.label, results));
    } else if (c.kind === 'webdav') {
      const st = await sendToBackground('webdavSyncNow', {});
      data.webdavStatus.value = st;
      showToast(st.phase === 'error' ? `WebDAV 同步失败：${st.error ?? '未知错误'}` : 'WebDAV 已同步');
    } else {
      const st = await sendToBackground('syncNow', {});
      data.syncStatus.value = st;
      showToast(st.phase === 'error' ? `浏览器账号同步失败：${st.error ?? '未知错误'}` : st.notice || '浏览器账号已同步');
    }
  } catch (e) {
    showToast(`同步失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setSyncing(c.id, false);
    data.refreshSummary(0);
  }
}

/** 全部同步：后台支持 syncAll 时一次完成并给出汇总文案；否则逐个调用 */
async function syncAll() {
  setSyncing('all', true);
  try {
    const res = await sendToBackground('syncAll', {}).catch(() => undefined);
    if (res) {
      data.statusSummary.value = res.summary;
      showToast(res.message || (res.ok ? '已全部同步' : '部分同步失败'));
    } else {
      for (const c of syncChannels.value) await syncChannel(c);
    }
  } finally {
    setSyncing('all', false);
    data.refreshSummary(0);
  }
}

/** 关闭升级提示（后台清除 updateNotice） */
function dismissUpdate() {
  if (data.statusSummary.value) data.statusSummary.value = { ...data.statusSummary.value, updateNotice: undefined };
  void sendToBackground('dismissUpdateNotice', {}).catch(() => undefined);
}

// ---------------- 导航 ----------------

/** 打开设置页（hash 见 OPTIONS_ROUTES） */
function openOptions(hash = '') {
  void browser.tabs.create({ url: browser.runtime.getURL('/options.html') + hash });
  window.close();
}

// ---------------- 提示条 ----------------

const toast = ref<{ text: string; action?: { label: string; run: () => void } } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, action?: { label: string; run: () => void }) {
  toast.value = { text, action };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), action ? 6000 : 3500);
}
function runToastAction() {
  toast.value?.action?.run();
  toast.value = null;
}
onBeforeUnmount(() => {
  removeEventListener('online', onOnline);
  removeEventListener('offline', onOffline);
  clearTimeout(toastTimer);
  clearTimeout(confirmTimer);
});
</script>

<template>
  <main v-if="settings" class="popup" :class="{ touch: touchUi }">
    <header class="top">
      <div class="top-row">
        <img class="logo" src="/icons/48.png" alt="" width="28" height="28" />
        <strong class="brand">生词高亮</strong>
        <span class="spacer" />
        <button type="button" class="icon-btn" title="全部设置" aria-label="全部设置" @click="openOptions()">
          <PopupIcon name="settings" />
        </button>
        <!-- 总开关带文字，与本站卡片里的“本站”开关区分 -->
        <ToggleSwitch v-model="settings.enabled" class="master" title="总开关：在所有网站高亮生词" aria-label="总开关：在所有网站高亮生词">
          <span class="master-label">全部网站</span>
        </ToggleSwitch>
      </div>
      <!-- 顶部固定状态位：离线 / 同步出错时一行告警 + 具体处理动作（网站未授权由本站卡片直接切换为授权态） -->
      <div v-if="statusAlert" class="status-alert" :class="`al-${statusAlert.tone}`" role="alert">
        <PopupIcon name="alert" :size="15" />
        <span class="al-text" :title="statusAlert.text">{{ statusAlert.text }}</span>
        <button v-if="statusAlert.action" type="button" class="al-act" @click="runAlertAction">
          {{ statusAlert.action.label }}<PopupIcon name="chevron" :size="14" />
        </button>
      </div>
    </header>

    <div class="content">

      <!-- 升级说明入口（background 在升级后写入 updateNotice，选项页展示详细说明） -->
      <div v-if="data.statusSummary.value?.updateNotice" class="update">
        <span>已更新到 {{ data.statusSummary.value.updateNotice.to }}</span>
        <button type="button" class="link-btn" @click="openOptions()">看看新功能</button>
        <button type="button" class="x" aria-label="不再提示" title="不再提示" @click="dismissUpdate">
          <PopupIcon name="close" :size="14" />
        </button>
      </div>

      <!-- 本站 -->
      <section class="card site" :class="`st-${pageStatus}`" :role="pageStatus === 'no-access' ? 'alert' : undefined">
        <div class="site-row">
          <span class="fav" aria-hidden="true">
            <img v-if="data.favIconUrl.value" :src="data.favIconUrl.value" alt="" width="18" height="18" />
            <PopupIcon v-else name="globe" :size="18" />
          </span>
          <span class="site-text">
            <span class="host">{{ data.hostname.value || '当前页面' }}</span>
            <span class="status" :class="`tone-${pageStatusText.tone}`">
              <i class="dot" />{{ pageStatusText.text }}
            </span>
          </span>
          <!-- 未授权时本站开关没有意义（开着也不会高亮），换成唯一的主操作“授权” -->
          <button
            v-if="pageStatus === 'no-access'"
            type="button"
            class="btn primary grant"
            :disabled="requestingAccess"
            @click="grantAccess"
          >
            <PopupIcon name="shield" :size="15" />{{ requestingAccess ? '等待确认…' : '授权' }}
          </button>
          <ToggleSwitch
            v-else-if="data.hostname.value && pageStatus !== 'unsupported'"
            v-model="siteEnabled"
            :aria-label="`在 ${data.hostname.value} 上高亮`"
            :title="siteEnabled ? '在此网站关闭高亮' : '在此网站开启高亮'"
          />
        </div>
        <p v-if="pageStatus === 'no-access'" class="access-note">
          浏览器限制了本扩展读取网页（扩展的“网站访问权限”未开启），所以无法高亮。授权后自动刷新本页。
        </p>
        <div v-else-if="needsAccess && pageStatus === 'active'" class="hint">
          <span>只授权了部分网站，其他网站不会高亮</span>
          <button type="button" class="btn small" :disabled="requestingAccess" @click="grantAccess">全部授权</button>
        </div>
        <div v-else-if="pageStatus === 'paused'" class="hint">
          <span>所有网站都不会高亮生词</span>
          <button type="button" class="btn small primary" @click="settings.enabled = true">开启</button>
        </div>
        <div v-else-if="pageStatus === 'not-injected'" class="hint">
          <span>页面在扩展启用前打开，刷新后生效</span>
          <button type="button" class="btn small" @click="reloadPage"><PopupIcon name="refresh" :size="14" />刷新</button>
        </div>
      </section>

      <!-- 词书 -->
      <section class="card">
        <button type="button" class="card-head as-btn" @click="pickerOpen = true">
          <span class="head-text">
            <h2>词书</h2>
            <span class="sub">
              {{ enabledMetas.length ? `共 ${formatCount(enabledWordTotal)} 词 · 可多本组合` : '未启用任何词书' }}
            </span>
          </span>
          <span class="link">切换<PopupIcon name="chevron" :size="16" /></span>
        </button>
        <div v-if="enabledMetas.length" class="chips">
          <button v-for="b in enabledMetas" :key="b.id" type="button" class="chip" @click="pickerOpen = true">
            <MarkPreview :mark="markOf(b.id)" word="Aa" />
            <span class="chip-name">{{ b.name }}</span>
          </button>
        </div>
        <button v-else type="button" class="btn primary block" @click="pickerOpen = true">选择词书</button>
      </section>

      <!-- 样式与行内释义 -->
      <section class="card look">
        <div class="look-head">
          <h2>高亮样式</h2>
          <button type="button" class="link as-link" @click="openOptions(OPTIONS_ROUTES.appearance)">
            调整<PopupIcon name="chevron" :size="16" />
          </button>
        </div>
        <div ref="presetStrip" class="presets" role="radiogroup" aria-label="高亮样式预设">
          <button
            v-for="p in presetChips"
            :key="p.id"
            type="button"
            role="radio"
            class="preset"
            :aria-checked="settings.style.themeId === p.id"
            :title="p.name"
            @click="choosePreset(p.id)"
          >
            <span class="preset-sample"><MarkPreview :mark="p.mark" word="Word" /></span>
            <span class="preset-name">{{ p.name }}</span>
          </button>
        </div>
        <!-- 行内释义：开关 + 显示方式同一行，关闭时只留开关 -->
        <div class="inline-row">
          <span class="head-text" title="在生词旁显示简短中文释义">
            <span class="inline-title">行内释义</span>
            <span v-if="!inlineOn" class="sub">只高亮，点按或悬停看释义</span>
          </span>
          <SegmentedControl v-if="inlineOn" v-model="inlineShowMode" class="seg" :options="inlineShowOptions" />
          <ToggleSwitch v-model="inlineOn" class="inline-toggle" aria-label="行内释义" />
        </div>
      </section>

      <!-- 本页生词 / 熟词本 -->
      <section class="card words">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="tab === 'page'" :class="{ on: tab === 'page' }" @click="tab = 'page'">
            本页生词<span class="count">{{ data.pageLemmas.value.length }}</span>
          </button>
          <button type="button" role="tab" :aria-selected="tab === 'known'" :class="{ on: tab === 'known' }" @click="tab = 'known'">
            熟词本<span class="count">{{ knownTotal }}</span>
          </button>
        </div>
        <label v-if="sourceWords.length > 8" class="search">
          <PopupIcon name="search" :size="16" />
          <input v-model="query" type="search" :placeholder="tab === 'page' ? '筛选本页生词' : '筛选最近的熟词'" />
        </label>

        <div class="list-wrap" :class="{ expanded: listExpanded }">
          <WordList
            v-if="rows.length"
            :rows="rows"
            :action="tab === 'page' ? 'known' : 'undo'"
            :busy="busy"
            @open="openDetail"
            @speak="speak"
            @act="(w) => (tab === 'page' ? markKnown(w) : unmarkKnown(w))"
          />
          <div v-else class="empty">
            <template v-if="query">没有匹配“{{ query }}”的单词</template>
            <template v-else-if="tab === 'known'">还没有熟词。点生词右侧的 <PopupIcon name="check-check" :size="14" class="inline-icon" /> 即可标为熟词，之后不再高亮</template>
            <template v-else-if="pageStatus === 'active'">本页没有命中启用词书的生词</template>
            <template v-else>{{ pageStatusText.text }}</template>
          </div>
          <button v-if="filtered.length > limit" type="button" class="more" @click="limit += PAGE_SIZE * 4">
            显示更多（还有 {{ filtered.length - limit }} 个）
          </button>
          <p v-if="tab === 'known' && knownTotal > knownList.length && !query" class="foot-note">
            仅显示最近 {{ knownList.length }} 个，<a href="#" @click.prevent="openOptions(OPTIONS_ROUTES.known)">管理全部熟词</a>
          </p>
        </div>
        <!-- 桌面：列表默认卡片内滚动，超过约 5 行时给出明确的“查看全部”入口（触屏整页本就随页面滚动） -->
        <button v-if="!touchUi && !listExpanded && filtered.length > 5" type="button" class="more see-all" @click="listExpanded = true">
          查看全部 {{ filtered.length }} 个<PopupIcon name="chevron" :size="14" class="down" />
        </button>
      </section>

      <!-- 总同步状态 -->
      <section ref="syncCard" class="card sync" :class="[`sync-${syncOverall.tone}`, { collapsed: !syncExpanded }]">
        <div class="sync-head">
          <!-- 正常时折叠成一行，点标题展开各项；有出错/待处理项时固定展开 -->
          <button
            type="button"
            class="sync-toggle"
            :aria-expanded="syncExpanded"
            :disabled="syncNeedsAttention || !syncChannels.length"
            @click="syncExpandedByUser = !syncExpandedByUser"
          >
            <h2>同步</h2>
            <span class="sync-overall" :class="`tone-${syncOverall.tone}`"><i class="dot" />{{ syncOverall.text }}</span>
            <PopupIcon v-if="syncChannels.length && !syncNeedsAttention" name="chevron" :size="14" class="caret" />
          </button>
          <span class="spacer" />
          <button
            v-if="syncChannels.length > 1"
            type="button"
            class="btn small"
            :disabled="syncBusy('all')"
            @click="syncAll"
          >
            <PopupIcon name="refresh" :size="14" :class="{ spin: syncBusy('all') }" />全部同步
          </button>
        </div>
        <ul v-if="syncChannels.length && syncExpanded" class="sync-list">
          <li v-for="c in syncChannels" :key="c.id" class="sync-row">
            <PopupIcon :name="CHANNEL_ICON[c.kind]" class="sync-ic" />
            <span class="sync-text">
              <span class="sync-label">{{ c.label }}</span>
              <!-- 出错原因最多两行，完整文本见 title；按钮写具体修复动作 -->
              <span class="sync-status" :class="`tone-${c.status.tone}`" :title="c.status.text">{{ c.status.text }}</span>
            </span>
            <button v-if="c.action === 'fix'" type="button" class="btn small fix" @click="openOptions(c.route)">
              {{ syncFixVerb(c) }}<PopupIcon name="chevron" :size="14" />
            </button>
            <button
              v-else
              type="button"
              class="btn small"
              :disabled="syncBusy(c.id) || c.running"
              :aria-label="`立即同步${c.label}`"
              @click="syncChannel(c)"
            >
              <PopupIcon name="refresh" :size="14" :class="{ spin: syncBusy(c.id) || c.running }" />同步
            </button>
          </li>
        </ul>
        <div v-else-if="!syncChannels.length" class="sync-empty">
          <span>连接有道 / 欧路生词本，或开启跨设备同步</span>
          <button type="button" class="btn small" @click="openOptions(OPTIONS_ROUTES.sources)">去设置</button>
        </div>
      </section>
    </div>

    <footer class="bottom">
      <button type="button" class="btn" @click="openOptions(OPTIONS_ROUTES.importBooks)">导入词书</button>
      <!-- 次要样式：主操作（授权 / 启用词书）才用实心主色，避免与之抢视线 -->
      <button type="button" class="btn" @click="openOptions()">
        <PopupIcon name="settings" :size="16" />全部设置
      </button>
    </footer>

    <BottomSheet v-model="pickerOpen" title="切换词书" subtitle="可多选组合；先启用的词书优先决定高亮颜色">
      <BookPicker :books="books" :enabled="settings.books.enabled" :mark-of="markOf" @toggle="toggleBook" />
      <template #footer>
        <button type="button" class="btn" @click="openOptions(OPTIONS_ROUTES.books)">管理与排序</button>
        <button type="button" class="btn primary" @click="pickerOpen = false">完成</button>
      </template>
    </BottomSheet>

    <BottomSheet v-model="detailOpen" :title="detailWord">
      <template #title><h2 class="detail-word">{{ detailWord }}</h2></template>
      <WordDetail :word="detailWord" :entry="detailEntry" :books="detailBooks" :known="detailKnown" @speak="speak" />
      <template #footer>
        <button v-if="deletableBooks.length && !detailKnown" type="button" class="btn danger" @click="deleteFromSources">
          <PopupIcon name="trash" :size="16" />{{ confirmDelete ? '确认删除？' : '从生词本删除' }}
        </button>
        <button v-if="detailCollected === false && !detailKnown" type="button" class="btn" @click="collect">
          <PopupIcon name="star" :size="16" />收藏
        </button>
        <button type="button" class="btn" :class="{ primary: !detailKnown }" @click="detailToggleKnown">
          <PopupIcon :name="detailKnown ? 'undo' : 'check-check'" :size="16" />{{ detailKnown ? '移出熟词本' : '标为熟词' }}
        </button>
      </template>
    </BottomSheet>

    <Transition name="toast">
      <div v-if="toast" class="toast" role="status">
        <span>{{ toast.text }}</span>
        <button v-if="toast.action" type="button" @click="runToastAction">{{ toast.action.label }}</button>
      </div>
    </Transition>
  </main>
</template>

<style scoped>
/* 桌面 popup：固定宽度，高度随内容（浏览器上限约 600px，超出时整页滚动，顶栏吸附） */
.popup { width: 380px; display: flex; flex-direction: column; background: var(--bg); }
.top { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--border); }
.top-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 14px; }
.master-label { font-size: 12px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
.master :deep(.text) { flex: none; }
.master { gap: 6px; }

/* 顶部固定状态位：一行，高度 ≤ 36px，不把下面的内容推出首屏太多 */
.status-alert {
  display: flex; align-items: center; gap: 8px; min-height: 33px; padding: 3px 6px 3px 12px; font-size: 12.5px;
  border-top: 1px solid var(--border);
}
.status-alert.al-error { background: var(--danger-soft); color: var(--danger); }
.status-alert.al-warn { background: color-mix(in srgb, var(--warn) 14%, var(--surface)); color: var(--warn); }
.al-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.al-act {
  flex: none; display: inline-flex; align-items: center; gap: 2px; min-height: 28px; padding: 0 8px; border-radius: 8px;
  border: 1px solid currentColor; background: var(--surface); color: inherit; font-weight: 650; font-size: 12.5px; cursor: pointer;
}
.logo { border-radius: 7px; }
.brand { font-size: 15.5px; font-weight: 700; letter-spacing: .02em; }
.spacer { flex: 1; }
.master { min-height: 0; }
.icon-btn {
  display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  border: 0; background: transparent; color: var(--text-2); cursor: pointer;
}
.icon-btn:hover { background: var(--surface-2); color: var(--text); }

.content { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
h2 { margin: 0; font-size: 14px; font-weight: 650; }
.head-text { display: flex; flex-direction: column; min-width: 0; }
.sub { color: var(--text-2); font-size: 12px; }

/* 本站 */
.site-row { display: flex; align-items: center; gap: 10px; }
.fav { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: var(--surface-2); color: var(--text-2); flex: none; }
.fav img { border-radius: 3px; }
.site-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.host { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
.status .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.hint {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 6px 6px 10px; border-radius: var(--radius-sm); background: var(--surface-2); font-size: 12.5px; color: var(--text-2);
}
.st-paused .hint { background: var(--accent-soft); color: var(--text); }

.tone-ok { color: var(--success); }
.tone-warn { color: var(--warn); }
.tone-error { color: var(--danger); }
.tone-busy { color: var(--accent); }
.tone-muted { color: var(--text-2); }

/* 词书 */
.as-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 0; border: 0; background: none;
  text-align: left; cursor: pointer;
}
.as-btn .head-text { flex: 1; }
.link { display: inline-flex; align-items: center; gap: 2px; color: var(--accent); font-size: 13px; font-weight: 600; flex: none; }
.chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 -12px; padding: 0 12px; }
.chips::-webkit-scrollbar { display: none; }
.chip { flex: none; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 30px; padding: 3px 10px 3px 6px;
  border-radius: 999px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 12.5px;
}
.chip:hover { border-color: var(--accent); }
.chip :deep(.preview) { font-weight: 700; font-size: 12px; padding: 0 4px; }
.chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.block { width: 100%; }

/* 网站访问权限：本站卡片切换为授权态（醒目边框 + 唯一主按钮“授权”） */
.st-no-access { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); background: color-mix(in srgb, var(--danger) 6%, var(--surface)); }
.grant { flex: none; min-height: 34px; padding: 4px 14px; font-weight: 650; gap: 5px; }
.access-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-2); }

/* 升级提示 */
.update {
  display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; border-radius: var(--radius-sm);
  background: var(--accent-soft); font-size: 12.5px;
}
.update span { flex: 1; min-width: 0; }
.link-btn { border: 0; background: none; color: var(--accent); font-weight: 650; cursor: pointer; padding: 4px 2px; font-size: 12.5px; }
.update .x { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 8px; background: none; color: var(--text-2); cursor: pointer; }

/* 高亮样式预设 + 行内释义 */
.look-head { display: flex; align-items: center; justify-content: space-between; }
.as-link { border: 0; background: none; padding: 2px 0; cursor: pointer; }
.presets {
  display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 -12px; padding: 2px 12px 4px;
  scroll-padding: 0 12px; overscroll-behavior-x: contain;
}
.presets::-webkit-scrollbar { display: none; }
/* 右缘渐隐：提示还能横向滑动 */
.presets { mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent); }
.preset {
  flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px; width: 64px; padding: 6px 4px 5px;
  border-radius: 10px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; color: var(--text);
}
.preset:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.preset[aria-checked='true'] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
/* 样例词用固定的正文色与背景，与网页上看到的效果接近 */
.preset-sample { font-size: 13.5px; line-height: 1.6; font-family: Georgia, 'Times New Roman', serif; color: var(--text); white-space: nowrap; }
.preset-name { font-size: 11px; color: var(--text-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset[aria-checked='true'] .preset-name { color: var(--accent); font-weight: 650; }
.inline-row { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); min-height: 46px; }
.inline-row .head-text { flex: 1; min-width: 0; }
.inline-row .seg { flex: 0 1 172px; }

.inline-title { font-weight: 650; font-size: 13.5px; }
.inline-toggle { min-height: 0; }

/* 单词列表 */
.words { padding-bottom: 4px; }
.tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--border); margin: -2px -12px 0; padding: 0 12px; }
.tabs button {
  position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0;
  border: 0; background: none; cursor: pointer; color: var(--text-2); font-weight: 600; font-size: 13.5px;
}
.tabs button.on { color: var(--text); }
.tabs button.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
.count { font-size: 11.5px; font-weight: 650; padding: 0 6px; line-height: 18px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.tabs button.on .count { background: var(--accent-soft); color: var(--accent); }
.search {
  display: flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text-2);
}
.search input { border: 0; background: transparent; min-height: 34px; padding: 0; outline: none; color: var(--text); }
.search:focus-within { box-shadow: 0 0 0 2px var(--accent); }
/* 桌面 popup 高度有限：列表内部滚动，保证同步状态与底栏在首屏可见 */
.list-wrap { max-height: 236px; overflow: auto; overscroll-behavior: contain; margin: 0 -6px; padding: 0 6px; }
.list-wrap.expanded { max-height: none; overflow: visible; }
.see-all { display: inline-flex; align-items: center; justify-content: center; gap: 2px; border-top: 1px solid var(--border); border-radius: 0; }
.see-all .down { transform: rotate(90deg); }
.empty { padding: 18px 8px; text-align: center; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.inline-icon { display: inline-block; vertical-align: -2px; }
.more { width: 100%; min-height: 36px; border: 0; background: none; color: var(--accent); cursor: pointer; font-weight: 600; font-size: 13px; }
.foot-note { margin: 4px 0 6px; text-align: center; font-size: 12px; color: var(--text-2); }

/* 同步 */
.sync { gap: 4px; }
.sync-head { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.sync-toggle {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; text-align: left;
}
.sync-toggle:disabled { cursor: default; }
.sync-toggle .caret { flex: none; color: var(--text-2); transform: rotate(90deg); transition: transform .15s; }
.sync.collapsed .sync-toggle .caret { transform: none; }
.sync.collapsed { padding-top: 6px; padding-bottom: 6px; }
.sync-overall { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sync-overall .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.sync-list { list-style: none; margin: 0; padding: 0; }
.sync-row { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 3px 0; }
.sync-row + .sync-row { border-top: 1px solid var(--border); }
.sync-ic { color: var(--text-2); }
.sync-text { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
.sync-label { font-size: 13px; font-weight: 600; }
.sync-status { font-size: 12px; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; word-break: break-word; }
.sync-status.tone-ok, .sync-status.tone-muted { color: var(--text-2); }
.btn.fix { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); font-weight: 650; gap: 0; }
.sync-empty { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); }
.sync-empty span { flex: 1; }
.btn.small { min-height: 30px; padding: 3px 10px; font-size: 12.5px; gap: 4px; flex: none; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 底栏 */
.bottom {
  position: sticky; bottom: 0; z-index: 5; display: flex; gap: 8px; padding: 10px 12px;
  background: var(--surface); border-top: 1px solid var(--border);
}
.bottom .btn { flex: 1; }

.detail-word { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .01em; word-break: break-word; }

/* 提示条 */
.toast {
  position: fixed; left: 12px; right: 12px; bottom: 68px; z-index: 30; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 10px 14px; border-radius: 12px; background: var(--toast-bg); color: var(--toast-fg); font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
}
.toast span { flex: 1; }
.toast button { flex: none; border: 0; background: none; color: var(--toast-act); font-weight: 700; cursor: pointer; min-height: 32px; padding: 0 6px; }
.toast-enter-active, .toast-leave-active { transition: opacity .18s, transform .18s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }

/* 提示条与页面反色；深色同样遵循设置里的界面主题（data-theme），与 tokens.css 规则一致 */
/* （Vue 的 :global() 会让整条规则变为全局，所以变量直接定义在根元素上，由 .popup 继承） */
:global(:root) { --toast-bg: #1f2328; --toast-fg: #fff; --toast-act: #fbbf24; }
@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme='light'])) { --toast-bg: #e8eaed; --toast-fg: #111317; --toast-act: #b45309; }
}
:global(:root[data-theme='dark']) { --toast-bg: #e8eaed; --toast-fg: #111317; --toast-act: #b45309; }

/*
 * 触屏（Edge Android 中 popup 以整页 / 底部抽屉打开，见 touchUi）：占满宽高，列表随页面滚动，底栏吸附在底部，点击区 ≥ 44px。
 */
.popup.touch { --tap: 44px; width: 100%; min-height: 100vh; min-height: 100dvh; }
.touch .top-row { padding: 8px 8px 8px 16px; padding-top: max(8px, env(safe-area-inset-top)); }
.touch .status-alert { min-height: 40px; padding-left: 16px; font-size: 13px; }
.touch .al-act { min-height: 36px; padding: 0 10px; font-size: 13px; }
/* 触屏整页高度充裕：告警原因最多两行，不截断修复提示 */
.touch .al-text { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; line-height: 1.4; }
.touch .master-label { font-size: 13px; }
.touch .brand { font-size: 17px; }
.touch .icon-btn { width: 44px; height: 44px; }
.touch .content { flex: 1; padding: 12px; gap: 12px; }
.touch .card { padding: 12px 14px; }
.touch .tabs { margin: -2px -14px 0; padding: 0 14px; gap: 22px; }
.touch .tabs button { min-height: 44px; font-size: 14.5px; }
.touch .chips { margin: 0 -14px; padding: 0 14px; }
.touch .chip { min-height: 38px; font-size: 13.5px; }
/* 子组件的触屏尺寸（其自身用 pointer: coarse，这里按 touchUi 兜底） */
.touch :deep(.list .main) { min-height: 52px; }
.touch :deep(.list .act) { width: 46px; height: 46px; }
.touch :deep(.list .act.say) { width: 40px; }
.touch :deep(.seg button) { min-height: 40px; }
.touch :deep(.icon-btn) { width: 44px; height: 44px; }
.touch :deep(.speak) { min-height: 40px; }
.touch .list-wrap { max-height: none; overflow: visible; }
/* 触屏整页：本页生词放在同步之前（首屏能看到单词）；同步出错由顶部状态位提示 */
.touch .presets { margin: 0 -14px; padding: 2px 14px 4px; scroll-padding: 0 14px; }
.touch .preset { width: 74px; padding: 8px 4px 7px; }
.touch .preset-sample { font-size: 15px; }
.touch .preset-name { font-size: 12px; }
.touch .as-link { min-height: 44px; }
.touch .inline-row { min-height: 52px; }
.touch .inline-title { font-size: 14.5px; }
.touch .look-head { margin: -6px 0 -4px; }
.touch .grant { min-height: 44px; font-size: 15px; }
.touch .access-note { font-size: 13px; }
.touch .update .x { width: 40px; height: 40px; }
.touch .link-btn { min-height: 40px; }
.touch .search input { min-height: 42px; font-size: 15px; }
.touch .sync-head { min-height: 40px; }
.touch .sync-row { min-height: 54px; }
.touch .sync-label { font-size: 14px; }
.touch .sync-status { font-size: 12.5px; }
.touch .btn.small { min-height: 38px; padding: 4px 12px; font-size: 13px; }
.touch .bottom { padding: 10px 12px; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
.touch .bottom .btn { min-height: 46px; font-size: 15px; }
.touch .toast { bottom: calc(80px + env(safe-area-inset-bottom)); }
</style>
