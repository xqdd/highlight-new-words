import { onScopeDispose, ref, toRaw, watch, type Ref } from 'vue';
import type { Settings } from '@/core/settings/schema';
import { getSettings, saveSettings, watchSettings } from '@/core/settings/store';

/**
 * 双向绑定的设置对象：组件直接修改 settings.value 的字段即可（v-model），
 * 变化经 150ms 防抖写入 storage；其他上下文写入的变化会同步回来（不会回写形成循环）。
 * 加载完成前 settings.value 为 null。
 */
export function useSettings(): { settings: Ref<Settings | null>; ready: Promise<void> } {
  const settings = ref<Settings | null>(null);
  let lastJson = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const apply = (s: Settings) => {
    lastJson = JSON.stringify(s);
    settings.value = s;
  };
  const ready = getSettings().then(apply);
  const stopWatchStorage = watchSettings((s) => {
    if (JSON.stringify(s) !== lastJson) apply(s);
  });

  watch(
    settings,
    (s) => {
      if (!s) return;
      const json = JSON.stringify(s);
      if (json === lastJson) return;
      lastJson = json;
      clearTimeout(timer);
      // structuredClone(toRaw) 去掉 Vue 响应式代理，storage 只接受普通对象
      timer = setTimeout(() => void saveSettings(structuredClone(toRaw(s))), 150);
    },
    { deep: true },
  );

  onScopeDispose(() => {
    stopWatchStorage();
    clearTimeout(timer);
  });
  return { settings, ready };
}
