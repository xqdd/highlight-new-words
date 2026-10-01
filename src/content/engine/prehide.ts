import type { Settings } from '@/core/settings/schema';
import { resolveMarkStyle } from '@/core/theme/resolve';

/** 预隐藏样式元素 id */
export const PREHIDE_STYLE_ID = 'hnw-prehide';
/**
 * 预隐藏的最长时间（ms，从内容脚本注入算起）：超时即显示页面，之后首屏译文退回懒插入（可能有少量推移）。
 * 维基百科桌面首屏就绪（设置 + 词书 + 词形 + 首屏解析 + 首屏标注 + 释义）实测约在 360–640ms（注入约在 70–260ms），
 * 大页面在页面解析繁忙时扩展资源请求变慢，留出余量。
 */
export const PREHIDE_MAX_MS = 600;

/**
 * 首屏预隐藏（预研要求：降低“词后”模式的 CLS）。
 *
 * 首次绘制（维基约 120–200ms）早于词书/词形数据就绪（约 240ms），首屏的词后括注只能在绘制之后插入，
 * 推移计入 CLS（改造前桌面维基约 0.07–0.09）。这里在 document_start 同步给 <html> 加 `visibility:hidden`，
 * 首屏标注与译文写完后再显示：隐藏期间的布局变化不可见，不产生布局推移；代价是首次绘制推迟约 100–200ms。
 *
 * 只在顶层文档、页面仍在解析时使用（扩展安装后补注入到已打开页面时不隐藏）。
 * 返回幂等的 release：设置读到后若不需要（未启用、站点禁用、不改变排版的样式），立即释放（通常早于首次绘制）。
 */
export function prehidePage(doc: Document): () => void {
  const root = doc.documentElement;
  if (!root || window.top !== window || doc.readyState !== 'loading') return () => {};
  const style = doc.createElement('style');
  style.id = PREHIDE_STYLE_ID;
  style.textContent = 'html{visibility:hidden!important}';
  root.appendChild(style);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    style.remove();
  };
  // 兜底：任何异常、数据加载过慢都不会让页面一直不可见
  const timer = setTimeout(release, PREHIDE_MAX_MS);
  return release;
}

/**
 * 当前设置下首屏标注是否会改变排版（需要预隐藏）：
 * 行内译文为词后/词上（占位）；或生词样式含加粗/斜体（单词变宽，按词书样式一并检查）。
 * 颜色、背景、装饰线、outline/box-shadow 边框都不占布局，不需要隐藏。
 */
export function layoutAffectingSettings(settings: Settings): boolean {
  const mode = settings.inlineTranslation.mode;
  if (mode === 'after' || mode === 'ruby') return true;
  const styles = [resolveMarkStyle(settings), ...settings.books.enabled.map((id) => resolveMarkStyle(settings, id))];
  return styles.some((s) => (!!s.fontWeight && s.fontWeight !== 'inherit') || !!s.italic);
}
