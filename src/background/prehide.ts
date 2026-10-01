import { syncRegisteredCss, type DynamicCssScript } from '@/core/platform/content-scripts';
import type { Settings } from '@/core/settings/schema';
import { getSettings, watchSettings } from '@/core/settings/store';
import { PREHIDE_CSS_FILE, PREHIDE_SCRIPT_ID, layoutAffectingSettings } from '@/content/engine/prehide';

/**
 * 首屏预隐藏样式的动态注册（settings.performance.prehide，默认关）。
 *
 * 隐藏必须早于首次绘制，而内容脚本在 document_start 读设置是异步的（读到时页面可能已绘制），
 * 所以由 background 在设置开启时把 public/prehide.css 注册为 document_start 内容样式：浏览器在构建 DOM 前注入，
 * 内容脚本首屏完成后加 data-hnw-ready 释放（见 content/engine/prehide.ts）。
 *
 * 对齐时机：后台每次启动（含浏览器启动、扩展安装/更新后的首次启动）按当前设置对齐一次；之后监听设置变化。
 */

/** 隐藏样式的注册定义：只作用于顶层文档（iframe 内的译文推移不影响主页面首屏观感，且 iframe 多时隐藏代价更大） */
export const PREHIDE_CSS_SCRIPT: DynamicCssScript = {
  id: PREHIDE_SCRIPT_ID,
  css: [PREHIDE_CSS_FILE],
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: false,
};

/**
 * 当前设置是否需要注册隐藏样式：用户开启、扩展总开关打开，且首屏标注会改变排版（词后/词上译文或加粗/斜体样式）。
 * 不改变排版时不注册，页面完全不受影响；站点禁用只能在内容脚本读到设置后判断，由内容脚本立即释放。
 */
export function shouldRegisterPrehide(settings: Settings): boolean {
  return settings.performance.prehide && settings.enabled && layoutAffectingSettings(settings);
}

/** 串行化对齐操作：设置连续变化时避免并发 register 同一 id 报错 */
let pending: Promise<unknown> = Promise.resolve();

/** 按设置对齐注册状态（幂等）；返回对齐后是否已注册。失败只记录警告，不影响其他后台功能 */
export function syncPrehideRegistration(settings: Settings): Promise<boolean> {
  const run = pending.then(() => syncRegisteredCss(PREHIDE_CSS_SCRIPT, shouldRegisterPrehide(settings)));
  pending = run.catch((e: unknown) => console.warn('[hnw] 对齐首屏预隐藏样式注册失败', e));
  return run;
}

/**
 * 后台启动时调用：立即按当前设置对齐一次，并在影响判断的设置变化时重新对齐。
 * ready 为迁移完成的 Promise（迁移前读到的可能是旧结构/默认设置）。
 */
export function setupPrehideRegistration(ready: Promise<unknown>): void {
  let last: boolean | undefined;
  const apply = (settings: Settings) => {
    const want = shouldRegisterPrehide(settings);
    if (want === last) return;
    last = want;
    void syncPrehideRegistration(settings).catch(() => {});
  };
  // 监听须在 SW 启动的同步阶段注册
  watchSettings(apply);
  void ready.then(() => getSettings()).then(apply);
}
