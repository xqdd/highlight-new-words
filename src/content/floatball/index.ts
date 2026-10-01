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
import { BALL_SIZE, clampCenterY, hostMatches, isTouchPrimary, parsePos, snapPosition, type FloatBallPos } from './model';
import { PickMode } from './pick';
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
 * - 可拖动，松手吸附左右边缘；3 秒无操作或页面滚动时缩小并移到屏幕边缘外，露出约 20px 一条（白色内描边 + 深色外阴影，深浅背景都看得见），点按仍直接生效
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
  private drag: { id: number; dx: number; dy: number; x0: number; y0: number; moved: boolean } | null = null;

  constructor(private readonly ctx: SiteContext) {
    const doc = ctx.doc;
    this.overlay = createOverlayHost(doc, TAG_FLOAT_HOST, FLOAT_CSS);
    this.badge = h(doc, 'span', { class: 'badge', hidden: true });
    this.ball = h(doc, 'button', { type: 'button', class: 'ball right', 'aria-label': '生词高亮：打开菜单' }, svgIcon(doc, 'logo', 24), this.badge);
    this.overlay.ui.appendChild(this.ball);
    this.pick = new PickMode(ctx, this.overlay.ui, this.overlay.host, (on) => {
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
    window.addEventListener('resize', this.onResize, { passive: true });
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
    window.removeEventListener('resize', this.onResize);
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

  private place(x?: number, y?: number): void {
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
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

  private readonly onResize = () => this.place();
  private readonly onScroll = () => {
    if (!this.idle && !this.pick.active && !this.drag) this.sleep();
  };

  // ---------------- 拖动与点按 ----------------

  private bindDrag(): void {
    const b = this.ball;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = b.getBoundingClientRect();
      this.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
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
      const vw = document.documentElement.clientWidth || innerWidth;
      const x = Math.min(vw - BALL_SIZE, Math.max(0, e.clientX - d.dx));
      const y = Math.min(innerHeight - BALL_SIZE, Math.max(0, e.clientY - d.dy));
      this.place(x, y);
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      b.classList.remove('dragging');
      if (!d.moved) return;
      // 拖动结束：吸附并记忆；随后浏览器补发的 click 不当作点按
      this.suppressClickUntil = performance.now() + 400;
      const vw = document.documentElement.clientWidth || innerWidth;
      this.pos = snapPosition(e.clientX - d.dx + BALL_SIZE / 2, e.clientY - d.dy + BALL_SIZE / 2, vw, innerHeight);
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
