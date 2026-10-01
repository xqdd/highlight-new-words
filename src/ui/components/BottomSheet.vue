<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

/**
 * 弹层：手机宽度下为底部抽屉（bottom sheet，对标 Relingo 移动端设置），桌面为居中对话框。
 * 基于原生 <dialog>.showModal()：自带焦点管理、Esc 关闭与顶层渲染，不受父级 overflow 影响。
 * 点击遮罩关闭（dialog 元素自身即遮罩区域，点到内容区时 target 是内部元素）。
 */
const open = defineModel<boolean>('open', { required: true });
defineProps<{ title: string; description?: string }>();

const dialog = ref<HTMLDialogElement>();

watch(
  open,
  async (v) => {
    await nextTick();
    const el = dialog.value;
    if (!el) return;
    if (v && !el.open) el.showModal();
    else if (!v && el.open) el.close();
  },
  { immediate: true },
);

function onBackdrop(e: MouseEvent) {
  if (e.target === dialog.value) open.value = false;
}
</script>

<template>
  <dialog ref="dialog" class="sheet" :aria-label="title" @close="open = false" @click="onBackdrop">
    <div class="panel">
      <span class="grip" aria-hidden="true" />
      <header>
        <div class="titles">
          <h3>{{ title }}</h3>
          <p v-if="description" class="muted">{{ description }}</p>
        </div>
        <button type="button" class="close" aria-label="关闭" @click="open = false">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </button>
      </header>
      <div class="body"><slot v-if="open" /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </div>
  </dialog>
</template>

<style scoped>
.sheet { padding: 0; border: 0; background: transparent; color: var(--text); max-width: none; max-height: none; }
.sheet::backdrop { background: var(--overlay); }
.panel { background: var(--surface); display: flex; flex-direction: column; max-height: 100%; }
.grip { display: none; }
header { display: flex; align-items: flex-start; gap: 12px; padding: 16px 16px 8px 20px; }
.titles { flex: 1; min-width: 0; }
h3 { margin: 0; font-size: 17px; font-weight: 650; }
.titles p { margin: 2px 0 0; }
.close { width: 36px; height: 36px; border-radius: 50%; border: 0; background: var(--surface-2); color: var(--text-2); cursor: pointer;
  display: grid; place-items: center; flex: none; }
.body { padding: 8px 20px 20px; overflow: auto; overscroll-behavior: contain; }
footer { display: flex; gap: 10px; justify-content: flex-end; padding: 12px 20px; border-top: 1px solid var(--border); }

/* 桌面：居中对话框 */
@media (min-width: 641px) {
  .sheet { width: min(460px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 64px)); margin: auto; }
  .panel { border-radius: var(--radius-lg); box-shadow: 0 20px 50px rgba(0, 0, 0, .25); max-height: min(720px, calc(100vh - 64px)); }
}
/* 手机：底部抽屉，全宽、圆角顶、留出底部安全区 */
@media (max-width: 640px) {
  .sheet { width: 100vw; margin: auto 0 0; max-height: 88vh; inset: auto 0 0 0; }
  .panel { border-radius: 20px 20px 0 0; max-height: 88vh; padding-bottom: env(safe-area-inset-bottom); animation: up .22s ease-out; }
  .grip { display: block; width: 40px; height: 4px; border-radius: 2px; background: var(--border); margin: 8px auto 0; }
  header { padding-top: 8px; }
  .body { padding: 8px 16px 20px; }
  footer { padding: 12px 16px; }
  footer :deep(.btn) { flex: 1; }
}
@keyframes up { from { transform: translateY(40px); opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
</style>
