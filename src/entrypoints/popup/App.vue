<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
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
import SyncList from './components/SyncList.vue';
import WordList from './components/WordList.vue';
import {
  ALERT_SNOOZE_KEY,
  LAST_INLINE_MODE_KEY,
  isScriptableUrl,
  OPTIONS_ROUTES,
  buildSyncChannels,
  channelsFromStatusItems,
  filterWords,
  formatAgo,
  formatCount,
  friendlyChannels,
  isAlertSnoozed,
  markKnownToast,
  nextInlineMode,
  oneLineMeaning,
  overallSyncStatus,
  primaryFixChannel,
  syncFixVerb,
  recentKnownWords,
  resolveStatusAlert,
  resolvePageStatus,
  solidSwatch,
  toggleEnabledBook,
  toggleSiteRule,
  type StatusText,
  type SyncChannel,
  type WordRow,
} from './model';
import { usePopupData } from './usePopupData';
import { createSyncAllRunner, syncAllOpenState } from './syncAllRunner';
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

/** “本页生词”角标：读不到本页（未授权 / 内置页 / 未注入 / 关闭）时显示“—”，不显示成“0 个生词” */
const pageCountLabel = computed(() =>
  pageStatus.value === 'active' ? String(data.pageLemmas.value.length) : '—',
);

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
const currentPreset = computed(() => presetChips.value.find((c) => c.id === settings.value?.style.themeId) ?? presetChips.value[0]);
/**
 * 外观卡片默认收成一行（“样式 · 琥珀 ›” + 行内释义开关），把首屏让给本页生词；展开后显示全部预设与释义显示方式。
 * 展开状态是本机界面偏好，记在 localStorage。
 */
const LOOK_OPEN_KEY = 'hnw:popup:lookOpen';
const lookOpen = ref(readLocal(LOOK_OPEN_KEY) === '1');
watch(lookOpen, (v) => writeLocal(LOOK_OPEN_KEY, v ? '1' : '0'));

function choosePreset(id: string) {
  if (!settings.value || settings.value.style.themeId === id) return;
  applyPreset(settings.value, id);
}

// ---------------- 行内释义 ----------------

/** 开启时的显示方式（“关闭”由开关负责），需覆盖 InlineTranslationMode 的全部开启值，否则会把用户的选择显示错/恢复丢 */
const inlineShowOptions: { value: Exclude<InlineTranslationMode, 'off'>; label: string }[] = [
  { value: 'after', label: '词后' },
  { value: 'ruby', label: '词上方' },
  { value: 'hover', label: '仅悬停' },
];
type InlineShowMode = (typeof inlineShowOptions)[number]['value'];


/** 行内释义快速开关：关闭时记住当前方式，再打开时恢复 */
const inlineOn = computed({
  get: () => !!settings.value && settings.value.inlineTranslation.mode !== 'off',
  set: (on: boolean) => {
    const s = settings.value;
    if (!s || on === (s.inlineTranslation.mode !== 'off')) return;
    s.inlineTranslation.mode = nextInlineMode(
      s.inlineTranslation.mode,
      readLocal(LAST_INLINE_MODE_KEY),
      inlineShowOptions.map((o) => o.value),
    );
  },
});
const inlineShowMode = computed<InlineShowMode>({
  get: () => {
    const m = settings.value?.inlineTranslation.mode;
    // 关闭时分段控件不显示，这里的回退值只是占位
    return inlineShowOptions.some((o) => o.value === m) ? (m as InlineShowMode) : 'after';
  },
  set: (m) => {
    if (settings.value) settings.value.inlineTranslation.mode = m;
  },
});
/** 折叠行里显示的当前方式名 */
const inlineModeLabel = computed(() => inlineShowOptions.find((o) => o.value === settings.value?.inlineTranslation.mode)?.label ?? '');
// 记住最近一次开启的方式（本机界面偏好，不同步）
watch(
  () => settings.value?.inlineTranslation.mode,
  (m) => {
    if (m && m !== 'off') writeLocal(LAST_INLINE_MODE_KEY, m);
  },
);

// ---------------- 单词列表 ----------------

type Tab = 'page' | 'known';
const tab = ref<Tab>('page');
const query = ref('');
/**
 * 列表折叠 / 展开（桌面与触屏同一套文案“查看全部 N 个”）：
 * - 桌面折叠时在卡片内滚动（约 5 行高，最多渲染 60 行）；触屏整页随页面滚动，折叠时只渲染前 12 行，避免同步卡片被挤到几十行之后
 * - 展开后取消高度限制，一次最多渲染 300 行，更多时“继续显示”
 */
const COLLAPSED_ROWS = touchUi ? 12 : 60;
const COLLAPSED_VISIBLE = touchUi ? 12 : 5;
const EXPANDED_CHUNK = 300;
const listExpanded = ref(false);
const limit = ref(COLLAPSED_ROWS);
watch([tab, query, listExpanded], () => (limit.value = listExpanded.value ? EXPANDED_CHUNK : COLLAPSED_ROWS));

/** 筛选框：默认收起成图标 */
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement>();
async function openSearch() {
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
}
function closeSearch() {
  query.value = '';
  searchOpen.value = false;
}

const knownList = computed(() => recentKnownWords(data.known.value, 200).map((k) => k.word));
const knownTotal = computed(() => Object.keys(data.known.value.words).length);
/** 本页不在高亮（未授权 / 关闭 / 未注入）时不列旧数据，与角标“—”和空态说明一致 */
const sourceWords = computed(() =>
  tab.value === 'page' ? (pageStatus.value === 'active' ? data.pageLemmas.value : []) : knownList.value,
);
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
    // 离线时只写进了本地（来源生词本与跨设备同步要等联网），不报“收藏成功”
    const text = online.value ? res.message || `已收藏 ${word}` : `已存本地，联网后同步：${word}`;
    showToast(text, { label: '撤销', run: () => void sendToBackground('removeWord', { lemma: word }).catch(() => undefined) });
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
  if (summary) return friendlyChannels(channelsFromStatusItems(summary.items));
  if (!settings.value) return [];
  return friendlyChannels(buildSyncChannels({
    books: books.value,
    sources: settings.value.sources,
    providers: SOURCE_PROVIDER_INFOS,
    storageSync: data.syncStatus.value,
    webdav: data.webdavStatus.value,
  }));
});
const syncOverall = computed<StatusText>(() => {
  const st = overallSyncStatus(syncChannels.value);
  const last = data.statusSummary.value?.lastSyncAt;
  // 带上最近同步时间（“2 项同步正常 · 3 小时前”“等待自动同步 · 上次 3 小时前”），底栏一行就能看出是否在工作
  if (!last || st.tone === 'error' || st.tone === 'warn') return st;
  return { ...st, text: `${st.text} · ${st.tone === 'ok' ? '' : '上次 '}${formatAgo(last)}` };
});
/** 需要用户处理的第一项（出错优先，其次未登录等）：底栏同步行与同步面板的主操作直接给它的修复动作 */
const syncFix = computed(() => primaryFixChannel(syncChannels.value));
/** 同步状态底部面板：底栏同步行 / 告警条“N 项需处理”就地弹出 */
const syncSheetOpen = ref(false);

// ---------------- 顶部状态位（离线 / 同步出错） ----------------

const online = ref(navigator.onLine);
const onOnline = () => {
  online.value = true;
  data.refreshSummary(0);
};
const onOffline = () => (online.value = false);
addEventListener('online', onOnline);
addEventListener('offline', onOffline);
/** “稍后提醒”记录（同一条告警 24 小时内不再占位，出现新错误时立即显示） */
const alertSnooze = ref<{ text: string; at: number } | null>(parseSnooze(readLocal(ALERT_SNOOZE_KEY)));
function parseSnooze(raw: string | null): { text: string; at: number } | null {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const statusAlert = computed(() => {
  const a = resolveStatusAlert({ online: online.value, channels: syncChannels.value });
  return a && !isAlertSnoozed(a, alertSnooze.value) ? a : undefined;
});
function runAlertAction() {
  const a = statusAlert.value?.action;
  if (!a) return;
  if (a.sheet) syncSheetOpen.value = true;
  else openOptions(a.route);
}
function snoozeAlert() {
  if (!statusAlert.value) return;
  alertSnooze.value = { text: statusAlert.value.text, at: Date.now() };
  writeLocal(ALERT_SNOOZE_KEY, JSON.stringify(alertSnooze.value));
  showToast('已收起，24 小时内不再提示；底部同步状态中仍可查看');
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

/**
 * 全部同步：后台受理（syncAll background=true）后立即返回，popup 按约 1.5 秒轮询 getStatusSummary().syncAll，
 * 完成后 toast 显示后台汇总文案；开启欧路时整轮可能要 1 分多钟，期间关闭 popup 不影响后台同步。
 * 后台不支持 syncAll（旧版本）时退回逐个同步。流程细节见 syncAllRunner。
 */
const syncAllRunner = createSyncAllRunner({
  requestSyncAll: (d) => sendToBackground('syncAll', d),
  getSummary: () => sendToBackground('getStatusSummary', {}),
  onSummary: (s) => (data.statusSummary.value = s),
  onRunningChange: (on) => setSyncing('all', on),
  onDone: (message, ok) => {
    showToast(message || (ok ? '已全部同步' : '部分同步失败'));
    data.refreshSummary(0);
  },
  fallback: async () => {
    for (const c of syncChannels.value) await syncChannel(c);
  },
});
function syncAll() {
  void syncAllRunner.start();
}
// popup 打开后首次拿到总状态：后台仍在“全部同步”则接着显示进行中并轮询；刚完成不久则提示上次结果
const stopWatchSyncAllOnOpen = watch(
  () => data.statusSummary.value,
  (summary) => {
    if (!summary) return;
    stopWatchSyncAllOnOpen();
    const st = syncAllOpenState(summary.syncAll, Date.now());
    if (st?.kind === 'running') syncAllRunner.resume(summary);
    else if (st?.kind === 'recent') showToast(st.text);
  },
);

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

// ---------------- 本机界面偏好 ----------------

/** localStorage 读写：隐私模式等不可用时读为 null、写入忽略（只影响记住界面偏好） */
function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略 */
  }
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
  // 只停 popup 侧轮询，后台同步继续
  syncAllRunner.stop();
});
</script>

<template>
  <main v-if="settings" class="popup" :class="{ touch: touchUi }">
    <header class="top">
      <div class="top-row">
        <img class="logo" src="/icons/48.png" alt="" width="28" height="28" />
        <strong class="brand">生词高亮</strong>
        <span class="spacer" />
        <!-- 总开关带文字，与本站卡片里的“本站”开关区分；设置入口只保留在底栏，顶栏不重复。
             未授权访问网站时保持原样（置灰会被误读成“扩展被关了”），“不可用”只在本站卡片上说明 -->
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
        <button v-if="statusAlert.dismissible" type="button" class="al-x" title="稍后提醒（24 小时内不再显示）" aria-label="稍后提醒" @click="snoozeAlert">
          <PopupIcon name="close" :size="14" />
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

      <!-- 词书：一行（标题 + 已启用词书芯片 + 切换），把首屏留给本页生词 -->
      <section class="card row-card books">
        <h2 :title="enabledMetas.length ? `共 ${formatCount(enabledWordTotal)} 词，可多本组合` : undefined">词书</h2>
        <div v-if="enabledMetas.length" class="chips">
          <button v-for="b in enabledMetas" :key="b.id" type="button" class="chip" @click="pickerOpen = true">
            <MarkPreview :mark="markOf(b.id)" word="Aa" />
            <span class="chip-name">{{ b.short || b.name }}</span>
          </button>
        </div>
        <span v-else class="sub grow">未启用任何词书</span>
        <button type="button" class="link as-link" :class="{ strong: !enabledMetas.length }" @click="pickerOpen = true">
          {{ enabledMetas.length ? '切换' : '选择' }}<PopupIcon name="chevron" :size="16" />
        </button>
      </section>

      <!-- 样式与行内释义：默认一行（当前预设 + 释义开关），展开后选预设与释义显示方式 -->
      <section class="card look" :class="{ open: lookOpen }">
        <div class="look-row">
          <button type="button" class="look-toggle" :aria-expanded="lookOpen" aria-controls="look-panel" @click="lookOpen = !lookOpen">
            <h2>样式</h2>
            <span v-if="currentPreset" class="look-current">
              <span class="preset-sample mini"><MarkPreview :mark="currentPreset.mark" word="Word" /></span>
              <span class="look-name">{{ currentPreset.name }}</span>
            </span>
            <PopupIcon name="chevron" :size="16" class="caret" />
          </button>
          <span class="divider" aria-hidden="true" />
          <span class="inline-quick" title="在生词旁显示简短中文释义">
            <span class="inline-title">释义</span>
            <span v-if="inlineOn" class="inline-mode">{{ inlineModeLabel }}</span>
          </span>
          <ToggleSwitch v-model="inlineOn" class="inline-toggle" aria-label="行内释义" />
        </div>
        <div v-if="lookOpen" id="look-panel" class="look-panel">
          <div class="presets" role="radiogroup" aria-label="高亮样式预设">
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
          <div class="inline-row">
            <span class="inline-label">行内释义</span>
            <SegmentedControl v-if="inlineOn" v-model="inlineShowMode" class="seg" :options="inlineShowOptions" />
            <span v-else class="sub grow">已关闭：只高亮，点按或悬停看释义</span>
          </div>
          <button type="button" class="link as-link more-look" @click="openOptions(OPTIONS_ROUTES.appearance)">
            调整颜色与字号<PopupIcon name="chevron" :size="16" />
          </button>
        </div>
      </section>

      <!-- 本页生词 / 熟词本 -->
      <section class="card words">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="tab === 'page'" :class="{ on: tab === 'page' }" @click="tab = 'page'">
            <!-- 无法读取本页（未授权 / 内置页 / 未注入）时显示“—”，避免“0”被理解成“本页没有生词” -->
            本页生词<span class="count" :class="{ na: pageStatus !== 'active' }">{{ pageCountLabel }}</span>
          </button>
          <button type="button" role="tab" :aria-selected="tab === 'known'" :class="{ on: tab === 'known' }" @click="tab = 'known'">
            熟词本<span class="count">{{ knownTotal }}</span>
          </button>
          <span class="spacer" />
          <!-- 筛选默认收成标签栏右侧的图标，点开才占一行，首屏多露出一行生词 -->
          <button
            v-if="sourceWords.length > 8 && !searchOpen"
            type="button"
            class="tab-search"
            :aria-label="tab === 'page' ? '筛选本页生词' : '筛选最近的熟词'"
            title="筛选"
            @click="openSearch"
          >
            <PopupIcon name="search" :size="17" />
          </button>
        </div>
        <label v-if="searchOpen" class="search">
          <PopupIcon name="search" :size="16" />
          <input ref="searchInput" v-model="query" type="search" :placeholder="tab === 'page' ? '筛选本页生词' : '筛选最近的熟词'" @keydown.esc.stop="closeSearch" />
          <button type="button" class="search-x" aria-label="关闭筛选" @click="closeSearch"><PopupIcon name="close" :size="15" /></button>
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
            <!-- 授权的唯一主按钮在本站卡片上，这里只说明 -->
            <template v-else-if="pageStatus === 'no-access'">授权后显示本页生词</template>
            <template v-else>{{ pageStatusText.text }}</template>
          </div>
          <button v-if="listExpanded && filtered.length > limit" type="button" class="more" @click="limit += EXPANDED_CHUNK">
            继续显示（还有 {{ filtered.length - limit }} 个）
          </button>
          <p v-if="tab === 'known' && knownTotal > knownList.length && !query" class="foot-note">
            仅显示最近 {{ knownList.length }} 个，<a href="#" @click.prevent="openOptions(OPTIONS_ROUTES.known)">管理全部熟词</a>
          </p>
        </div>
        <!-- 列表折叠时（桌面卡片内滚动约 5 行 / 触屏前 12 行）给出明确的“查看全部”入口，两端文案一致 -->
        <button v-if="!listExpanded && filtered.length > COLLAPSED_VISIBLE" type="button" class="more see-all" @click="listExpanded = true">
          查看全部 {{ filtered.length }} 个<PopupIcon name="chevron" :size="14" class="down" />
        </button>
      </section>
    </div>

    <footer class="bottom">
      <!-- 总同步状态：一行固定在底栏（手机首屏也能看到“上次同步时间”），点开就地弹出各项详情；
           有需要处理的项时右侧直接给第一项的修复动作，否则是“全部同步” -->
      <div class="syncbar" :class="`sync-${syncOverall.tone}`">
        <button
          type="button"
          class="syncbar-main"
          :aria-label="`同步状态：${syncOverall.text}，查看详情`"
          @click="syncChannels.length ? (syncSheetOpen = true) : openOptions(OPTIONS_ROUTES.sources)"
        >
          <PopupIcon name="cloud" :size="15" class="syncbar-ic" />
          <span class="sync-overall" :class="`tone-${syncOverall.tone}`"><i class="dot" />{{ syncOverall.text }}</span>
          <PopupIcon name="chevron" :size="14" class="caret" />
        </button>
        <button v-if="syncFix" type="button" class="btn small fix" @click="openOptions(syncFix.route)">
          {{ syncFixVerb(syncFix) }}<PopupIcon name="chevron" :size="14" />
        </button>
        <button
          v-else-if="syncChannels.length"
          type="button"
          class="btn small ghost"
          :disabled="syncBusy('all')"
          :aria-label="syncChannels.length > 1 ? '全部同步' : '立即同步'"
          @click="syncAll"
        >
          <PopupIcon name="refresh" :size="14" :class="{ spin: syncBusy('all') }" />{{ syncChannels.length > 1 ? '全部同步' : '同步' }}
        </button>
        <button v-else type="button" class="btn small ghost" @click="openOptions(OPTIONS_ROUTES.sources)">去设置</button>
      </div>
      <div class="bottom-actions">
        <button type="button" class="btn" @click="openOptions(OPTIONS_ROUTES.importBooks)">导入词书</button>
        <!-- 次要样式：主操作（授权 / 启用词书）才用实心主色，避免与之抢视线 -->
        <button type="button" class="btn" @click="openOptions()">
          <PopupIcon name="settings" :size="16" />全部设置
        </button>
      </div>
    </footer>

    <BottomSheet v-model="pickerOpen" title="切换词书" subtitle="可多选组合；先启用的词书优先决定高亮颜色">
      <BookPicker :books="books" :enabled="settings.books.enabled" :mark-of="markOf" @toggle="toggleBook" />
      <template #footer>
        <button type="button" class="btn" @click="openOptions(OPTIONS_ROUTES.books)">管理与排序</button>
        <button type="button" class="btn primary" @click="pickerOpen = false">完成</button>
      </template>
    </BottomSheet>

    <!-- 同步状态面板：告警条“N 项需处理”与底栏同步行就地打开 -->
    <BottomSheet v-model="syncSheetOpen" title="同步状态" :subtitle="syncOverall.text">
      <SyncList :channels="syncChannels" :is-busy="syncBusy" @sync="syncChannel" @fix="(c) => openOptions(c.route)" />
      <template #footer>
        <!-- 有出错项时“全部同步”大概率再次失败：降为次要，主按钮换成第一项的修复动作 -->
        <button v-if="syncChannels.length > 1" type="button" class="btn" :class="{ primary: !syncFix }" :disabled="syncBusy('all')" @click="syncAll">
          <PopupIcon name="refresh" :size="16" :class="{ spin: syncBusy('all') }" />全部同步
        </button>
        <button v-else type="button" class="btn" @click="openOptions(OPTIONS_ROUTES.sync)">同步设置</button>
        <button v-if="syncFix" type="button" class="btn primary" @click="openOptions(syncFix.route)">
          {{ syncFixVerb(syncFix) }}：{{ syncFix.label }}
        </button>
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
  display: flex; align-items: center; gap: 6px; min-height: 33px; padding: 3px 12px; font-size: 12.5px;
  border-top: 1px solid var(--border);
}
.status-alert.al-error { background: var(--danger-soft); color: var(--danger); }
.status-alert.al-warn { background: color-mix(in srgb, var(--warn) 14%, var(--surface)); color: var(--warn); }
.al-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.al-act {
  flex: none; display: inline-flex; align-items: center; gap: 2px; min-height: 28px; padding: 0 8px; border-radius: 8px;
  border: 1px solid currentColor; background: var(--surface); color: inherit; font-weight: 650; font-size: 12.5px; cursor: pointer;
}
.al-x {
  flex: none; display: grid; place-items: center; width: 28px; height: 28px; margin-right: -4px; border: 0; border-radius: 8px;
  background: none; color: inherit; opacity: .75; cursor: pointer;
}
.al-x:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
.logo { border-radius: 7px; }
.brand { font-size: 15.5px; font-weight: 700; letter-spacing: .02em; }
.spacer { flex: 1; }
.master { min-height: 0; }
.icon-btn {
  display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  border: 0; background: transparent; color: var(--text-2); cursor: pointer;
}
.icon-btn:hover { background: var(--surface-2); color: var(--text); }

.content { display: flex; flex-direction: column; gap: 8px; padding: 8px 12px 10px; }
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
/* 一行卡片：标题 + 内容 + 右侧入口 */
.row-card { flex-direction: row; align-items: center; gap: 10px; padding-top: 8px; padding-bottom: 8px; }
.row-card h2 { flex: none; }
.grow { flex: 1; min-width: 0; }
.chips {
  flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none;
  mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent);
}
.link.strong { font-weight: 700; }
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

/* 样式与行内释义：折叠时一行 */
.look { padding-top: 6px; padding-bottom: 6px; }
.look-row { display: flex; align-items: center; gap: 8px; min-height: 36px; }
.look-toggle {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none;
  color: inherit; cursor: pointer; text-align: left; min-height: 36px;
}
.look-current { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.look-name { font-size: 13px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.look-toggle h2 { flex: none; white-space: nowrap; }
.look-toggle .caret { flex: none; color: var(--text-2); transition: transform .15s; }
.look.open .look-toggle .caret { transform: rotate(90deg); }
.divider { width: 1px; align-self: stretch; margin: 6px 2px; background: var(--border); flex: none; }
.inline-quick { display: inline-flex; align-items: baseline; gap: 5px; flex: none; }
.inline-title { font-weight: 650; font-size: 13.5px; }
.inline-mode { font-size: 12px; color: var(--accent); font-weight: 600; }
.inline-toggle { min-height: 0; flex: none; }
.as-link { border: 0; background: none; padding: 2px 0; cursor: pointer; }
.look-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px 0 4px; border-top: 1px solid var(--border); margin-top: 4px; }
/* 预设平铺成网格（不横向滚动，不会裁掉半张） */
.presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 6px; }
.preset {
  min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px 5px;
  border-radius: 10px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; color: var(--text);
}
.preset:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.preset[aria-checked='true'] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft); }
/* 样例词用固定的正文色与背景，与网页上看到的效果接近 */
.preset-sample { font-size: 13.5px; line-height: 1.6; font-family: Georgia, 'Times New Roman', serif; color: var(--text); white-space: nowrap; }
.preset-sample.mini { font-size: 13px; line-height: 1.4; }
.preset-name { font-size: 11px; color: var(--text-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset[aria-checked='true'] .preset-name { color: var(--accent); font-weight: 650; }
.inline-row { display: flex; align-items: center; gap: 10px; min-height: 40px; }
.inline-label { font-weight: 650; font-size: 13px; flex: none; }
.inline-row .seg { flex: 1; }
.more-look { align-self: flex-start; font-size: 12.5px; }

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
.tabs button.on .count.na { background: var(--surface-2); color: var(--text-2); }
.search {
  display: flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text-2);
}
.tabs .tab-search {
  display: grid; place-items: center; width: 34px; height: 34px; align-self: center; border: 0; border-radius: 9px;
  background: none; color: var(--text-2); cursor: pointer;
}
.tabs .tab-search:hover { background: var(--surface-2); color: var(--text); }
.search-x { display: grid; place-items: center; width: 30px; height: 30px; border: 0; background: none; color: var(--text-2); cursor: pointer; flex: none; }
.search input { flex: 1; min-width: 0; border: 0; background: transparent; min-height: 34px; padding: 0; outline: none; color: var(--text); }
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

/* 底栏同步行：一行总状态（含上次同步时间）+ 修复动作 / 全部同步 */
.syncbar { display: flex; align-items: center; gap: 6px; min-height: 32px; }
.syncbar-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 6px; margin-left: -6px;
  border: 0; border-radius: 8px; background: none; color: inherit; cursor: pointer; text-align: left;
}
.syncbar-main:hover { background: var(--surface-2); }
.syncbar-ic { flex: none; color: var(--text-2); }
.syncbar-main .caret { flex: none; color: var(--text-2); }
/* 块级 + 省略号：窄屏长文案截断而不是换行撑高底栏 */
.sync-overall { display: block; min-width: 0; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sync-overall .dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; vertical-align: 1px; border-radius: 50%; background: currentColor; }
.sync-ok .sync-overall, .sync-muted .sync-overall { font-weight: 500; }
.btn.ghost { border-color: transparent; background: none; color: var(--text-2); }
.btn.ghost:hover { background: var(--surface-2); color: var(--text); }
.btn.fix { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); font-weight: 650; gap: 0; }
.sync-warn .btn.fix { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 50%, var(--border)); }
.btn.small { min-height: 30px; padding: 3px 10px; font-size: 12.5px; gap: 4px; flex: none; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 底栏 */
.bottom {
  position: sticky; bottom: 0; z-index: 5; display: flex; flex-direction: column; gap: 6px; padding: 6px 12px 10px;
  background: var(--surface); border-top: 1px solid var(--border);
}
.bottom-actions { display: flex; gap: 8px; }
.bottom-actions .btn { flex: 1; }

.detail-word { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .01em; word-break: break-word; }

/* 提示条 */
.toast {
  position: fixed; left: 12px; right: 12px; bottom: 100px; z-index: 30; display: flex; align-items: center; gap: 10px;
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
.touch .tabs .tab-search { width: 44px; height: 44px; min-height: 0; margin-right: -10px; }
.touch .search-x { width: 40px; height: 40px; }
.touch .row-card { padding-top: 6px; padding-bottom: 6px; }
.touch .chip { min-height: 38px; font-size: 13.5px; }
.touch .look { padding-top: 4px; padding-bottom: 4px; }
.touch .look-row, .touch .look-toggle { min-height: 48px; }
.touch .look-name { font-size: 14px; }
.touch .al-x { width: 40px; height: 40px; }
.touch :deep(.sync-main) { min-height: 54px; }
/* 子组件的触屏尺寸（其自身用 pointer: coarse，这里按 touchUi 兜底） */
.touch :deep(.list .main) { min-height: 52px; }
.touch :deep(.list .act) { width: 46px; height: 46px; }
.touch :deep(.list .act.say) { width: 40px; }
.touch :deep(.seg button) { min-height: 40px; }
.touch :deep(.icon-btn) { width: 44px; height: 44px; }
.touch :deep(.speak) { min-height: 40px; }
.touch .list-wrap { max-height: none; overflow: visible; }
/* 触屏整页：本页生词放在同步之前（首屏能看到单词）；同步出错由顶部状态位提示 */
.touch .presets { grid-template-columns: repeat(auto-fill, minmax(68px, 1fr)); gap: 8px; }
.touch .preset { padding: 8px 4px 7px; }
.touch .preset-sample { font-size: 15px; }
.touch .preset-name { font-size: 12px; }
.touch .as-link { min-height: 44px; }
.touch .inline-row { min-height: 48px; }
.touch .inline-title { font-size: 14.5px; }
.touch .grant { min-height: 44px; font-size: 15px; }
.touch .access-note { font-size: 13px; }
.touch .update .x { width: 40px; height: 40px; }
.touch .link-btn { min-height: 40px; }
.touch .search input { min-height: 42px; font-size: 15px; }
.touch .syncbar, .touch .syncbar-main { min-height: 44px; }
.touch .sync-overall { font-size: 13.5px; }
.touch .btn.small { min-height: 38px; padding: 4px 12px; font-size: 13px; }
.touch .bottom { padding: 4px 12px 10px; padding-bottom: max(10px, env(safe-area-inset-bottom)); gap: 4px; }
.touch .bottom-actions .btn { min-height: 46px; font-size: 15px; }
.touch .toast { bottom: calc(126px + env(safe-area-inset-bottom)); }
</style>
