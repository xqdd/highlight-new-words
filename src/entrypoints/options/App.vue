<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect, type Ref } from 'vue';
import type { Settings } from '@/core/settings/schema';
import AppIcon, { type IconName } from '@/ui/components/AppIcon.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useBooks } from '@/ui/composables/useBooks';
import { useSettings } from '@/ui/composables/useSettings';
import { provideOptions } from './lib/context';
import { dismissToast, toast } from './lib/toast';
import ReleaseNotesSheet from './components/ReleaseNotesSheet.vue';
import SiteAccessBanner from './components/SiteAccessBanner.vue';
import { shouldShowReleaseNotes } from './lib/release-notes';
import AppearancePage from './pages/AppearancePage.vue';
import BooksPage from './pages/BooksPage.vue';
import KnownPage from './pages/KnownPage.vue';
import MorePage from './pages/MorePage.vue';
import SourcesPage from './pages/SourcesPage.vue';
import SyncPage from './pages/SyncPage.vue';
import WelcomeGuide from './pages/WelcomeGuide.vue';

/**
 * 选项页外壳：分组导航 + hash 路由（#books / #appearance / #sources / #known / #sync / #more / #welcome）。
 * - 桌面（≥900px）：左侧导航栏 + 右侧内容
 * - 手机：顶部标题栏 + 底部 Tab 导航（对标 Relingo 移动端设置），内容区单列
 * - #welcome 为首次使用引导（全屏，无导航）；background 安装时可打开 options.html#welcome
 * hash 可带页内锚点：#appearance/per-book 会切到外观页并滚动到 id=per-book 的元素。
 */
const { settings } = useSettings();
const { books } = useBooks();

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  desc: string;
}
const NAV: NavItem[] = [
  { id: 'books', label: '词书', icon: 'book', desc: '选择与组合要高亮的词书' },
  { id: 'appearance', label: '外观', icon: 'palette', desc: '样式预设、行内译文、释义卡片' },
  { id: 'sources', label: '生词本', icon: 'cloud', desc: '有道 / 欧路同步与文件导入' },
  { id: 'known', label: '熟词', icon: 'known', desc: '已掌握的词不再高亮' },
  { id: 'sync', label: '同步', icon: 'sync', desc: '浏览器账号、WebDAV 与手动备份' },
  { id: 'more', label: '更多', icon: 'more', desc: '发音、站点、悬浮球、YouTube、代码块' },
];

/** 同步相关锚点原在“更多”页（popup/background 生成的 `#more/sync` 链接），现在归“同步”页，旧链接继续可用 */
const SYNC_ANCHORS = ['sync', 'webdav', 'backup', 'credentials'];

function parseHash() {
  const [rawPage = 'books', anchor] = location.hash.replace(/^#\/?/, '').split('/');
  const page = rawPage === 'more' && anchor && SYNC_ANCHORS.includes(anchor) ? 'sync' : rawPage;
  return { page: page === 'welcome' || NAV.some((n) => n.id === page) ? page : 'books', anchor };
}
const route = ref(parseHash());
const onHash = () => (route.value = parseHash());
onMounted(() => window.addEventListener('hashchange', onHash));
onUnmounted(() => window.removeEventListener('hashchange', onHash));

function navigate(page: string, anchor?: string) {
  const hash = '#' + page + (anchor ? '/' + anchor : '');
  if (location.hash !== hash) location.hash = hash;
  else onHash();
}

/**
 * 切页回到顶部；有锚点时滚动到锚点（#30/#64/#109）：
 * - immediate：首次打开 options.html#sync/webdav 也要定位；页面要等设置加载完才渲染，所以同时监听 settings 是否就绪；
 * - 等分组页渲染完成再滚：nextTick（DOM 已更新）+ rAF（布局完成）。外观页的实时预览（LivePreview）在 AppearancePage 同步挂载，
 *   此时已就位，被锚点定位的小节由外观页设置 scroll-margin-top = 吸顶预览区高度，不会被盖住；
 * - 用瞬时滚动而不是 smooth：smooth 在跨页长距离时要滚很久才到（约 2 秒），手机上页内跳转还可能被后续布局打断而停在原处。
 */
async function scrollToRoute(r: { page: string; anchor?: string }) {
  await nextTick();
  await new Promise((res) => requestAnimationFrame(res));
  if (r.anchor) document.getElementById(r.anchor)?.scrollIntoView({ block: 'start' });
  else window.scrollTo({ top: 0 });
}
watch(
  [route, () => !!settings.value],
  ([r, ready]) => {
    if (ready) void scrollToRoute(r);
  },
  { flush: 'post', immediate: true },
);

const current = computed(() => NAV.find((n) => n.id === route.value.page));

// 界面主题：auto 时不设置 data-theme，交给 prefers-color-scheme
watchEffect(() => {
  const theme = settings.value?.ui.theme ?? 'auto';
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
});

// 升级后首次打开：弹出简短的更新说明（全新安装走 #welcome，不弹）
const notesOpen = ref(false);
const stopNotesWatch = watch(settings, async (s) => {
  if (!s) return;
  stopNotesWatch();
  notesOpen.value = await shouldShowReleaseNotes(s.updatedAt, route.value.page === 'welcome');
});

// 设置加载完成后才 provide 非空的 settings（各页面只在 settings 就绪后渲染）
provideOptions({ settings: settings as Ref<Settings>, books, navigate });
</script>

<template>
  <div v-if="settings" class="shell" :class="{ welcome: route.page === 'welcome' }">
    <WelcomeGuide v-if="route.page === 'welcome'" />
    <template v-else>
      <aside class="side">
        <div class="brand">
          <img src="/icons/48.png" alt="" width="32" height="32" />
          <div>
            <strong>生词高亮</strong>
            <span class="muted">设置</span>
          </div>
        </div>
        <label class="master">
          <span class="dot" :class="{ on: settings.enabled }" />
          <span class="master-text">{{ settings.enabled ? '高亮已开启' : '高亮已关闭' }}</span>
          <ToggleSwitch v-model="settings.enabled" aria-label="开启高亮" />
        </label>
        <nav aria-label="设置分组">
          <a
            v-for="n in NAV"
            :key="n.id"
            :href="'#' + n.id"
            class="nav-item"
            :class="{ on: route.page === n.id }"
            :aria-current="route.page === n.id ? 'page' : undefined"
          >
            <AppIcon :name="n.icon" />
            <span class="nav-text">
              <span>{{ n.label }}</span>
              <span class="nav-desc">{{ n.desc }}</span>
            </span>
          </a>
        </nav>
        <a class="guide-link" href="#welcome"><AppIcon name="sparkle" :size="16" />快速设置引导</a>
      </aside>

      <header class="topbar">
        <img src="/icons/48.png" alt="" width="28" height="28" />
        <h1>{{ current?.label ?? '设置' }}</h1>
        <span class="spacer" />
        <ToggleSwitch v-model="settings.enabled" aria-label="开启高亮" />
      </header>

      <main class="content">
        <div class="page-head">
          <h1>{{ current?.label }}</h1>
          <p class="muted">{{ current?.desc }}</p>
        </div>
        <SiteAccessBanner />
        <BooksPage v-if="route.page === 'books'" />
        <AppearancePage v-else-if="route.page === 'appearance'" />
        <SourcesPage v-else-if="route.page === 'sources'" />
        <KnownPage v-else-if="route.page === 'known'" />
        <SyncPage v-else-if="route.page === 'sync'" />
        <MorePage v-else-if="route.page === 'more'" />
      </main>

      <nav class="tabbar" aria-label="设置分组">
        <a
          v-for="n in NAV"
          :key="n.id"
          :href="'#' + n.id"
          :class="{ on: route.page === n.id }"
          :aria-current="route.page === n.id ? 'page' : undefined"
        >
          <AppIcon :name="n.icon" :size="22" />
          <span>{{ n.label }}</span>
        </a>
      </nav>
    </template>

    <ReleaseNotesSheet v-model:open="notesOpen" />

    <Transition name="toast">
      <div v-if="toast.current" :key="toast.current.id" class="toast" :class="toast.current.tone" role="status">
        <span>{{ toast.current.message }}</span>
        <button
          v-if="toast.current.action"
          type="button"
          @click="
            toast.current.action.run();
            dismissToast();
          "
        >
          {{ toast.current.action.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; }
/* ---------- 桌面：侧栏 + 内容 ---------- */
.side { position: fixed; inset: 0 auto 0 0; width: 248px; padding: 20px 14px; display: flex; flex-direction: column; gap: 14px;
  background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; }
.brand { display: flex; gap: 10px; align-items: center; padding: 0 6px; }
.brand div { display: flex; flex-direction: column; line-height: 1.25; }
.brand strong { font-size: 16px; }
.master { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 12px; background: var(--surface-2); cursor: pointer; }
.master-text { flex: 1; font-weight: 600; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-2); }
.dot.on { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 25%, transparent); }
.side nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: var(--text); text-decoration: none; }
.nav-item:hover { background: var(--surface-2); text-decoration: none; }
.nav-item.on { background: var(--accent-soft); color: var(--text); }
.nav-item.on .icon { color: var(--accent); }
.nav-text { display: flex; flex-direction: column; line-height: 1.3; font-weight: 600; }
.nav-desc { font-size: 12px; font-weight: 400; color: var(--text-2); }
.guide-link { margin-top: auto; display: flex; align-items: center; gap: 6px; padding: 8px 12px; font-size: 13px; }
.content { margin-left: 248px; padding: 28px max(32px, calc((100vw - 248px - 820px) / 2)) 64px; display: flex; flex-direction: column; gap: 16px; }
.page-head h1 { margin: 0; font-size: 22px; }
.page-head p { margin: 2px 0 0; }
.topbar, .tabbar { display: none; }

/* ---------- 手机/窄屏：顶栏 + 底部 Tab ---------- */
@media (max-width: 899px) {
  .side, .page-head { display: none; }
  .topbar { display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 20; padding: 8px 16px;
    min-height: 56px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border); }
  .topbar h1 { margin: 0; font-size: 18px; }
  .spacer { flex: 1; }
  .content { margin: 0 auto; max-width: 720px; padding: 12px 12px calc(84px + env(safe-area-inset-bottom)); gap: 12px; }
  .tabbar { display: grid; grid-template-columns: repeat(6, 1fr); position: fixed; inset: auto 0 0 0; z-index: 20;
    padding: 4px 4px calc(4px + env(safe-area-inset-bottom)); background: var(--surface); border-top: 1px solid var(--border); }
  .tabbar a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 56px;
    color: var(--text-2); font-size: 12px; text-decoration: none; border-radius: 12px; }
  .tabbar a.on { color: var(--accent); font-weight: 650; }
  .tabbar a.on .icon { background: var(--accent-soft); border-radius: 999px; padding: 2px 14px; box-sizing: content-box; }
}

/* ---------- 轻提示 ---------- */
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50; display: flex; align-items: center; gap: 14px; width: max-content;
  max-width: calc(100vw - 32px); padding: 10px 12px 10px 16px; border-radius: 12px; background: #1f2328; color: #f5f5f5;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25); font-size: 14px; }
.toast.error { background: #7f1d1d; }
.toast button { border: 0; background: transparent; color: #fbbf24; font-weight: 700; cursor: pointer; min-height: 36px; padding: 0 8px; }
@media (max-width: 899px) { .toast { bottom: calc(76px + env(safe-area-inset-bottom)); } .welcome .toast { bottom: 24px; } }
.toast-enter-active, .toast-leave-active { transition: opacity .2s, transform .2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 12px); }
</style>
