import type { Settings } from '@/core/settings/schema';
import { resolveCardStyle } from '@/core/theme/resolve';
import { h } from '../card/h';
import { isolateHostEvents, overlayRoot, registerOverlayHost } from './registry';

/**
 * 页内浮层宿主（悬浮球、站点面板共用）：自定义标签 + open Shadow DOM。
 * - 宿主用内联 !important 固定为不占位的透明层，页面通配样式影响不到
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
  setTheme(settings: Settings): void;
  toast(message: string, action?: { label: string; run: () => void }, opts?: { up?: boolean }): void;
  destroy(): void;
}

export function createOverlayHost(doc: Document, tag: string, css: string): OverlayHost {
  const host = doc.createElement(tag);
  host.setAttribute(
    'style',
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; display: block !important; z-index: 2147483646 !important; pointer-events: none !important;',
  );
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

  return {
    host,
    shadow,
    ui,
    ensureMounted,
    setTheme(settings) {
      const pref = settings.ui?.theme ?? 'auto';
      const dark = pref === 'dark' || (pref === 'auto' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
      host.setAttribute('data-theme', dark ? 'dark' : 'light');
      // 强调色与单词卡片一致（取当前高亮主题的卡片强调色）
      ui.style.setProperty('--accent', resolveCardStyle(settings).accent || '#2563eb');
    },
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
