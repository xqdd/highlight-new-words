import { TAG_CARD_HOST } from '../engine/dom';

/**
 * 站点给悬浮球追加的功能项（如 YouTube 视频页的“当前字幕”）。
 * 站点适配层在 start 时注册、停止时注销；悬浮球每次展开菜单时按 available() 过滤。
 */
export interface FloatAction {
  id: string;
  /** 菜单中的名称 */
  label: string;
  /** 一句话说明（菜单副标题） */
  hint?: string;
  /** 当前页面是否可用（如只在视频页、播放器存在时） */
  available(): boolean;
  /** primary：点悬浮球直接执行（代替展开菜单）；菜单中仍显示为第一项 */
  primary?: boolean;
  run(): void;
}

const actions: FloatAction[] = [];

/** 注册悬浮球功能项，返回注销函数 */
export function registerFloatAction(action: FloatAction): () => void {
  actions.push(action);
  return () => {
    const i = actions.indexOf(action);
    if (i >= 0) actions.splice(i, 1);
  };
}

/** 当前可用的功能项 */
export function availableFloatActions(): FloatAction[] {
  return actions.filter((a) => a.available());
}

/** 悬浮球“打开菜单”的入口（站点面板中的“菜单”按钮用），由悬浮球启动时设置 */
let menuOpener: (() => void) | null = null;
export function setFloatMenuOpener(fn: (() => void) | null): void {
  menuOpener = fn;
}
export function openFloatMenu(): boolean {
  if (!menuOpener) return false;
  menuOpener();
  return true;
}

// ---------------- 浮层挂载（全屏） ----------------

/**
 * 浮层挂载点：全屏时为全屏元素，否则 documentElement。
 * 全屏元素之外的节点在全屏时不渲染：桌面 YouTube 全屏元素是 <html>（不受影响），m.youtube.com 是 #movie_player，
 * 其他视频站多为播放器容器。body/html 全屏时仍挂 documentElement。
 */
export function overlayRoot(doc: Document): Element {
  const fs = doc.fullscreenElement ?? (doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;
  if (fs && fs !== doc.documentElement && fs !== doc.body) return fs;
  return doc.documentElement;
}

/** 宿主内事件不冒泡到页面（挂在播放器内时，避免点按面板被播放器当成“切换播放/显示控件”） */
const ISOLATED_EVENTS = ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'wheel', 'contextmenu'];
export function isolateHostEvents(host: Element): void {
  if ((host as HTMLElement).dataset.hnwIsolated) return;
  (host as HTMLElement).dataset.hnwIsolated = '1';
  for (const t of ISOLATED_EVENTS) host.addEventListener(t, (e) => e.stopPropagation());
}

const extraHosts = new Set<Element>();

/** 登记需要随全屏迁移的浮层宿主（悬浮球、站点面板）；卡片宿主 hnw-card-host 总是一并迁移 */
export function registerOverlayHost(host: Element): () => void {
  extraHosts.add(host);
  return () => extraHosts.delete(host);
}

/** 把所有浮层宿主移到当前挂载点（进入/退出全屏时调用；已在挂载点的不动） */
export function relocateOverlayHosts(doc: Document): void {
  const root = overlayRoot(doc);
  const hosts = [...extraHosts, ...doc.querySelectorAll(TAG_CARD_HOST)];
  for (const h of hosts) {
    if (!h.isConnected && !extraHosts.has(h)) continue;
    if (h.parentElement !== root) root.appendChild(h);
    // 进入播放器等全屏元素后，宿主内的点按不能冒泡给播放器（卡片在 shadow 内自己的监听先执行，不受影响）
    if (root !== doc.documentElement) isolateHostEvents(h);
  }
}

/** 监听全屏变化并迁移宿主，返回取消函数 */
export function followFullscreen(doc: Document): () => void {
  const onChange = () => relocateOverlayHosts(doc);
  doc.addEventListener('fullscreenchange', onChange);
  doc.addEventListener('webkitfullscreenchange', onChange);
  return () => {
    doc.removeEventListener('fullscreenchange', onChange);
    doc.removeEventListener('webkitfullscreenchange', onChange);
  };
}
