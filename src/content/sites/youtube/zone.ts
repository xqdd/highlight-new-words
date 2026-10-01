import { registerCardTriggerZone } from '../../card/trigger';
import { TAG_MARK } from '../../engine/dom';
import { CAPTION_CONTAINER_CLASS, getPlayer, getVideo } from './dom';

/** 生词命中外扩（px）：字幕字小，手指点按允许稍偏 */
const TOUCH_PAD = 6;
const MOUSE_PAD = 1;
/** 点按判定：位移不超过（px）、按住不超过（ms），否则是滑动/长按 */
const TAP_SLOP = 10;
const TAP_MAX_MS = 600;

/**
 * 字幕生词的卡片触发区域（接入通用卡片触发逻辑，规则与页面其他高亮词一致）。
 *
 * 字幕上常压着播放器的透明层（桌面控件自动隐藏时的控件层、手机暂停后的控件遮罩），pointerover/click 的目标是遮罩而不是 hnw-mark，
 * 通用逻辑按 closest(hnw-mark) 找不到单词；这里按坐标对主播放器字幕中的 hnw-mark 做几何命中：
 * - 鼠标：悬停/修饰键/点击按 settings.card.trigger 照常触发（pointermove 逐帧命中，暂停与否都可以）。
 *   默认关闭“悬停字幕自动暂停”时，暂停后悬停生词也要能出卡片
 * - 触屏：只在视频已暂停时响应点按（播放中点字幕仍是 YouTube 的显示/隐藏控件，避免误触）；
 *   暂停后可以直接点字幕里的生词查词，不必再经过悬浮球与面板（见下方 touch 处理）
 * 不在播放器范围内时直接返回，页面其他位置的开销只是一次 getElementById + 一次矩形读取。
 */
export function registerCaptionCardZone(doc: Document, openCard: (anchor: HTMLElement) => void): () => void {
  const unregister = registerCardTriggerZone({
    hitTestOnMove: true,
    anchorOf(e) {
      if (!(e instanceof MouseEvent)) return null;
      const touch = ((e as PointerEvent).pointerType || 'mouse') !== 'mouse';
      if (touch && !getVideo(doc)?.paused) return null;
      return captionMarkAt(doc, e.clientX, e.clientY, touch ? TOUCH_PAD : MOUSE_PAD);
    },
  });

  // 触屏点按：m.youtube.com 播放器在 touchend 上 preventDefault，点字幕不会产生 click，通用触发逻辑收不到；
  // 这里在 touchstart/touchend（window 捕获阶段，早于播放器）自己判断“暂停中、短按、没有滑动、落在字幕生词上”，打开卡片并吞掉这次触摸，
  // 播放器不会因这次点按切换控件显示
  let start: { x: number; y: number; t: number; anchor: HTMLElement } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    start = null;
    const p = e.touches[0];
    if (e.touches.length !== 1 || !p || !getVideo(doc)?.paused) return;
    const anchor = captionMarkAt(doc, p.clientX, p.clientY, TOUCH_PAD);
    if (anchor) start = { x: p.clientX, y: p.clientY, t: performance.now(), anchor };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s = start;
    start = null;
    const p = e.changedTouches[0];
    if (!s || !p || Math.hypot(p.clientX - s.x, p.clientY - s.y) > TAP_SLOP || performance.now() - s.t > TAP_MAX_MS) return;
    if (!s.anchor.isConnected) return;
    e.preventDefault();
    e.stopPropagation();
    openCard(s.anchor);
  };
  const win = doc.defaultView ?? window;
  win.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  win.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  return () => {
    unregister();
    win.removeEventListener('touchstart', onTouchStart, true);
    win.removeEventListener('touchend', onTouchEnd, true);
  };
}

/** 坐标处主播放器字幕中的生词（外扩 pad 后命中多个时取中心最近的）；不在播放器范围内直接返回 null */
export function captionMarkAt(doc: Document, x: number, y: number, pad: number): HTMLElement | null {
  const player = getPlayer(doc);
  if (!player) return null;
  const pr = player.getBoundingClientRect();
  if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) return null;
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const m of player.querySelectorAll<HTMLElement>(`:scope > .${CAPTION_CONTAINER_CLASS} ${TAG_MARK}`)) {
    // above 模式下生词是 inline-block，矩形含上方注解，点在注解上也算这个词
    for (const r of m.getClientRects()) {
      if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) continue;
      const d = Math.abs(x - (r.left + r.right) / 2) + Math.abs(y - (r.top + r.bottom) / 2);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
  }
  return best;
}
