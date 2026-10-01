import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContentApp } from '@/content/app';
import { prehidePage } from '@/content/engine/prehide';

/**
 * 内容脚本入口：所有页面、所有 frame，document_start 注入（engine 第二阶段调整，原为 document_idle）：
 * 设置、词书、词形数据与页面解析并行加载，DOM 就绪后立即处理首屏，减少首屏行内译文造成的布局推移（CLS）。
 * 页面高亮样式由脚本注入 <style>，卡片 UI 在 Shadow DOM 中，不再需要 manifest 级 CSS。
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    // 非 HTML 文档（如 XML/SVG 直接打开）跳过；body 在 DOM 就绪后由 app 检查
    if (document.documentElement && !(document.documentElement instanceof HTMLElement)) return;
    // 首屏预隐藏（同步执行，必须早于首次绘制）：首屏标注与译文写完后由 app 释放，见 prehide.ts
    const releasePrehide = prehidePage(document);
    startContentApp({ releasePrehide }).catch((e) => {
      releasePrehide();
      console.warn('[hnw] 内容脚本启动失败', e);
    });
  },
});
