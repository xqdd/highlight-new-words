/**
 * 卡片样式（注入 Shadow DOM，不受页面 CSS 影响也不污染页面）。
 *
 * 颜色只由三个变量驱动：--bg / --fg / --accent（来自主题 CardStyle，暗色页面下由 card-view 换成暗色版本），
 * 其余层次色通过 color-mix 派生，保证任意主题色下对比度一致。
 * 两种布局：
 * - `.card.popover`：桌面贴词浮层，宽 340px，跟随单词定位
 * - `.card.sheet`：手机底部卡片（bottom sheet），近全宽、可下滑关闭，触控目标 ≥ 44px
 */
export const CARD_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.card {
  --muted: color-mix(in srgb, var(--fg) 58%, var(--bg));
  --line: color-mix(in srgb, var(--fg) 11%, var(--bg));
  --soft: color-mix(in srgb, var(--fg) 4.5%, var(--bg));
  --hover: color-mix(in srgb, var(--fg) 8%, transparent);
  --accent-soft: color-mix(in srgb, var(--accent) 13%, var(--bg));
  --accent-fg: #fff;
  --danger: #d93025;
  --hit: 32px;
  position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
  width: 340px; max-width: calc(100vw - 16px); max-height: min(460px, calc(100vh - 16px));
  background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 12px 32px -8px rgba(15, 23, 42, .28), 0 2px 6px rgba(15, 23, 42, .10);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  text-align: left; letter-spacing: normal; word-spacing: normal; text-transform: none; font-style: normal; font-weight: 400;
  -webkit-tap-highlight-color: transparent; -webkit-font-smoothing: antialiased; overflow: hidden;
  opacity: 0; transform: translateY(4px); transition: opacity .12s ease-out, transform .12s ease-out;
}
.card.dark { box-shadow: 0 12px 32px -6px rgba(0, 0, 0, .6), 0 0 0 1px rgba(255, 255, 255, .04); --danger: #ff6b5e; --accent-fg: #111; }
.card.above { transform: translateY(-4px); }
.card.in { opacity: 1; transform: none; }
.card[hidden] { display: none; }

/* ---------- 手机底部卡片 ---------- */
.card.sheet {
  --hit: 44px;
  left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); top: auto;
  width: auto; max-width: 560px; margin: 0 auto; max-height: min(72vh, 560px);
  border-radius: 18px; font-size: 15px;
  transform: translateY(24px); transition: opacity .18s ease-out, transform .2s cubic-bezier(.2, .8, .2, 1);
}
.card.sheet.in { transform: translateY(var(--drag, 0px)); }
.card.sheet.dragging { transition: none; }
.grab { display: none; }
.sheet .grab { display: flex; justify-content: center; padding: 8px 0 10px; touch-action: none; cursor: grab; }
.grab i { width: 36px; height: 4px; border-radius: 2px; background: var(--line); }

/* ---------- 头部 ---------- */
.head { padding: 10px 8px 10px 16px; border-bottom: 1px solid var(--line); flex: none; }
.sheet .head { padding: 0 8px 10px 18px; touch-action: pan-x; }
.row1 { display: flex; align-items: flex-start; gap: 2px; min-height: var(--hit); }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-right: auto; min-width: 0; padding-top: 2px; }
.word { font-size: 20px; font-weight: 700; line-height: 1.25; letter-spacing: -.005em; overflow-wrap: anywhere; }
.sheet .word { font-size: 22px; }
.phon {
  display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 10px 2px 8px;
  border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-size: 13px;
  font-family: "Lucida Sans Unicode", "Segoe UI", "Noto Sans", system-ui, sans-serif;
}
.phon:hover { color: var(--fg); background: var(--hover); }
.phon svg { width: 15px; height: 15px; flex: none; }
.sheet .phon { min-height: 44px; padding: 2px 14px 2px 12px; font-size: 14px; border-radius: 10px; }

button, a { font: inherit; color: inherit; background: none; border: 0; margin: 0; cursor: pointer; text-decoration: none; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.icon {
  width: var(--hit); height: var(--hit); flex: none; display: inline-grid; place-items: center;
  border-radius: 999px; color: var(--muted);
}
.icon:hover { color: var(--fg); background: var(--hover); }
.icon svg { width: 18px; height: 18px; }
.icon.on { color: var(--accent); }
.icon.on svg { fill: currentColor; }

/* ---------- 正文 ---------- */
.body { padding: 10px 16px 4px; overflow: auto; overscroll-behavior: contain; flex: 1 1 auto; min-height: 0; }
.sheet .body { padding: 12px 18px 4px; }
.form { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin-bottom: 8px; font-size: 13px; color: var(--muted); }
.form b { font-weight: 600; color: var(--fg); }
.form .rel { padding: 0 6px; border-radius: 4px; background: var(--soft); }
.defs { margin: 0; padding: 0; list-style: none; }
.defs li { margin: 0 0 4px; overflow-wrap: anywhere; }
.pos { color: var(--muted); margin-right: 6px; font-style: italic; font-size: .92em; }
.defs.clamp li:nth-child(n+4) { display: none; }
.more { color: var(--accent); font-size: 13px; padding: 2px 0; min-height: 28px; }
.sheet .more { min-height: 40px; }
.empty { color: var(--muted); font-size: 13px; }
.loading { display: block; height: 12px; width: 70%; margin: 6px 0; border-radius: 6px;
  background: linear-gradient(90deg, var(--soft), var(--line), var(--soft)); background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite; }
.loading.s { width: 45%; }
@keyframes shimmer { to { background-position: -200% 0; } }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 8px; }
.tag { font-size: 12px; line-height: 20px; padding: 0 8px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.tag.user { color: var(--fg); background: var(--soft); border: 1px solid var(--line); }

/* ---------- 底栏 ---------- */
.foot { flex: none; padding: 10px 12px 12px 16px; border-top: 1px solid var(--line); background: var(--soft); }
.sheet .foot { padding: 12px 14px 14px 18px; }
.actions { display: flex; gap: 8px; }
.btn {
  flex: 1 1 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 36px; padding: 6px 12px; border-radius: 10px; font-size: 14px; font-weight: 600; white-space: nowrap;
}
.sheet .btn { min-height: 44px; font-size: 15px; }
.btn svg { width: 17px; height: 17px; flex: none; }
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--fg)); }
.btn.ghost { color: var(--fg); background: var(--bg); border: 1px solid var(--line); }
.btn.ghost:hover { background: var(--hover); }
.btn.ghost.danger { color: var(--danger); }
.btn.ghost.confirm { color: #fff; background: var(--danger); border-color: var(--danger); }
.btn[disabled] { opacity: .6; cursor: progress; }
.links { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 4px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.links a { padding: 2px 6px; border-radius: 6px; color: var(--muted); }
.links a:hover { color: var(--accent); background: var(--hover); }
.sheet .links { font-size: 14px; margin-top: 6px; }
.sheet .links a { min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; }

/* ---------- toast（熟词撤销、操作结果） ---------- */
.toast {
  position: fixed; z-index: 2147483647; left: 16px; right: 16px; bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  display: flex; align-items: center; gap: 12px; width: fit-content; max-width: 440px; margin: 0 auto; min-height: 44px; padding: 6px 6px 6px 16px;
  border-radius: 12px; background: #1f2328; color: #f3f4f6; box-shadow: 0 8px 24px rgba(0,0,0,.28);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  transform: translateY(12px); opacity: 0; transition: opacity .16s ease-out, transform .16s ease-out;
}
.toast.in { transform: none; opacity: 1; }
.toast[hidden] { display: none; }
.toast .msg { flex: 1; overflow-wrap: anywhere; }
.toast button { min-height: 36px; min-width: 44px; padding: 0 12px; border-radius: 8px; color: #8ab4ff; font-weight: 600; }
.toast button:hover { background: rgba(255,255,255,.08); }
@media (pointer: coarse) { .toast button { min-height: 44px; } }

@media (prefers-reduced-motion: reduce) {
  .card, .card.sheet, .toast { transition: opacity .1s linear; transform: none !important; }
  .loading { animation: none; }
}
`;

/**
 * 页面级样式（注入到页面 <head>，只作用于当前打开卡片的单词）：用叠加渐变表示“激活”，
 * 不覆盖 engine 给 hnw-mark 设置的背景色/文字色。
 */
export const ACTIVE_MARK_CSS = `
hnw-mark[data-hnw-active] {
  background-image: linear-gradient(var(--hnw-active, rgba(37, 99, 235, .16)), var(--hnw-active, rgba(37, 99, 235, .16))) !important;
  border-radius: 3px;
  box-shadow: 0 0 0 2px var(--hnw-active, rgba(37, 99, 235, .16));
}
`;
