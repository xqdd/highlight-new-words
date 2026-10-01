<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import type { BookId, InlineTranslationMode } from '@/core/settings/schema';
import { isSiteDisabled } from '@/core/settings/store';
import { getProviderInfo } from '@/core/source/providers';
import { resolveMarkStyle } from '@/core/theme/resolve';
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
  OPTIONS_ROUTES,
  filterWords,
  formatCount,
  oneLineMeaning,
  recentKnownWords,
  resolvePageStatus,
  solidSwatch,
  summarizeCloudSync,
  summarizeSourceSync,
  toggleEnabledBook,
  toggleSiteRule,
  type StatusText,
  type WordRow,
} from './model';
import { usePopupData } from './usePopupData';

/**
 * 弹出页：总开关 / 本站开关、启用词书摘要与快速切换、行内释义模式、本页生词与熟词本列表（详情 / 标为熟词 / 撤销）、
 * 来源生词本与跨设备同步状态、进入设置。
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

// ---------------- 页面状态 ----------------

const siteDisabled = computed(() => !!settings.value && !!data.hostname.value && isSiteDisabled(settings.value, data.hostname.value));
const pageStatus = computed(() =>
  resolvePageStatus({
    loaded: data.loaded.value && !!settings.value,
    url: data.url.value,
    contentReady: data.contentReady.value,
    enabled: !!settings.value?.enabled,
    siteDisabled: siteDisabled.value,
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
  const n = data.pageLemmas.value.length;
  switch (pageStatus.value) {
    case 'loading':
      return { text: '读取页面…', tone: 'muted' };
    case 'unsupported':
      return { text: '浏览器内置页面无法高亮', tone: 'muted' };
    case 'paused':
      return { text: '高亮已全局暂停', tone: 'warn' };
    case 'site-off':
      return { text: '已在此网站关闭高亮', tone: 'muted' };
    case 'not-injected':
      return { text: '刷新页面后开始高亮', tone: 'warn' };
    default:
      return { text: n ? `正在高亮 · 本页 ${n} 个生词` : '正在高亮 · 本页暂无生词', tone: 'ok' };
  }
});

function reloadPage() {
  if (data.tabId.value === undefined) return;
  void browser.tabs.reload(data.tabId.value);
  window.close();
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

// ---------------- 行内释义 ----------------

const inlineOptions: { value: InlineTranslationMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'after', label: '词后' },
  { value: 'ruby', label: '词上方' },
];

// ---------------- 单词列表 ----------------

type Tab = 'page' | 'known';
const tab = ref<Tab>('page');
const query = ref('');
/** 首屏最多渲染的行数，避免几百个词时一次渲染过多 DOM */
const PAGE_SIZE = 60;
const limit = ref(PAGE_SIZE);
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
    const removed = res.deleted.reduce((n, r) => n + r.deleted.length, 0);
    showToast(`已将 ${word} 标为熟词${removed ? `，并从生词本删除 ${removed} 个词形` : ''}`, {
      label: '撤销',
      run: () => void unmarkKnown(word),
    });
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
}

function speak() {
  void sendToBackground('tts', { text: detailWord.value, force: true });
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

const sourceSync = computed(() => summarizeSourceSync(books.value));
const hasSources = computed(() => books.value.some((b) => b.kind === 'source'));
const cloudSync = computed(() => summarizeCloudSync(!!settings.value?.sync.enabled, data.syncStatus.value));
const syncingSources = ref(false);
const syncingCloud = ref(false);

/** 同步全部已启用来源下的生词本（各本独立，结果汇总提示） */
async function syncSources() {
  syncingSources.value = true;
  try {
    const results = await sendToBackground('syncSourceBooks', {});
    const ok = results.filter((r) => r.ok);
    const failed = results.find((r) => !r.ok);
    showToast(
      results.length === 0
        ? '没有已启用的云端生词本'
        : `${ok.length}/${results.length} 本同步成功，共 ${ok.reduce((n, r) => n + (r.count ?? 0), 0)} 词${failed ? `；${failed.message}` : ''}`,
    );
  } catch (e) {
    showToast(`同步失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    syncingSources.value = false;
  }
}

async function syncCloud() {
  syncingCloud.value = true;
  try {
    data.syncStatus.value = await sendToBackground('syncNow', {});
  } catch (e) {
    showToast(`同步失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    syncingCloud.value = false;
  }
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
  clearTimeout(toastTimer);
  clearTimeout(confirmTimer);
});
</script>

<template>
  <main v-if="settings" class="popup" :class="{ touch: touchUi }">
    <header class="top">
      <img class="logo" src="/icons/48.png" alt="" width="28" height="28" />
      <strong class="brand">生词高亮</strong>
      <span class="spacer" />
      <button type="button" class="icon-btn" title="全部设置" aria-label="全部设置" @click="openOptions()">
        <PopupIcon name="settings" />
      </button>
      <ToggleSwitch v-model="settings.enabled" class="master" aria-label="总开关：在所有网站高亮生词" />
    </header>

    <div class="content">
      <!-- 本站 -->
      <section class="card site" :class="`st-${pageStatus}`">
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
          <ToggleSwitch
            v-if="data.hostname.value && pageStatus !== 'unsupported'"
            v-model="siteEnabled"
            :aria-label="`在 ${data.hostname.value} 上高亮`"
            :title="siteEnabled ? '在此网站关闭高亮' : '在此网站开启高亮'"
          />
        </div>
        <div v-if="pageStatus === 'paused'" class="hint">
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
              {{ enabledMetas.length ? `已启用 ${enabledMetas.length} 本 · 共 ${formatCount(enabledWordTotal)} 词` : '未启用任何词书' }}
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

      <!-- 行内释义 -->
      <section class="card inline">
        <span class="head-text" title="在生词旁显示简短中文释义">
          <h2>行内释义</h2>
        </span>
        <SegmentedControl v-model="settings.inlineTranslation.mode" class="seg" :options="inlineOptions" />
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

        <div class="list-wrap">
          <WordList
            v-if="rows.length"
            :rows="rows"
            :action="tab === 'page' ? 'known' : 'undo'"
            :busy="busy"
            @open="openDetail"
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
      </section>

      <!-- 同步 -->
      <section class="card sync">
        <div class="sync-row">
          <PopupIcon name="book" class="sync-ic" />
          <span class="sync-text" :class="`tone-${sourceSync.tone}`">{{ sourceSync.text }}</span>
          <button v-if="hasSources" type="button" class="btn small" :disabled="syncingSources" @click="syncSources">
            <PopupIcon name="refresh" :size="14" :class="{ spin: syncingSources }" />{{ syncingSources ? '同步中' : '同步' }}
          </button>
          <button v-else type="button" class="btn small" @click="openOptions(OPTIONS_ROUTES.sources)">连接</button>
        </div>
        <div class="sync-row">
          <PopupIcon name="cloud" class="sync-ic" />
          <span class="sync-text" :class="`tone-${cloudSync.tone}`">{{ cloudSync.text }}</span>
          <button v-if="settings.sync.enabled" type="button" class="btn small" :disabled="syncingCloud" @click="syncCloud">
            <PopupIcon name="refresh" :size="14" :class="{ spin: syncingCloud }" />{{ syncingCloud ? '同步中' : '同步' }}
          </button>
          <button v-else type="button" class="btn small" @click="openOptions(OPTIONS_ROUTES.sync)">开启</button>
        </div>
      </section>
    </div>

    <footer class="bottom">
      <button type="button" class="btn" @click="openOptions(OPTIONS_ROUTES.importBooks)">导入词书</button>
      <button type="button" class="btn primary" @click="openOptions()">
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
.top {
  position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px;
  padding: 10px 12px 10px 14px; background: var(--surface); border-bottom: 1px solid var(--border);
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

.tone-ok { color: #15803d; }
.tone-warn { color: #b45309; }
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

/* 行内释义：标题与分段控件同行，窄屏换行 */
.inline { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.inline .head-text { flex: 1 1 80px; }
.inline .seg { flex: 1 1 200px; }

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
.empty { padding: 18px 8px; text-align: center; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.inline-icon { display: inline-block; vertical-align: -2px; }
.more { width: 100%; min-height: 36px; border: 0; background: none; color: var(--accent); cursor: pointer; font-weight: 600; font-size: 13px; }
.foot-note { margin: 4px 0 6px; text-align: center; font-size: 12px; color: var(--text-2); }

/* 同步 */
.sync { gap: 6px; }
.sync-row { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.sync-ic { color: var(--text-2); }
.sync-text { flex: 1; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn.small { min-height: 30px; padding: 3px 10px; font-size: 12.5px; gap: 4px; flex: none; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 底栏 */
.bottom {
  position: sticky; bottom: 0; z-index: 5; display: flex; gap: 8px; padding: 10px 12px;
  background: var(--surface); border-top: 1px solid var(--border);
}
.bottom .btn { flex: 1; }
.bottom .btn.primary { flex: 1.4; }

.detail-word { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .01em; word-break: break-word; }

/* 提示条 */
.toast {
  position: fixed; left: 12px; right: 12px; bottom: 68px; z-index: 30; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 10px 14px; border-radius: 12px; background: #1f2328; color: #fff; font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
}
.toast span { flex: 1; }
.toast button { flex: none; border: 0; background: none; color: #fbbf24; font-weight: 700; cursor: pointer; min-height: 32px; padding: 0 6px; }
.toast-enter-active, .toast-leave-active { transition: opacity .18s, transform .18s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }

@media (prefers-color-scheme: dark) {
  .tone-ok { color: #4ade80; }
  .tone-warn { color: #fbbf24; }
  .toast { background: #e8eaed; color: #111317; }
  .toast button { color: #b45309; }
}

/*
 * 触屏（Edge Android 中 popup 以整页 / 底部抽屉打开，见 touchUi）：占满宽高，列表随页面滚动，底栏吸附在底部，点击区 ≥ 44px。
 */
.popup.touch { --tap: 44px; width: 100%; min-height: 100vh; min-height: 100dvh; }
.touch .top { padding: 8px 8px 8px 16px; padding-top: max(8px, env(safe-area-inset-top)); }
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
.touch :deep(.seg button) { min-height: 40px; }
.touch :deep(.icon-btn) { width: 44px; height: 44px; }
.touch :deep(.speak) { min-height: 40px; }
.touch .list-wrap { max-height: none; overflow: visible; }
/* 整页时单词列表很长：同步状态挪到列表之前，避免被几百行单词挤到最底部 */
.touch .sync { order: 1; }
.touch .words { order: 2; }
.touch .search input { min-height: 42px; font-size: 15px; }
.touch .sync { padding-top: 6px; padding-bottom: 6px; gap: 0; }
.touch .sync-row { min-height: 46px; }
.touch .sync-row + .sync-row { border-top: 1px solid var(--border); }
.touch .btn.small { min-height: 38px; padding: 4px 12px; font-size: 13px; }
.touch .bottom { padding: 10px 12px; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
.touch .bottom .btn { min-height: 46px; font-size: 15px; }
.touch .toast { bottom: calc(80px + env(safe-area-inset-bottom)); }
</style>
