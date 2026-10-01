import { BALL_SIZE, EDGE_GAP } from './model';

/**
 * 悬浮球与页内面板的样式（注入各自的 Shadow DOM，不受页面 CSS 影响也不污染页面）。
 *
 * 颜色只由变量驱动：浅色/深色两套（`:host([data-theme=dark])` 由脚本按网页背景亮度设置，与单词卡片同一判定，见 host.ts setTheme），
 * --accent 取当前高亮主题的卡片强调色（与单词卡片一致）。触控目标 ≥ 44px。
 */
export const BASE_CSS = `
:host { all: initial; }
.ui {
  --bg: #ffffff; --fg: #1f2328; --muted: #646b75; --line: rgba(15, 23, 42, .09); --soft: #f3f4f6; --hover: rgba(15, 23, 42, .05);
  --accent: #2563eb; --accent-fg: #fff; --accent-soft: color-mix(in srgb, var(--accent) 12%, var(--bg));
  --ok: #16a34a; --warn: #d97706; --err: #dc2626; --busy: #2563eb;
  --shadow: 0 16px 40px -12px rgba(15, 23, 42, .35), 0 2px 8px rgba(15, 23, 42, .12);
  --gloss: #b45309;
}
:host([data-theme=dark]) .ui {
  --bg: #1f2125; --fg: #e8eaed; --muted: #9aa0a6; --line: rgba(255, 255, 255, .10); --soft: #2a2d32; --hover: rgba(255, 255, 255, .06);
  --accent-soft: color-mix(in srgb, var(--accent) 22%, var(--bg));
  --shadow: 0 16px 40px -10px rgba(0, 0, 0, .7), 0 0 0 1px rgba(255, 255, 255, .05);
  --gloss: #f5c26b;
}
* { box-sizing: border-box; }
.ui {
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  color: var(--fg); letter-spacing: normal; text-align: left; -webkit-tap-highlight-color: transparent; -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
svg { display: block; flex: none; }
[hidden] { display: none !important; }

/* ---------- 底部抽屉（手机）---------- */
.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .28); opacity: 0; transition: opacity .18s; pointer-events: auto; }
.scrim.in { opacity: 1; }
.sheet {
  position: fixed; left: 0; right: 0; bottom: 0; margin: 0 auto; width: 100%; max-width: 520px;
  /* 百分比相对宿主（= 屏幕可见区域，见 host.ts）；vh 会随被撑宽的布局视口变化 */
  max-height: min(78%, 640px); display: flex; flex-direction: column;
  background: var(--bg); border-radius: 18px 18px 0 0; box-shadow: var(--shadow);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transform: translateY(100%); transition: transform .22s cubic-bezier(.2, .8, .2, 1); pointer-events: auto; overflow: hidden;
}
.sheet.in { transform: none; }
.grab { flex: none; height: 20px; display: flex; align-items: center; justify-content: center; touch-action: none; cursor: grab; }
.grab::before { content: ""; width: 36px; height: 4px; border-radius: 2px; background: var(--line); filter: contrast(2); }
.head { flex: none; display: flex; align-items: center; gap: 8px; padding: 0 8px 6px 16px; }
.head .title { flex: 1; min-width: 0; font-weight: 600; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .sub { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 6px; }
.icon-btn { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
.icon-btn:active, .icon-btn:hover { background: var(--hover); color: var(--fg); }
.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 12px 12px; }
.btn {
  min-height: 44px; padding: 0 16px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--soft); font-weight: 500; white-space: nowrap;
}
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn.small { min-height: 36px; padding: 0 12px; border-radius: 10px; font-size: 13px; }
.btn:disabled { opacity: .45; cursor: default; }
.toast {
  position: fixed; left: 16px; right: 16px; margin: 0 auto; width: fit-content; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); transform: translateY(8px); opacity: 0;
  max-width: 480px; display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 16px; border-radius: 12px;
  background: #1f2328; color: #fff; box-shadow: var(--shadow); transition: opacity .16s, transform .16s; pointer-events: auto; font-size: 14px;
}
.toast.in { opacity: 1; transform: none; }
.toast.up { bottom: auto; top: calc(16px + env(safe-area-inset-top, 0px)); }
.toast span { flex: 1; min-width: 0; }
.toast button { flex: none; white-space: nowrap; color: #8ab4f8; font-weight: 600; min-height: 36px; padding: 0 8px; }
`;

export const FLOAT_CSS = `
${BASE_CSS}
/* ---------- 悬浮球 ---------- */
.ball {
  position: fixed; top: 0; left: 0; width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
  background: var(--bg); color: var(--accent); box-shadow: 0 6px 18px -4px rgba(15, 23, 42, .35), 0 0 0 1px var(--line);
  transition: transform .25s cubic-bezier(.2, .8, .2, 1), opacity .25s; will-change: transform;
}
.ball.dragging { transition: none; box-shadow: 0 12px 28px -6px rgba(15, 23, 42, .45), 0 0 0 1px var(--line); }
/* 空闲：缩成屏幕边缘的一条强调色小标签（图标在可见部分放不下，隐藏）。
   白色内描边 + 深色外阴影：深色页面上靠白边、浅色页面上靠阴影都能看清（缩放 0.62 后白边约 2px） */
.ball.idle {
  opacity: .92; background: var(--accent);
  box-shadow: inset 0 0 0 3px rgba(255, 255, 255, .92), 0 0 0 1px rgba(15, 23, 42, .28), 0 3px 10px rgba(0, 0, 0, .45);
}
.ball.idle svg { opacity: 0; }
.ball .badge {
  position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: var(--accent); color: var(--accent-fg); font: 600 11px/18px system-ui, sans-serif; text-align: center;
  box-shadow: 0 0 0 2px var(--bg);
}
.ball.left .badge { right: auto; left: -3px; }
.ball.idle .badge { display: none; }
.ball.picking { background: var(--accent); color: var(--accent-fg); box-shadow: 0 0 0 4px var(--accent-soft), 0 6px 18px -4px rgba(15, 23, 42, .35); }
.ball.off { color: var(--muted); }
.ball.off::after { content: ""; position: absolute; width: 26px; height: 2px; background: currentColor; transform: rotate(-45deg); border-radius: 1px; }

/* ---------- 菜单 ---------- */
.site { font-size: 12px; color: var(--muted); font-weight: 400; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 2px 0 12px; }
.tile {
  min-height: 64px; padding: 10px 12px; border-radius: 14px; background: var(--soft); display: flex; align-items: center; gap: 10px; text-align: left;
}
.tile .ic { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--accent); }
.tile b { display: block; font-weight: 600; font-size: 14px; }
.tile small { display: block; font-size: 12px; color: var(--muted); line-height: 1.35; }
.tile.on { background: var(--accent-soft); }
.tile.on .ic { background: var(--accent); color: var(--accent-fg); }
.top { flex: none; padding: 0 12px; }
.tabs { display: flex; gap: 4px; padding: 4px; margin: 0 0 8px; border-radius: 12px; background: var(--soft); }
.tab { flex: 1; min-height: 40px; border-radius: 9px; font-weight: 500; color: var(--muted); font-size: 14px; }
.tab[aria-selected=true] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 3px rgba(15, 23, 42, .12); }
.empty { padding: 28px 12px; text-align: center; color: var(--muted); font-size: 13px; }
.words { list-style: none; margin: 0; padding: 0; }
.word { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--line); }
.word:last-child { border-bottom: 0; }
.word .open { flex: 1; min-width: 0; min-height: 48px; display: flex; align-items: baseline; gap: 8px; padding: 6px 4px; text-align: left; }
.word .w { font-weight: 600; font-size: 15px; flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.word .m { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.word .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
.word .known { flex: none; min-height: 36px; padding: 0 10px; border-radius: 10px; font-size: 13px; color: var(--muted); border: 1px solid var(--line); }
.word .known:active { background: var(--hover); }
.group { margin: 0 0 14px; }
.group > h4 { margin: 0 0 6px; padding: 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .02em; }
.row { min-height: 52px; display: flex; align-items: center; gap: 12px; padding: 4px 4px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row .lbl { flex: 1; min-width: 0; }
.row .lbl small { display: block; color: var(--muted); font-size: 12px; }
.switch { position: relative; width: 48px; height: 28px; flex: none; border-radius: 14px; background: var(--line); transition: background .15s; filter: none; }
:host(:not([data-theme=dark])) .switch { background: #d5d9df; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: transform .15s; }
.switch[aria-checked=true] { background: var(--accent) !important; }
.switch[aria-checked=true]::after { transform: translateX(20px); }
.seg { display: flex; gap: 4px; padding: 3px; border-radius: 11px; background: var(--soft); }
.seg button { flex: 1; min-height: 38px; border-radius: 8px; font-size: 13px; color: var(--muted); white-space: nowrap; }
.seg button[aria-pressed=true] { background: var(--bg); color: var(--fg); font-weight: 600; box-shadow: 0 1px 3px rgba(15, 23, 42, .14); }
.chips { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 6px; scrollbar-width: none; scroll-snap-type: x proximity; }
.chips::-webkit-scrollbar { display: none; }
.chip {
  flex: none; min-height: 40px; padding: 0 12px; border-radius: 20px; border: 1px solid var(--line); display: inline-flex; align-items: center; gap: 8px;
  font-size: 13px; white-space: nowrap; scroll-snap-align: start; background: var(--bg);
}
.chip[aria-pressed=true] { border-color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.chip .sw { font-weight: 600; padding: 0 2px; line-height: 1.3; }
.chip .n { color: var(--muted); font-weight: 400; font-size: 12px; }
.foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px 10px; border-top: 1px solid var(--line); }
.sync { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 6px; border-radius: 10px; text-align: left; }
.sync .st { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
.sync .st.ok { background: var(--ok); } .sync .st.warn, .sync .st.pending, .sync .st.never { background: var(--warn); }
.sync .st.error { background: var(--err); } .sync .st.busy { background: var(--busy); animation: pulse 1s infinite alternate; }
.sync .tx { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@keyframes pulse { to { opacity: .35; } }
.hide-menu { display: grid; gap: 6px; padding: 8px 0 4px; }

/* ---------- 取词模式 ---------- */
.pickbar {
  position: fixed; top: calc(10px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 14px; border-radius: 24px; pointer-events: auto;
  background: var(--accent); color: var(--accent-fg); box-shadow: var(--shadow); font-size: 13px; font-weight: 500; white-space: nowrap;
}
.pickbar button { min-height: 36px; padding: 0 12px; border-radius: 18px; background: rgba(255, 255, 255, .22); font-weight: 600; }
.pickbox {
  position: fixed; pointer-events: none; border-radius: 4px; background: color-mix(in srgb, var(--accent) 24%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 70%, transparent); color: transparent; overflow: hidden; white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) { .ball, .sheet, .scrim, .toast { transition: none; } }
`;

/** 空闲时缩小到的比例（46px → 约 28px） */
export const IDLE_SCALE = 0.62;
/**
 * 空闲时露出屏幕的宽度（px）：至少 20px 才容易被发现、好点按（13px 时评审反馈难以发现）。
 * 手机网页正文左右一般留 16px 边距，露出部分会压到正文行尾 4px 左右，球是半透明圆头标签，可接受
 */
export const IDLE_VISIBLE = 20;

/**
 * 球在一侧贴边时的 x（transform 平移量，缩放以球心为原点）：展开时离边缘 EDGE_GAP；
 * 空闲时缩小并大半移出屏幕，只露出 IDLE_VISIBLE 宽的一条（仍可点按，点按后展开并执行）。
 */
export function ballX(side: 'left' | 'right', viewportW: number, idle: boolean): number {
  if (!idle) return side === 'left' ? EDGE_GAP : viewportW - BALL_SIZE - EDGE_GAP;
  const d = BALL_SIZE * IDLE_SCALE;
  // 缩放后可见圆的圆心：右侧为 viewportW - 露出宽度 + 半径，左侧对称
  const center = side === 'left' ? IDLE_VISIBLE - d / 2 : viewportW - IDLE_VISIBLE + d / 2;
  return center - BALL_SIZE / 2;
}
