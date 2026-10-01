import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContentApp } from '@/content/app';

/**
 * 内容脚本入口：所有页面、所有 frame，页面空闲时启动。
 * 页面高亮样式由脚本注入 <style>，卡片 UI 在 Shadow DOM 中，不再需要 manifest 级 CSS。
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    // 非 HTML 文档（如 XML/SVG 直接打开）没有 body，跳过
    if (!document.body || !(document.documentElement instanceof HTMLElement)) return;
    startContentApp().catch((e) => console.warn('[hnw] 内容脚本启动失败', e));
  },
});
