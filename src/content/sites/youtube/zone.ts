import { registerCardPlacer, type CardPlacement } from '../../card/card-view';
import { registerCardTriggerZone } from '../../card/trigger';
import { TAG_MARK } from '../../engine/dom';
import { CAPTION_CONTAINER_CLASS, getPlayer, getVideo, inMainCaptions } from './dom';
import { captionBox, type Box } from './hover';

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
  // PC 浮层避让整块字幕（卡片默认放在单词下方，会盖住字幕的下一行）
  const unplace = registerCardPlacer((anchor, card, vp) => {
    if (!anchor.isConnected || !inMainCaptions(anchor)) return null;
    const block = captionBox(doc, 0);
    const player = getPlayer(doc);
    if (!block || !player) return null;
    return placeAroundCaptions(anchor.getBoundingClientRect(), block, player.getBoundingClientRect(), card, vp);
  });
  return () => {
    unplace();
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

/** 卡片与字幕块、视口边缘的间距（px） */
const CARD_GAP = 8;

/**
 * 字幕生词卡片的位置：卡片与整块字幕（所有字幕行，含上方注解）不相交，不盖住正在读的行。
 * 依次尝试：
 * 1. 字幕块上方（留 CARD_GAP），水平以单词为中心——字幕贴在画面底部，上方通常是画面，空间最充足
 * 2. 播放器右侧 / 左侧（页面布局里播放器旁边的推荐栏或留白），底边与字幕块底边对齐
 * 3. 字幕块右侧 / 左侧（全屏时播放器占满屏幕，只能放在画面内字幕旁边）
 * 都放不下（窗口极小）返回 null，交回默认定位。
 */
export function placeAroundCaptions(
  word: Pick<DOMRect, 'left' | 'width'>,
  block: Box,
  player: Box,
  card: { width: number; height: number },
  vp: { width: number; height: number },
): CardPlacement | null {
  const g = CARD_GAP;
  const { width: cw, height: ch } = card;
  const clampX = (x: number) => Math.min(Math.max(g, x), Math.max(g, vp.width - cw - g));
  const clampY = (y: number) => Math.min(Math.max(g, y), Math.max(g, vp.height - ch - g));
  const aboveTop = block.top - g - ch;
  if (aboveTop >= g) return { top: aboveTop, left: clampX(word.left + word.width / 2 - cw / 2), above: true };
  // 侧边：垂直方向让卡片底边与字幕块底边对齐（尽量靠近单词），水平方向与字幕块（或播放器）不重叠即可
  const sideTop = clampY(block.bottom - ch);
  const sides = [player.right + g, player.left - g - cw, block.right + g, block.left - g - cw];
  for (const left of sides) {
    if (left >= g && left + cw <= vp.width - g) return { top: sideTop, left, above: false };
  }
  return null;
}
