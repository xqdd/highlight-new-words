import { browser } from 'wxt/browser';
import type { Settings } from '@/core/settings/schema';
import { isSiteDisabled } from '@/core/settings/store';
import { STORAGE_KEYS } from '@/core/storage/keys';
import { h } from '../card/h';
import type { SiteContext } from '../sites/types';
import { ballX, FLOAT_CSS, IDLE_SCALE } from './css';
import { createOverlayHost, type OverlayHost } from './host';
import { svgIcon } from './icons';
import { FloatMenu, openOptionsPage } from './menu';
import { BALL_SIZE, clampCenterY, dragAimPoint, fromFrameLocal, hostMatches, isTouchPrimary, parsePos, snapPosition, type FloatBallPos } from './model';
import { PickMode, type PickHit } from './pick';
import { availableFloatActions, followFullscreen, setFloatMenuOpener } from './registry';

export { registerFloatAction, openFloatMenu, overlayRoot, relocateOverlayHosts } from './registry';
export type { FloatAction } from './registry';

/** 宿主标签名（engine 不进入 Shadow DOM，无需额外跳过） */
export const TAG_FLOAT_HOST = 'hnw-float-host';
/** 无操作多久后半隐藏（ms） */
const IDLE_MS = 3000;
/** 拖动判定阈值（px）：小于此位移视为点按 */
const DRAG_THRESHOLD = 6;
/** 角标刷新间隔（ms）：本页生词数随引擎增量处理变化 */
const BADGE_MS = 4000;
/** 隐藏悬浮球后保留宿主的时间（ms）：等带“撤销”的 toast（5 秒）播完 */
const RETIRE_MS = 5600;

/**
 * 通用悬浮球（v10）：只在触屏/手机端显示（(hover: none) and (pointer: coarse)，不看 UA），PC 端不显示。
 *
 * - 可拖动，松手吸附左右边缘；拖离边缘时球上方出现取词准星，松手时准星下有单词则打开该词卡片、球回原位（拖动取词），否则照常挪位置；3 秒无操作或页面滚动时缩小并移到屏幕边缘外，露出约 20px 一条（白色内描边 + 深色外阴影，深浅背景都看得见），点按仍直接生效
 * - 位置按设备记在 storage.local `floatBallPos`（侧边 + 视口高度比例），上下避开系统状态栏与手势条
 * - 点按：取词模式中 → 退出取词；站点有 primary 功能项（YouTube 视频页“当前字幕”）→ 直接执行；否则展开菜单（底部抽屉）
 * - 显示条件随设置（floatBall.enabled / hiddenSites）与媒体特性变化实时切换
 * - 全屏时宿主迁入全屏元素（见 registry.ts followFullscreen）
 */
export function startFloatBall(ctx: SiteContext): () => void {
  const doc = ctx.doc;
  const mql = typeof matchMedia === 'function' ? matchMedia('(hover: none) and (pointer: coarse)') : null;
  let ball: FloatBallView | null = null;
  let stopped = false;

  const shouldShow = (s: Settings) =>
    isTouchPrimary((q) => matchMedia(q).matches) && s.floatBall.enabled && !hostMatches(s.floatBall.hiddenSites, location.hostname);

  let retireTimer: ReturnType<typeof setTimeout> | undefined;
  const sync = () => {
    if (stopped || !doc.body) return;
    const s = ctx.getSettings();
    if (shouldShow(s)) {
      clearTimeout(retireTimer);
      retireTimer = undefined;
      ball ??= new FloatBallView(ctx);
      ball.setBallHidden(false);
      ball.refresh(s);
    } else if (ball && retireTimer === undefined) {
      // 刚在菜单里隐藏悬浮球时，带“撤销”的 toast 还在显示（同一个 Shadow DOM）：先只藏起球，toast 结束后再销毁；期间撤销则直接恢复
      ball.setBallHidden(true);
      retireTimer = setTimeout(() => {
        retireTimer = undefined;
        ball?.destroy();
        ball = null;
      }, RETIRE_MS);
    }
  };

  const stopFs = followFullscreen(doc);
  const unsub = ctx.onSettingsChange(sync);
  mql?.addEventListener?.('change', sync);
  // document_start 注入：等 body 出现后再挂
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();

  return () => {
    stopped = true;
    clearTimeout(retireTimer);
    unsub();
    stopFs();
    mql?.removeEventListener?.('change', sync);
    ball?.destroy();
    ball = null;
  };
}

/** 悬浮球视图 + 菜单 + 取词模式 */
class FloatBallView {
  private readonly overlay: OverlayHost;
  private readonly ball: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly menu: FloatMenu;
  private readonly pick: PickMode;
  private pos: FloatBallPos = parsePos(null);
  private idle = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private badgeTimer: ReturnType<typeof setInterval> | undefined;
  private suppressClickUntil = 0;
  private readonly offFrame: () => void;
  /** 拖动状态：dx/dy 为按下点相对球左上角的偏移；x0/y0 按下点（client）；cx/cy 最近一次指针位置（client，供 rAF 取词） */
  private drag: { id: number; dx: number; dy: number; x0: number; y0: number; cx: number; cy: number; moved: boolean } | null = null;
  /** 拖动取词的准星（球心上方，见 model.ts dragAimPoint） */
  private readonly aim: HTMLElement;
  /** 准星取词的 rAF 句柄：pointermove 很密，取词（caretRangeFromPoint + 布局读取）每帧最多一次 */
  private aimRaf = 0;

  constructor(private readonly ctx: SiteContext) {
    const doc = ctx.doc;
    this.overlay = createOverlayHost(doc, TAG_FLOAT_HOST, FLOAT_CSS);
    this.badge = h(doc, 'span', { class: 'badge', hidden: true });
    this.ball = h(doc, 'button', { type: 'button', class: 'ball right', 'aria-label': '生词高亮：打开菜单' }, svgIcon(doc, 'logo', 24), this.badge);
    this.aim = h(doc, 'span', { class: 'aim', hidden: true, 'aria-hidden': 'true' });
    this.overlay.ui.append(this.aim, this.ball);
    this.pick = new PickMode(ctx, this.overlay, (on) => {
      this.ball.classList.toggle('picking', on);
      this.ball.setAttribute('aria-label', on ? '退出取词模式' : '生词高亮：打开菜单');
      this.wake();
    });
    // 长按选词直接查词：与悬浮球同生命周期（只在触屏显示悬浮球时启用）
    this.pick.enableLongPress();
    this.menu = new FloatMenu({
      ctx,
      overlay: this.overlay,
      isPicking: () => this.pick.active,
      togglePick: () => (this.pick.active ? this.pick.exit() : this.pick.enter()),
      openOptions: (hash) =>
        void openOptionsPage(hash).then((ok) => {
          if (!ok) this.overlay.toast('请从浏览器菜单的“扩展”中打开生词高亮的设置');
        }),
      onHidden: () => {},
    });
    setFloatMenuOpener(() => this.menu.open());
    this.bindDrag();
    this.offFrame = this.overlay.onFrameChange(() => this.place());
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    void browser.storage.local.get(STORAGE_KEYS.floatBallPos).then((r) => {
      this.pos = parsePos(r[STORAGE_KEYS.floatBallPos]);
      this.place();
    });
    this.place();
    this.wake();
    this.badgeTimer = setInterval(() => this.updateBadge(), BADGE_MS);
  }

  /** 只藏起球本身（菜单、toast 仍可显示） */
  setBallHidden(hidden: boolean): void {
    this.ball.hidden = hidden;
    if (hidden) this.pick.exit();
  }

  refresh(s: Settings): void {
    this.overlay.ensureMounted();
    this.overlay.setTheme(s);
    const active = s.enabled && !isSiteDisabled(s, location.hostname);
    this.ball.classList.toggle('off', !active);
    this.updateBadge();
    this.menu.refresh();
  }

  destroy(): void {
    clearTimeout(this.idleTimer);
    clearInterval(this.badgeTimer);
    cancelAnimationFrame(this.aimRaf);
    this.offFrame();
    window.removeEventListener('scroll', this.onScroll, true);
    this.pick.destroy();
    this.menu.close();
    setFloatMenuOpener(null);
    this.overlay.destroy();
  }

  private updateBadge(): void {
    const n = this.ctx.isActive() ? this.ctx.pageLemmas().length : 0;
    this.badge.hidden = n === 0;
    this.badge.textContent = n > 99 ? '99+' : String(n);
  }

  // ---------------- 位置 ----------------

  /** x/y：宿主局部坐标（拖动中）；不传则按记忆的位置贴边。宽高取屏幕可见区域（见 host.ts），页面横向溢出或双指缩放时球仍在屏幕边缘 */
  private place(x?: number, y?: number): void {
    const { width: vw, height: vh } = this.overlay.frame();
    const left = x ?? ballX(this.pos.side, vw, this.idle);
    const top = (y ?? clampCenterY(this.pos.y, vh)) - (y === undefined ? BALL_SIZE / 2 : 0);
    // 空闲时缩小（以球心为原点）：拖动中与展开状态不缩放
    const scale = this.idle && x === undefined ? ` scale(${IDLE_SCALE})` : '';
    this.ball.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)${scale}`;
    this.ball.classList.toggle('left', this.pos.side === 'left');
    this.ball.classList.toggle('right', this.pos.side === 'right');
  }

  /** 有操作：展开到完整显示，3 秒后半隐藏（取词模式与菜单打开时不隐藏） */
  private wake(): void {
    clearTimeout(this.idleTimer);
    if (this.idle) {
      this.idle = false;
      this.ball.classList.remove('idle');
      this.place();
    }
    this.idleTimer = setTimeout(() => this.sleep(), IDLE_MS);
  }

  private sleep(): void {
    if (this.pick.active || this.menu.isOpen || this.drag) {
      this.idleTimer = setTimeout(() => this.sleep(), IDLE_MS);
      return;
    }
    this.idle = true;
    this.ball.classList.add('idle');
    this.place();
  }

  private readonly onScroll = () => {
    if (!this.idle && !this.pick.active && !this.drag) this.sleep();
  };

  // ---------------- 拖动与点按 ----------------

  private bindDrag(): void {
    const b = this.ball;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 拖动全程用宿主局部坐标（指针的 client 坐标先换算）
      const r = b.getBoundingClientRect();
      const p = this.overlay.toLocal(e.clientX, e.clientY);
      const r0 = this.overlay.toLocal(r.left, r.top);
      this.drag = { id: e.pointerId, dx: p.x - r0.x, dy: p.y - r0.y, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY, moved: false };
      b.setPointerCapture?.(e.pointerId);
    });
    b.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        b.classList.add('dragging');
        clearTimeout(this.idleTimer);
        this.idle = false;
        b.classList.remove('idle');
      }
      const { x, y } = this.dragBallXY(d, e.clientX, e.clientY);
      this.place(x, y);
      // 准星取词节流到 rAF：只记下最新指针位置，下一帧再取词与画预览框
      d.cx = e.clientX;
      d.cy = e.clientY;
      this.aimRaf ||= requestAnimationFrame(() => {
        this.aimRaf = 0;
        const cur = this.drag;
        if (cur?.moved) this.pick.preview(this.aimAt(cur, cur.cx, cur.cy));
      });
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      b.classList.remove('dragging');
      if (!d.moved) return;
      // 随后浏览器补发的 click 不当作点按
      this.suppressClickUntil = performance.now() + 400;
      cancelAnimationFrame(this.aimRaf);
      this.aimRaf = 0;
      // 松手位置重新取一次词（不等 rAF，避免用到上一帧的结果）；pointercancel（系统接管手势）不取词
      const hit = e.type === 'pointerup' ? this.aimAt(d, e.clientX, e.clientY) : null;
      this.aim.hidden = true;
      this.pick.preview(null);
      if (hit) {
        // 拖动取词：打开卡片，球回到拖动前的位置（不改记忆的位置）
        this.pick.openHit(hit);
        this.place();
        this.wake();
        return;
      }
      // 挪位置：吸附并记忆
      const { width: vw, height: vh } = this.overlay.frame();
      const p = this.overlay.toLocal(e.clientX, e.clientY);
      this.pos = snapPosition(p.x - d.dx + BALL_SIZE / 2, p.y - d.dy + BALL_SIZE / 2, vw, vh);
      this.place();
      void browser.storage.local.set({ [STORAGE_KEYS.floatBallPos]: this.pos });
      this.wake();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    // 点按走 click：触屏的 click 在 touchend 之后按点按位置重新命中，若在 pointerup 中就打开菜单，
    // 这次 click 会落到刚出现的遮罩上把菜单立即关掉。键盘（Enter/Space）也走这里
    b.addEventListener('click', () => {
      if (performance.now() < this.suppressClickUntil) return;
      this.onTap();
    });
  }

  /** 拖动中球左上角（宿主局部坐标，夹在屏幕内）：与指针保持按下时的相对偏移 */
  private dragBallXY(d: { dx: number; dy: number }, clientX: number, clientY: number): { x: number; y: number } {
    const { width: vw, height: vh } = this.overlay.frame();
    const p = this.overlay.toLocal(clientX, clientY);
    return { x: Math.min(vw - BALL_SIZE, Math.max(0, p.x - d.dx)), y: Math.min(vh - BALL_SIZE, Math.max(0, p.y - d.dy)) };
  }

  /**
   * 拖动取词：按指针位置算出球心与准星，摆放准星并返回准星下的单词。
   * 球心在贴边区（挪位置）或准星出了屏幕时隐藏准星、返回 null。
   */
  private aimAt(d: { dx: number; dy: number }, clientX: number, clientY: number): PickHit | null {
    const frame = this.overlay.frame();
    const { x, y } = this.dragBallXY(d, clientX, clientY);
    const aim = dragAimPoint(x + BALL_SIZE / 2, y + BALL_SIZE / 2, frame.width);
    this.aim.hidden = !aim;
    if (!aim) return null;
    this.aim.style.transform = `translate(${Math.round(aim.x)}px, ${Math.round(aim.y)}px)`;
    // 准星在宿主局部坐标中，换回 client 坐标后在页面上取词（宿主与准星都是 pointer-events:none，不挡命中）
    const c = fromFrameLocal(frame, aim.x, aim.y);
    const hit = this.pick.probeAt(c.x, c.y);
    this.aim.classList.toggle('hit', !!hit);
    return hit;
  }

  private onTap(): void {
    this.wake();
    if (this.pick.active) {
      this.pick.exit();
      return;
    }
    const primary = availableFloatActions().find((a) => a.primary);
    if (primary) primary.run();
    else this.menu.open();
  }
}
