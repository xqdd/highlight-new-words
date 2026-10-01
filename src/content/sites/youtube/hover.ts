import { TAG_CARD_HOST } from '../../engine/dom';
import type { SiteContext } from '../types';
import { CAPTION_SEGMENT_CLASS, CHROME_BOTTOM_CLASS, PLAYER_ID, captionWindows, getPlayer } from './dom';
import type { PauseController } from './playback';

/** 离开字幕与卡片多久后恢复播放（ms） */
export const RESUME_DELAY = 300;
/** 字幕热区外扩（px）：字幕段之间的空隙、行间距都算在字幕上 */
const HOT_PAD = 6;
/** 暂停后 YouTube 显示控件，字幕整体上移约 70px（实测 494 → 424）；热区向下补上这段，覆盖上移前后两个位置 */
const CONTROLS_SHIFT = 80;
/** 暂停后这段时间内，落在“上移前位置”里的点击不交给控件（避免点到刚出现在指针下的进度条） */
const MISCLICK_GUARD_MS = 800;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const inBox = (b: Box, x: number, y: number) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

/** 当前主播放器字幕段的包围盒（外扩 HOT_PAD）；没有字幕时为 null */
export function captionBox(doc: Document): Box | null {
  let box: Box | null = null;
  for (const w of captionWindows(doc)) {
    for (const seg of w.querySelectorAll(`.${CAPTION_SEGMENT_CLASS}`)) {
      const r = seg.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      box = box
        ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
  }
  return box && { left: box.left - HOT_PAD, top: box.top - HOT_PAD, right: box.right + HOT_PAD, bottom: box.bottom + HOT_PAD };
}

/**
 * 桌面“悬停字幕自动暂停”（settings.youtube.hoverPause，默认关）：
 *
 * - 鼠标进入主播放器字幕即暂停（只在视频播放中，且不在广告中）。控件自动隐藏时，字幕上方压着一层不可见的控件层，
 *   elementFromPoint 命中不到字幕，所以用几何判断：pointermove（rAF 节流）时比较指针与字幕段的包围盒
 * - 暂停后记下当时的字幕位置并向下补 CONTROLS_SHIFT：热区 = 暂停时位置 ∪ 当前字幕位置 ∪ 卡片 ∪ 字幕面板
 * - 指针离开热区 300ms 后恢复播放；只恢复由我们发起的暂停（PauseController），期间用户自己操作过播放/暂停就不再恢复
 * - 防误点：暂停后 MISCLICK_GUARD_MS 内，落在暂停时字幕位置、却点在控件栏（进度条）上的按下/点击被吞掉
 * 悬停生词弹卡片由通用卡片触发逻辑负责（暂停后字幕稳定在控件上方，可以正常命中）。
 */
export class HoverPause {
  private enabled = false;
  private pausedBox: Box | null = null;
  private pausedAt = 0;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  private raf = 0;
  /** 最近一次移动（composedPath 只在派发期间有效，必须在事件回调里取出） */
  private lastMove: { x: number; y: number; path: EventTarget[]; } | null = null;

  constructor(
    private readonly ctx: SiteContext,
    private readonly pause: PauseController,
    /** 字幕面板打开时不因离开字幕而恢复（面板关闭时自行恢复） */
    private readonly panelHost: () => HTMLElement | null,
    private readonly panelOpen: () => boolean,
  ) {}

  /** 按设置与设备启停（设置变化时调用）；触屏设备不启用 */
  sync(): void {
    const s = this.ctx.getSettings();
    const want =
      this.ctx.isActive() && s.youtube.hoverPause && typeof matchMedia === 'function' && !matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (want === this.enabled) return;
    this.enabled = want;
    const doc = this.ctx.doc;
    if (want) {
      doc.addEventListener('pointermove', this.onMove, { capture: true, passive: true });
      doc.addEventListener('pointerdown', this.onDown, true);
      doc.addEventListener('mousedown', this.onDown, true);
      doc.addEventListener('click', this.onDown, true);
    } else {
      doc.removeEventListener('pointermove', this.onMove, true);
      doc.removeEventListener('pointerdown', this.onDown, true);
      doc.removeEventListener('mousedown', this.onDown, true);
      doc.removeEventListener('click', this.onDown, true);
      cancelAnimationFrame(this.raf);
      clearTimeout(this.leaveTimer);
      // 关闭开关时不再自动恢复
      if (this.pausedBox) this.pause.release();
      this.pausedBox = null;
    }
  }

  destroy(): void {
    const doc = this.ctx.doc;
    doc.removeEventListener('pointermove', this.onMove, true);
    doc.removeEventListener('pointerdown', this.onDown, true);
    doc.removeEventListener('mousedown', this.onDown, true);
    doc.removeEventListener('click', this.onDown, true);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.leaveTimer);
    this.enabled = false;
    this.pausedBox = null;
  }

  private readonly onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    this.lastMove = { x: e.clientX, y: e.clientY, path: e.composedPath() };
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.lastMove) this.check(this.lastMove);
    });
  };

  /** 当前指针是否在热区内 */
  private inHotZone(m: NonNullable<HoverPause['lastMove']>): boolean {
    const { x, y } = m;
    const live = captionBox(this.ctx.doc);
    if (live && inBox(live, x, y)) return true;
    if (this.pausedBox && inBox(this.pausedBox, x, y)) return true;
    const card = this.ctx.getCard();
    if (card?.isOpen && m.path.some((n) => n instanceof Element && n.tagName === TAG_CARD_HOST.toUpperCase())) return true;
    const panel = this.panelHost();
    return !!panel && m.path.includes(panel);
  }

  private check(m: NonNullable<HoverPause['lastMove']>): void {
    const doc = this.ctx.doc;
    if (!this.pausedBox) {
      // 只处理主播放器范围内的移动
      const player = getPlayer(doc);
      if (!player || !m.path.includes(player)) return;
      const live = captionBox(doc);
      if (!live || !inBox(live, m.x, m.y)) return;
      if (!this.pause.pause()) return;
      this.pausedAt = performance.now();
      this.pausedBox = { ...live, bottom: live.bottom + CONTROLS_SHIFT };
      return;
    }
    if (!this.pause.pausedByUs) {
      // 用户期间自己点了播放/暂停：交还控制权
      this.pausedBox = null;
      clearTimeout(this.leaveTimer);
      return;
    }
    if (this.inHotZone(m) || this.panelOpen()) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = undefined;
      return;
    }
    if (this.leaveTimer === undefined) {
      this.leaveTimer = setTimeout(() => {
        this.leaveTimer = undefined;
        if (!this.pausedBox || this.panelOpen()) return;
        this.pausedBox = null;
        this.pause.resume();
      }, RESUME_DELAY);
    }
  }

  /** 防误点：暂停后不久、点在“字幕原位置”上的控件栏（进度条等）时吞掉事件 */
  private readonly onDown = (e: Event) => {
    const box = this.pausedBox;
    if (!box || performance.now() - this.pausedAt > MISCLICK_GUARD_MS) return;
    const me = e as MouseEvent;
    if (!inBox(box, me.clientX, me.clientY)) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t?.closest(`#${PLAYER_ID} .${CHROME_BOTTOM_CLASS}`)) return;
    e.preventDefault();
    e.stopPropagation();
  };
}
