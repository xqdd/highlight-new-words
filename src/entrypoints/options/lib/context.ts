import { inject, provide, type InjectionKey, type Ref } from 'vue';
import type { Settings } from '@/core/settings/schema';
import type { BookMeta } from '@/core/wordbook/types';

/**
 * 选项页共享上下文：App 加载完设置后 provide，各页面/分组 inject，避免层层传 v-model。
 * settings 为 useSettings 返回的响应式对象（直接改字段即自动防抖保存）。
 */
export interface OptionsContext {
  settings: Ref<Settings>;
  books: Ref<BookMeta[]>;
  /** 切换到某个分组页（hash 路由），可附带页内锚点 */
  navigate: (page: string, anchor?: string) => void;
}

const KEY: InjectionKey<OptionsContext> = Symbol('options');

export function provideOptions(ctx: OptionsContext) {
  provide(KEY, ctx);
}

export function useOptions(): OptionsContext {
  const ctx = inject(KEY);
  if (!ctx) throw new Error('useOptions 必须在选项页 App 内使用');
  return ctx;
}
