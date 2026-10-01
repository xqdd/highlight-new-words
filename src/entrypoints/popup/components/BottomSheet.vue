<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import PopupIcon from './PopupIcon.vue';

/**
 * 底部抽屉：popup 内的二级面板（词书切换、单词详情）。
 * 桌面 popup 与手机整页下都从底部滑出、最高占 88% 视口，内容区单独滚动；Esc / 点遮罩 / 关闭按钮关闭。
 */
const open = defineModel<boolean>({ required: true });
defineProps<{ title: string; subtitle?: string }>();

const panel = ref<HTMLElement>();

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false;
}
watch(open, async (v) => {
  if (v) {
    document.addEventListener('keydown', onKey);
    // 打开后把焦点移入面板，便于键盘与读屏用户操作
    await nextTick();
    panel.value?.focus();
  } else {
    document.removeEventListener('keydown', onKey);
  }
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Transition name="sheet">
    <div v-if="open" class="layer" @click.self="open = false">
      <section ref="panel" class="sheet" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <header class="sheet-head">
          <span class="grip" aria-hidden="true" />
          <div class="titles">
            <slot name="title"><h2>{{ title }}</h2></slot>
            <p v-if="subtitle" class="sub">{{ subtitle }}</p>
          </div>
          <button type="button" class="icon-btn" aria-label="关闭" @click="open = false">
            <PopupIcon name="close" />
          </button>
        </header>
        <div class="sheet-body"><slot /></div>
        <footer v-if="$slots.footer" class="sheet-foot"><slot name="footer" /></footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.layer {
  position: fixed; inset: 0; z-index: 20; display: flex; align-items: flex-end;
  background: rgba(15, 18, 24, 0.42);
}
.sheet {
  width: 100%; max-height: 88vh; max-height: 88dvh; display: flex; flex-direction: column;
  background: var(--surface); color: var(--text);
  border-radius: 16px 16px 0 0; box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.18);
  outline: none; padding-bottom: env(safe-area-inset-bottom);
}
.sheet-head { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 16px 12px 8px 16px; }
.grip { position: absolute; top: 6px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 2px; background: var(--border); }
.titles { flex: 1; min-width: 0; }
.titles :deep(h2), h2 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.35; }
.sub { margin: 2px 0 0; color: var(--text-2); font-size: 12.5px; }
.sheet-body { overflow: auto; overscroll-behavior: contain; padding: 4px 16px 16px; }
.sheet-foot { display: flex; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--border); }
.sheet-foot :deep(.btn) { flex: 1; }
.icon-btn {
  display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 50%;
  border: 0; background: var(--surface-2); color: var(--text-2); cursor: pointer; flex: none;
}
.icon-btn:hover { color: var(--text); }
@media (pointer: coarse) { .icon-btn { width: 44px; height: 44px; } }

.sheet-enter-active, .sheet-leave-active { transition: background-color .2s ease; }
.sheet-enter-active .sheet, .sheet-leave-active .sheet { transition: transform .22s cubic-bezier(.2, .8, .2, 1); }
.sheet-enter-from, .sheet-leave-to { background-color: transparent; }
.sheet-enter-from .sheet, .sheet-leave-to .sheet { transform: translateY(100%); }
@media (prefers-reduced-motion: reduce) {
  .sheet-enter-active, .sheet-leave-active, .sheet-enter-active .sheet, .sheet-leave-active .sheet { transition: none; }
}
</style>
