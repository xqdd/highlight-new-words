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
  let revision = 0;
  let savedRevision = 0;
  let disposed = false;
  let saves = Promise.resolve();

  const apply = (s: Settings) => {
    lastJson = JSON.stringify(s);
    settings.value = s;
  };
  const ready = getSettings().then(apply);
  const stopWatchStorage = watchSettings((s) => {
    // 防抖和保存请求期间的旧回流不能覆盖刚编辑的设置；最新保存后再读取权威存储值。
    if (revision !== savedRevision) return;
    if (JSON.stringify(s) !== lastJson) apply(s);
  });

  watch(
    settings,
    (s) => {
      if (!s) return;
      const json = JSON.stringify(s);
      if (json === lastJson) return;
      lastJson = json;
      const currentRevision = ++revision;
      clearTimeout(timer);
      // structuredClone(toRaw) 去掉 Vue 响应式代理，storage 只接受普通对象
      timer = setTimeout(() => {
        timer = undefined;
        const snapshot = structuredClone(toRaw(settings.value!));
        // 同一页面串行落库，避免旧慢请求在新请求之后写入；排队期间过时的版本直接跳过。
        saves = saves.then(async () => {
          if (disposed || currentRevision !== revision) return;
          await saveSettings(snapshot);
          if (disposed || currentRevision !== revision) return;
          const stored = await getSettings();
          if (disposed || currentRevision !== revision) return;
          savedRevision = currentRevision;
          apply(stored);
        }).catch(error => console.error('保存设置失败', error));
      }, 150);
    },
    { deep: true, flush: 'sync' },
  );

  onScopeDispose(() => {
    disposed = true;
    stopWatchStorage();
    clearTimeout(timer);
  });
  return { settings, ready };
}
