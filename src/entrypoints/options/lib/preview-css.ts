import { ATTR_TR_MODE } from '@/content/engine/dom';
import { buildPageCss } from '@/content/engine/style';
import type { Settings } from '@/core/settings/schema';

/**
 * 选项页预览样式：复用内容脚本的 buildPageCss（所见即网页上的实际效果）。
 * buildPageCss 用 `html[data-hnw-tr=…]` 控制行内译文，这里替换为容器属性选择器 `[data-pv-tr=…]`，
 * 使同一页面中多个预览（实时预览、行内译文各选项、引导页、释义卡片“试一试”）可以使用不同模式。
 * 全页只注入一份：多个预览实例共享，按引用计数移除。
 */
const STYLE_ID = 'hnw-options-preview';
let previewUsers = 0;

export function acquirePreviewCss() {
  previewUsers++;
}

export function setPreviewCss(settings: Settings) {
  const css = buildPageCss(settings).replaceAll(`html[${ATTR_TR_MODE}=`, '[data-pv-tr=');
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

export function releasePreviewCss() {
  previewUsers--;
  if (previewUsers <= 0) document.getElementById(STYLE_ID)?.remove();
}
