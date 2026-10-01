import type { Settings } from '@/core/settings/schema';
import { resolveCardStyle } from '@/core/theme/resolve';
import { isDarkBackground, luminance } from '../card/card-view';
import { h } from '../card/h';
import { computeOverlayFrame, toFrameLocal, type OverlayFrame } from './model';
import { isolateHostEvents, overlayRoot, registerOverlayHost } from './registry';

/** 宿主固定样式：不占位的透明层，页面通配样式影响不到；铺满区域由 frame 决定 */
const HOST_STYLE =
  'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; display: block !important; z-index: 2147483646 !important; pointer-events: none !important; transform-origin: 0 0 !important;';

/**
 * 页内浮层宿主（悬浮球、站点面板共用）：自定义标签 + open Shadow DOM。
 * - 宿主用内联 !important 固定为不占位的透明层，页面通配样式影响不到
 * - 宿主铺满屏幕实际可见区域（visualViewport，见 model.ts OverlayFrame）：子元素的 fixed 以宿主为包含块，
 *   页面横向溢出撑宽布局视口、双指缩放时浮层仍完整落在屏幕内；子元素的坐标一律用宿主局部坐标（frame / toLocal）
 * - 深浅色与单词卡片同一判定：看网页背景亮度（见 setTheme）
 * - z-index 比卡片宿主（2147483647）低 1：卡片总在面板之上
 * - 宿主内事件不冒泡到页面（document 捕获阶段的卡片触发逻辑仍能收到）
 * - 登记为“随全屏迁移”的宿主，全屏时挂进全屏元素
 */
export interface OverlayHost {
  host: HTMLElement;
  shadow: ShadowRoot;
  /** 根容器（.ui），子元素自行 position:fixed */
  ui: HTMLElement;
  /** 宿主被页面移出文档时（SPA 清理）重新挂回 */
  ensureMounted(): void;
  /** 当前铺满区域（宿主局部坐标系的宽高 = 子元素可用的“视口”） */
  frame(): OverlayFrame;
  /** clientX/clientY（及 getBoundingClientRect）坐标 → 宿主局部坐标 */
  toLocal(clientX: number, clientY: number): { x: number; y: number };
  /** 订阅铺满区域变化（旋转、键盘弹出、双指缩放、可见区域平移），返回取消函数 */
  onFrameChange(fn: () => void): () => void;
  /** 按设置与当前网页背景重新判定深浅色（设置变化、打开菜单/面板时调用：页面可能已切换深浅） */
  setTheme(settings: Settings): void;
  toast(message: string, action?: { label: string; run: () => void }, opts?: { up?: boolean }): void;
  destroy(): void;
}

export function createOverlayHost(doc: Document, tag: string, css: string): OverlayHost {
  const host = doc.createElement(tag);
  const win = doc.defaultView ?? window;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = css;
  const ui = h(doc, 'div', { class: 'ui' });
  shadow.append(style, ui);
  isolateHostEvents(host);
  const unregister = registerOverlayHost(host);
  let toastEl: HTMLElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const ensureMounted = () => {
    const root = overlayRoot(doc);
    if (host.parentElement !== root) root.appendChild(host);
  };
  ensureMounted();

  // ---- 铺满屏幕实际可见区域 ----
  let frame: OverlayFrame = { x: 0, y: 0, scale: 1, width: 0, height: 0 };
  const frameListeners = new Set<() => void>();
  const applyFrame = () => {
    const next = computeOverlayFrame(win.visualViewport, { width: doc.documentElement.clientWidth || win.innerWidth, height: win.innerHeight });
    const changed = next.x !== frame.x || next.y !== frame.y || next.scale !== frame.scale || next.width !== frame.width || next.height !== frame.height;
    frame = next;
    if (!changed) return false;
    // 平移到可见区域左上角，再按 1/scale 缩小：双指放大时浮层保持原本的屏幕尺寸
    host.setAttribute(
      'style',
      `${HOST_STYLE} width: ${frame.width}px !important; height: ${frame.height}px !important; transform: translate(${frame.x}px, ${frame.y}px) scale(${1 / frame.scale}) !important;`,
    );
    return true;
  };
  applyFrame();
  // visualViewport 的 scroll/resize 在双指缩放与平移时高频触发：合并到下一帧处理
  let frameRaf = 0;
  const onViewportChange = () => {
    if (frameRaf) return;
    frameRaf = requestAnimationFrame(() => {
      frameRaf = 0;
      if (applyFrame()) for (const fn of frameListeners) fn();
    });
  };
  win.visualViewport?.addEventListener('resize', onViewportChange);
  win.visualViewport?.addEventListener('scroll', onViewportChange);
  win.addEventListener('resize', onViewportChange);

  /**
   * 判定深浅色时取样的页面元素：可见区域中心处最上层的页面元素（跳过扩展自己的浮层宿主，菜单遮罩打开时也能取到页面），
   * 取不到时用 body
   */
  const pageSample = (): Element => {
    const stack = doc.elementsFromPoint?.(frame.x + frame.width / frame.scale / 2, frame.y + frame.height / frame.scale / 2) ?? [];
    return stack.find((el) => !/^hnw-.*host$/.test(el.localName)) ?? doc.body ?? doc.documentElement;
  };
  const setTheme = (settings: Settings) => {
    const card = resolveCardStyle(settings);
    // 与单词卡片同一判定（ShadowCardView#applyColors）：网页背景暗且主题卡片是浅底 → 深色；主题卡片底色本身就深 → 深色。
    // 不看系统 prefers-color-scheme 与扩展页面的界面主题（settings.ui.theme）：同一页面上悬浮球菜单、字幕面板与卡片颜色一致
    const cardLum = luminance(card.background);
    const dark = (isDarkBackground(pageSample()) && cardLum > 0.5) || cardLum < 0.35;
    host.setAttribute('data-theme', dark ? 'dark' : 'light');
    // 强调色与单词卡片一致（取当前高亮主题的卡片强调色）
    ui.style.setProperty('--accent', card.accent || '#2563eb');
  };

  return {
    host,
    shadow,
    ui,
    ensureMounted,
    frame: () => frame,
    toLocal: (clientX, clientY) => toFrameLocal(frame, clientX, clientY),
    onFrameChange(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    setTheme,
    toast(message, action, opts = {}) {
      clearTimeout(toastTimer);
      toastEl?.remove();
      const el = h(
        doc,
        'div',
        { class: `toast${opts.up ? ' up' : ''}`, role: 'status', 'aria-live': 'polite' },
        h(doc, 'span', {}, message),
        action &&
          h(doc, 'button', {
            type: 'button',
            onclick: () => {
              el.remove();
              action.run();
            },
          }, action.label),
      );
      ui.appendChild(el);
      toastEl = el;
      requestAnimationFrame(() => el.classList.add('in'));
      toastTimer = setTimeout(() => {
        el.classList.remove('in');
        setTimeout(() => el.remove(), 200);
      }, action ? 5000 : 2600);
    },
    destroy() {
      clearTimeout(toastTimer);
      cancelAnimationFrame(frameRaf);
      win.visualViewport?.removeEventListener('resize', onViewportChange);
      win.visualViewport?.removeEventListener('scroll', onViewportChange);
      win.removeEventListener('resize', onViewportChange);
      frameListeners.clear();
      unregister();
      host.remove();
    },
  };
}

/** 底部抽屉的下滑关闭：在抓手/标题区下拉超过 80px 或快速下滑时关闭 */
export function bindSheetDrag(sheet: HTMLElement, handle: HTMLElement, close: () => void): void {
  let startY: number | null = null;
  let startT = 0;
  let dy = 0;
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    startT = performance.now();
    dy = 0;
    handle.setPointerCapture?.(e.pointerId);
    sheet.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY === null) return;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    const fast = dy > 30 && performance.now() - startT < 250;
    if (dy > 80 || fast) close();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
