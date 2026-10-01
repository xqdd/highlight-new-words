#!/usr/bin/env node
/**
 * 商店图片渲染：把 capture.mjs 截到的真实运行原图（store/images/raw/）套进 HTML 模板，
 * 用 Playwright 按商店要求的精确像素尺寸截图，输出到 store/images/。
 *
 * 用法：node store/scripts/render.mjs
 *
 * 尺寸依据（2026-10 查证，见 docs/release.md）：
 * - Chrome 网上应用店：截图 1280x800（1–5 张）、小宣传图 440x280（必填）、大宣传图 1400x560（可选）、商店图标 128x128（96 图形 + 16 透明边）
 * - Edge 加载项：截图 1280x800 或 640x480（最多 6 张）、徽标 1:1 建议 300x300（最小 128）、小宣传图 440x280、大宣传图 1400x560
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = path.join(ROOT, 'store/images/raw');
const OUT = path.join(ROOT, 'store/images');
// setContent 的页面是 about:blank，不能引用 file:// 图片，原图内联为 data URI
const raw = (name) => `data:image/png;base64,${fs.readFileSync(path.join(RAW, `${name}.png`)).toString('base64')}`;

/** 品牌图标（与 public/icons 一致的线框 “abc” 卡片），用 SVG 重绘以便放大不糊 */
const ICON_SVG = (color = '#1d9bf0') => `
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="10" y="22" width="96" height="70" rx="12"/>
  <path d="M22 104h82a14 14 0 0 0 14-14V40"/>
  <text x="58" y="70" text-anchor="middle" font-family="'Noto Sans', Arial, sans-serif" font-size="40" font-weight="500" fill="${color}" stroke="none">abc</text>
</svg>`;

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body { font-family: 'Noto Sans CJK SC', 'Noto Sans SC', 'Noto Sans', sans-serif; -webkit-font-smoothing: antialiased; }
  .mark { background: #fde68a; border-radius: 4px; padding: 0 4px; }
  .tr { color: #78716c; font-size: .7em; }
`;

/** 截图模板：顶部标题条 + 浏览器窗口框住真实截图 */
function shotPage({ title, sub, body }) {
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}
  body { background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 55%, #fde68a 100%); padding: 34px 64px 0; }
  h1 { font-size: 40px; font-weight: 800; color: #1c1917; letter-spacing: .5px; }
  p.sub { margin-top: 8px; font-size: 22px; color: #57534e; }
  .win { margin-top: 26px; height: 606px; border-radius: 14px 14px 0 0; overflow: hidden; background: #fff;
         box-shadow: 0 20px 50px rgba(120, 53, 15, .22), 0 0 0 1px rgba(0,0,0,.06); position: relative; }
  .bar { height: 34px; background: #f5f5f4; border-bottom: 1px solid #e7e5e4; display: flex; align-items: center; gap: 8px; padding: 0 14px; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; background: #d6d3d1; display: block; }
  .bar .url { margin-left: 16px; flex: 1; height: 22px; border-radius: 11px; background: #fff; border: 1px solid #e7e5e4; }
  .bar .ext { width: 22px; height: 22px; }
  .view { position: absolute; top: 34px; left: 0; right: 0; bottom: 0; overflow: hidden; }
  .view > img.page { width: 100%; display: block; }
  .popup { position: absolute; top: 0; right: 18px; width: 380px; border-radius: 0 0 12px 12px; overflow: hidden;
           box-shadow: 0 16px 40px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.08); }
  .popup img { width: 100%; display: block; }
  </style>
  <h1>${title}</h1><p class="sub">${sub}</p>
  <div class="win"><div class="bar"><i></i><i></i><i></i><div class="url"></div><div class="ext">${ICON_SVG()}</div></div>
  <div class="view">${body}</div></div>`;
}

/** 手机三连图模板 */
function phonesPage({ title, sub, shots }) {
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}
  body { background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 55%, #fde68a 100%); padding: 34px 64px 0; }
  h1 { font-size: 40px; font-weight: 800; color: #1c1917; }
  p.sub { margin-top: 8px; font-size: 22px; color: #57534e; }
  .row { margin-top: 30px; display: flex; justify-content: center; gap: 56px; }
  .phone { width: 300px; height: 650px; border-radius: 40px; background: #1c1917; padding: 12px; box-shadow: 0 20px 50px rgba(120,53,15,.25); }
  .phone div { width: 100%; height: 100%; border-radius: 30px; overflow: hidden; background: #fff; }
  .phone img { width: 100%; display: block; }
  </style>
  <h1>${title}</h1><p class="sub">${sub}</p>
  <div class="row">${shots.map((s) => `<div class="phone"><div><img src="${raw(s)}"></div></div>`).join('')}</div>`;
}

// 顺序即商店展示顺序：Chrome 最多 5 张（取 1–5），Edge 最多 6 张（全部上传）
const SCREENSHOTS = {
  zh: [
    ['1-card', { title: '网页上的生词，一眼就能看到', sub: '悬停、按住修饰键或点击查看音标、释义与词形；认识了就一键标为熟词', body: `<img class="page" src="${raw('desktop-card')}">` }],
    ['2-inline', { title: '行内释义，不打断阅读', sub: '在生词后或上方显示简短中文释义，可随时切换或关闭', body: `<img class="page" src="${raw('desktop-inline')}">` }],
    ['3-youtube', { title: 'YouTube 字幕里的生词也标出来', sub: '字幕上方显示释义；Alt+L 暂停并打开当前字幕面板，逐句查词', body: `<img class="page" src="${raw('desktop-yt-panel')}">` }],
    ['4-mobile', { phones: true, title: '手机上也能用', sub: 'Edge for Android：点按生词弹出底部卡片；悬浮球查看本页生词、快捷设置', shots: ['mobile-article', 'mobile-card', 'mobile-menu'] }],
    ['5-popup', { title: '本页生词一览', sub: '工具栏弹窗：开关本站高亮、切换词书、查看本页生词与同步状态', body: `<img class="page" src="${raw('desktop-article')}"><div class="popup"><img src="${raw('desktop-popup')}"></div>` }],
    ['6-style', { title: '分级词书 + 多种高亮样式', sub: '四六级、考研、雅思、托福、GRE、CEFR 分级与词频书，也可同步有道 / 欧路生词本', body: `<img class="page" src="${raw('desktop-options-appearance')}">` }],
  ],
  en: [
    ['1-card', { title: 'Spot unfamiliar words at a glance', sub: 'Hover, hold a modifier key or click for phonetics, meaning and word forms', body: `<img class="page" src="${raw('desktop-card')}">` }],
    ['2-inline', { title: 'Inline translations that keep you reading', sub: 'Short Chinese glosses after or above each word, switchable any time', body: `<img class="page" src="${raw('desktop-inline')}">` }],
    ['3-youtube', { title: 'New words in YouTube captions, too', sub: 'Glosses above the captions; Alt+L pauses and opens the current-caption panel', body: `<img class="page" src="${raw('desktop-yt-panel')}">` }],
    ['4-mobile', { phones: true, title: 'Works on mobile too', sub: 'Edge for Android: tap for a bottom card; the floating button lists page words and quick settings', shots: ['mobile-article', 'mobile-card', 'mobile-menu'] }],
    ['5-popup', { title: 'All new words on this page', sub: 'Toolbar popup: toggle per site, switch word books, review page words and sync status', body: `<img class="page" src="${raw('desktop-article')}"><div class="popup"><img src="${raw('desktop-popup')}"></div>` }],
    ['6-style', { title: 'Graded word books, many highlight styles', sub: 'CET, IELTS, TOEFL, GRE, CEFR levels and frequency lists, or sync your Youdao / Eudic word book', body: `<img class="page" src="${raw('desktop-options-appearance')}">` }],
  ],
};

/** 宣传图：只放图标、产品名与高亮示意（Chrome 建议少文字、饱和色、铺满） */
function promoPage({ w, h, big }) {
  const s = h / 280;
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}
  body { width: ${w}px; height: ${h}px; background: linear-gradient(135deg, #f59e0b 0%, #ea580c 60%, #c2410c 100%);
         display: flex; align-items: center; justify-content: ${big ? 'space-between' : 'center'}; padding: 0 ${big ? 120 : 0}px; position: relative; }
  .brand { display: flex; flex-direction: column; align-items: ${big ? 'flex-start' : 'center'}; gap: ${14 * s}px; }
  .logo { width: ${96 * s}px; height: ${96 * s}px; background: #fff; border-radius: ${22 * s}px; padding: ${12 * s}px; box-shadow: 0 ${8 * s}px ${24 * s}px rgba(0,0,0,.18); }
  .name { color: #fff; font-size: ${34 * s}px; font-weight: 800; letter-spacing: ${2 * s}px; text-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .tag { color: #fff7ed; font-size: ${15 * s}px; opacity: .95; }
  .demo { background: #fff; border-radius: 18px; padding: 34px 40px; font-family: Georgia, 'Noto Serif', serif; font-size: 34px; line-height: 1.9; color: #292524;
          width: 680px; box-shadow: 0 20px 50px rgba(0,0,0,.2); }
  </style>
  <div class="brand"><div class="logo">${ICON_SVG()}</div><div class="name">生词高亮</div>${big ? '<div class="tag">让网页上的生词自己跳出来</div>' : ''}</div>
  ${big ? `<div class="demo">The storm <span class="mark">surge</span><span class="tr">(汹涌)</span> arrived earlier than <span class="mark">anticipated</span><span class="tr">(预期)</span>, and the <span class="mark">barriers</span><span class="tr">(障碍物)</span> were no longer enough.</div>` : ''}`;
}

function iconPage(size, padding) {
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS} html,body{background:transparent} body{padding:${padding}px}</style>${ICON_SVG()}`;
}

const browser = await chromium.launch();
const render = async (html, w, h, file, transparent = false) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, file), omitBackground: transparent });
  await page.close();
  console.log(file);
};

for (const [lang, list] of Object.entries(SCREENSHOTS)) {
  // 先清空目录，避免改名或删减后留下旧截图被误传到商店
  fs.rmSync(path.join(OUT, `screenshots-${lang}`), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, `screenshots-${lang}`), { recursive: true });
  for (const [name, spec] of list) {
    await render(spec.phones ? phonesPage(spec) : shotPage(spec), 1280, 800, `screenshots-${lang}/${name}.png`);
  }
}
await render(promoPage({ w: 440, h: 280 }), 440, 280, 'promo-small-440x280.png');
await render(promoPage({ w: 1400, h: 560, big: true }), 1400, 560, 'promo-marquee-1400x560.png');
// Chrome 商店图标：96x96 图形 + 四周 16px 透明边
await render(iconPage(128, 16), 128, 128, 'icon-store-128.png', true);
// Edge 徽标：1:1，建议 300x300
await render(iconPage(300, 30), 300, 300, 'logo-edge-300.png', true);
await browser.close();
