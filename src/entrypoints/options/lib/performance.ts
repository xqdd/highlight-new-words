import type { Settings } from '@/core/settings/schema';
import { patchSettings } from '@/core/settings/store';
import { layoutAffectingSettings } from '@/content/engine/prehide';

/**
 * “加载时先隐藏页面”（settings.performance.prehide，默认关；实现见 background/prehide.ts 与 content/engine/prehide.ts）。
 * 只有首屏标注会改变排版时才真正隐藏（行内译文为词后/词上，或生词样式含粗体/斜体），判断复用 engine 的 layoutAffectingSettings，
 * 与 background 是否注册隐藏样式的口径一致。
 */

/** 当前设置下开启后是否真的会起作用 */
export function prehideApplies(settings: Settings): boolean {
  return layoutAffectingSettings(settings);
}

/** 开关下方的辅助说明：注明生效条件，当前设置下不起作用时直接说明 */
export function prehideNote(settings: Settings): string {
  const cond = '只在行内译文为“词后”“词上方”，或生词样式含粗体/斜体时起作用';
  return prehideApplies(settings) ? `${cond}；当前设置会起作用。` : `${cond}；当前设置下不会隐藏页面。`;
}

/**
 * 切换开关：同时改本页的响应式设置（保持 useSettings 的防抖保存与界面一致，避免旧值覆盖），
 * 并立即 patchSettings 落盘，background 收到设置变化后马上注册/注销隐藏样式，不等防抖。
 */
export async function setPrehide(settings: Settings, prehide: boolean, patch: typeof patchSettings = patchSettings): Promise<void> {
  settings.performance = { ...settings.performance, prehide };
  await patch({ performance: { prehide } });
}
