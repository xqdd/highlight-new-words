import type { Settings } from '@/core/settings/schema';
import { resolveMarkStyle } from '@/core/theme/resolve';

/**
 * 预隐藏动态样式的注册 id 与文件（public/prehide.css）：settings.performance.prehide 开启时由 background 注册，
 * 见 background/prehide.ts。样式按 `html:not([data-hnw-ready])` 隐藏页面，CSS 自身另有 1000ms 的动画兜底。
 */
export const PREHIDE_SCRIPT_ID = 'hnw-prehide';
export const PREHIDE_CSS_FILE = '/prehide.css';
/** 释放预隐藏：内容脚本给 <html> 加上该属性后隐藏样式不再匹配（与 public/prehide.css 的选择器一致） */
export const PREHIDE_READY_ATTR = 'data-hnw-ready';
/** prehide.css 中的动画名，用于在 document_start 判断隐藏样式是否已生效（与 public/prehide.css 一致） */
const PREHIDE_ANIMATION = 'hnw-prehide';
/**
 * 预隐藏的最长时间（ms，从内容脚本注入算起）：超时即显示页面，之后首屏译文退回懒插入（可能有少量推移）。
 * 维基百科桌面首屏就绪（设置 + 词书 + 词形 + 首屏解析 + 首屏标注 + 释义）实测约在 360–640ms（注入约在 70–260ms），
 * 大页面在页面解析繁忙时扩展资源请求变慢，留出余量。
 */
export const PREHIDE_MAX_MS = 600;

/**
 * 首屏预隐藏（可选，默认关闭：settings.performance.prehide）。
 *
 * 首次绘制（维基约 80–200ms）早于词书/词形数据就绪（约 240ms），首屏的词后括注只能在绘制之后插入，推移计入 CLS。
 * 开启后 background 动态注册 document_start 的隐藏样式（public/prehide.css），浏览器在构建 DOM 之前就注入，
 * 不依赖内容脚本异步读取设置。本函数在 document_start 启动 600ms 兜底计时，返回的 release 给 <html> 加 data-hnw-ready 显示页面。
 * 隐藏期间的布局变化不可见，不产生布局推移；代价是首次绘制推迟到首屏标注完成（维基桌面约 +250ms），所以默认关闭。
 *
 * release 只在隐藏样式确实生效时才加属性（按计算样式的 animation-name 判断），未开启时不在页面上留下属性。
 * 不在 document_start 判断：实测 Chrome 中 manifest 内容脚本执行时，计算样式里还看不到动态注册的隐藏样式（页面实际是隐藏的）。
 * 只在顶层、页面仍在解析时启用（隐藏样式注册为 allFrames:false；补注入到已打开页面时不会有隐藏样式）。
 * release 幂等：设置读到后若不需要（未开启、未启用、站点禁用、不改变排版的样式），app 立即调用（此时文档很小，样式计算开销可忽略）。
 */
export function prehidePage(doc: Document): () => void {
  const root = doc.documentElement;
  if (!root || window.top !== window || doc.readyState !== 'loading') return () => {};
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const hidden = getComputedStyle(root).animationName.split(',').some((n) => n.trim() === PREHIDE_ANIMATION);
    if (hidden) root.setAttribute(PREHIDE_READY_ATTR, '');
  };
  // 兜底：任何异常、数据加载过慢都不会让页面一直不可见（CSS 动画另有 1000ms 兜底，覆盖内容脚本未运行的情况）
  const timer = setTimeout(release, PREHIDE_MAX_MS);
  return release;
}

/**
 * 当前设置下首屏标注是否会改变排版（需要预隐藏；background 据此决定是否注册隐藏样式，内容脚本据此决定是否立即释放）：
 * 行内译文为词后/词上（占位）；或生词样式含加粗/斜体（单词变宽，按词书样式一并检查）。
 * 颜色、背景、装饰线、outline/box-shadow 边框都不占布局，不需要隐藏。
 */
export function layoutAffectingSettings(settings: Settings): boolean {
  const mode = settings.inlineTranslation.mode;
  if (mode === 'after' || mode === 'ruby') return true;
  const styles = [resolveMarkStyle(settings), ...settings.books.enabled.map((id) => resolveMarkStyle(settings, id))];
  return styles.some((s) => (!!s.fontWeight && s.fontWeight !== 'inherit') || !!s.italic);
}
