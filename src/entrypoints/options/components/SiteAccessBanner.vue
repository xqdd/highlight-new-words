<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getBrowserFamily, hasAllSitesAccess, requestAllSitesAccess, watchHostAccess } from '@/core/platform';
import AppIcon from '@/ui/components/AppIcon.vue';

/**
 * 网站访问权限检测与引导（release issues #6）：
 * Chrome/Edge 用户可能把“网站访问权限”改成“点击时 / 特定网站”，Firefox 安装后可能未授予“访问所有网站的数据”，
 * 这时内容脚本不注入、页面不高亮，刷新也不会好。检测到未授权时显示横幅和“授权”按钮。
 * 授权按钮的点击处理函数第一句直接调用 requestAllSitesAccess（Firefox 要求在用户操作的同步调用栈内发起，前面不能有 await）。
 */
const missing = ref(false);
const denied = ref(false);
const check = async () => (missing.value = !(await hasAllSitesAccess()));
let stop: (() => void) | undefined;
onMounted(() => {
  void check();
  stop = watchHostAccess(() => void check());
});
onUnmounted(() => stop?.());

function grant() {
  void requestAllSitesAccess().then((ok) => {
    denied.value = !ok;
    void check();
  });
}
const settingsHint =
  getBrowserFamily() === 'firefox' ? '也可以在 about:addons → 本扩展 → 权限 中打开“访问所有网站的数据”。' : '也可以在扩展详情页把“网站访问权限”改为“在所有网站上”。';
</script>

<template>
  <div v-if="missing" class="banner" role="alert">
    <AppIcon name="globe" :size="22" class="ico" />
    <div class="text">
      <strong>还没有授权访问网站，网页上不会高亮生词</strong>
      <span class="muted">授权后刷新已打开的网页即可生效。{{ denied ? settingsHint : '' }}</span>
    </div>
    <button type="button" class="btn primary" @click="grant">授权</button>
  </div>
</template>

<style scoped>
.banner { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, var(--surface)); }
.ico { color: var(--warn); flex: none; }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.btn { flex: none; }
@media (max-width: 480px) { .banner { flex-wrap: wrap; } .btn { width: 100%; } }
</style>
