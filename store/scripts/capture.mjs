#!/usr/bin/env node
/**
 * 商店截图素材采集：加载已构建的 chrome 产物（Chrome / Edge 共用），在 tests/fixtures 上真实运行并截原始图。
 * 原始图写到 store/images/raw/，再由 render.mjs 套模板生成商店要求的尺寸。
 *
 * 用法：
 *   OUT_DIR=/tmp/out npm run build
 *   node store/scripts/capture.mjs --ext /tmp/out/chrome-mv3 [--browser <Chrome/Edge 可执行文件>]
 *
 * --browser 不传时使用 Playwright 自带的 Chromium（品牌版 Chrome 137+ 不再支持 --load-extension；Edge 仍支持）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = path.join(ROOT, 'store/images/raw');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const extDir = path.resolve(arg('ext') ?? '.output/chrome-mv3');
const browserBin = arg('browser');
fs.mkdirSync(RAW, { recursive: true });

const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
// Edge for Android 的视口与 UA（与 scripts/qa/shot.mjs 一致）
const MOBILE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0',
};

function startFixtureServer() {
  const dir = path.join(ROOT, 'tests/fixtures');
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(204).end();
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 启动带扩展的浏览器，等后台初始化完设置后按 patch 深合并写入 */
async function launch(device, settingsPatch) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-store-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(browserBin ? { executablePath: browserBin } : { channel: 'chromium' }),
    // 自动播放策略放开：YouTube fixture 的视频需要无手势自动播放
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--lang=zh-CN', '--autoplay-policy=no-user-gesture-required'],
    locale: 'zh-CN',
    ...device,
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  await sw.evaluate(async (patch) => {
    for (let i = 0; i < 50 && !(await chrome.storage.local.get('settings')).settings; i++) await new Promise((r) => setTimeout(r, 100));
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    const merge = (a, b) => {
      if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object') return b === undefined ? a : b;
      const out = { ...a };
      for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
      return out;
    };
    await chrome.storage.local.set({ settings: merge(cur, patch ?? {}) });
  }, settingsPatch);
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId, close: async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

/** 选一个位于视口上部、适合展示卡片的高亮词 */
async function pickMark(page, lemma) {
  const h = await page.evaluateHandle((want) => {
    const ms = [...document.querySelectorAll('hnw-mark')];
    return ms.find((m) => m.getAttribute('data-lemma') === want) ?? ms.find((m) => m.getBoundingClientRect().top > 150) ?? ms[0];
  }, lemma);
  return h.asElement();
}

/**
 * YouTube 观看页：把 https://www.youtube.com/watch?v=store1 路由到离线 fixture（tests/fixtures/youtube-watch.html，按真实 DOM 结构模拟播放器与字幕）。
 * 商店图不展示真实视频内容：标题、简介、推荐位换成中性文字，字幕用下面自写的台词，视频是 ffmpeg 生成的渐变底色。
 */
const YT_CUES = [
  'Reading every day is the most reliable way to expand your vocabulary.',
  'At first the articles seem daunting, full of obscure words.',
  'But each new word becomes a little more familiar every time you meet it.',
  'Gradually the vocabulary that once looked formidable feels ordinary.',
].map((text, i) => ({ start: i * 6000, end: (i + 1) * 6000, text }));
const YT_VIDEO = path.join(os.tmpdir(), 'hnw-store-yt.webm');
if (!fs.existsSync(YT_VIDEO)) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=size=640x360:rate=10:c0=0x1e3a5f:c1=0x0f766e:c2=0x334155:speed=0.004', '-t', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libvpx', '-b:v', '200k', YT_VIDEO]);
}
function ytWatchHtml() {
  return fs.readFileSync(path.join(ROOT, 'tests/fixtures/youtube-watch.html'), 'utf8')
    .replace(/<title>[^<]*<\/title>/, '<title>Reading habits - YouTube</title>')
    // 无头 Chromium 解码出的画面常为纯黑：视频本身透明化，用渐变底色代替画面
    .replace('</style>', '#movie_player video { opacity: 0; } .html5-video-container { background: linear-gradient(135deg, #1e3a5f, #0f766e 60%, #334155); }</style>')
    .replace(/<div class="ytp-title">[^<]*<\/div>/, '<div class="ytp-title">Why reading builds vocabulary</div>')
    .replace(/<h1>[^<]*<\/h1>/, '<h1>Why reading builds vocabulary</h1>')
    .replace(/<div id="description">[^<]*<\/div>/, '<div id="description">A short talk about learning new words through everyday reading.</div>')
    .replace(/<span class="ytp-chapter-title-content">[^<]*<\/span>/, '<span class="ytp-chapter-title-content">Reading</span>')
    .replace(/(<div class="rec"><div class="thumb"><\/div><div>)[^<]*/g, '$1Learning English with subtitles');
}
async function routeYouTube(ctx) {
  const json3 = JSON.stringify({ events: YT_CUES.map((c) => ({ tStartMs: c.start, dDurationMs: c.end - c.start, segs: [{ utf8: c.text }] })) });
  await ctx.route(/^https:\/\/(www|m)\.youtube\.com\//, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/watch') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: ytWatchHtml() });
    if (u.pathname === '/youtube-cues.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ videoId: 'store1', cues: YT_CUES }) });
    if (u.pathname === '/yt-fixture.webm') {
      // 支持 Range，视频才能 seek
      const buf = fs.readFileSync(YT_VIDEO);
      const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] || '');
      if (!m) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: buf });
      const a = Number(m[1]); const e = m[2] ? Number(m[2]) : buf.length - 1;
      return route.fulfill({ status: 206, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${buf.length}` }, body: buf.subarray(a, e + 1) });
    }
    // 字幕轨：扩展的当前字幕面板会按播放器请求过的 timedtext 地址重新拉取
    if (u.pathname === '/api/timedtext') return route.fulfill({ status: 200, contentType: 'application/json', body: u.searchParams.get('pot') ? json3 : '' });
    return route.fulfill({ status: 404, body: '' });
  });
}

const server = await startFixtureServer();
const base = `http://127.0.0.1:${server.address().port}`;
const shots = [];
const snap = async (page, name, opts = {}) => {
  const file = path.join(RAW, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  shots.push(file);
};

// 1) 桌面：默认设置（六级词书）+ 悬停卡片；行内释义“词后”；选项页
{
  const b = await launch(DESKTOP, { books: { enabled: ['cet6', 'gre'] } });
  const page = await b.ctx.newPage();
  await page.goto(`${base}/article.html`);
  await page.waitForTimeout(3000);
  await snap(page, 'desktop-article');
  const mark = await pickMark(page, 'anticipate');
  await mark.hover();
  await page.waitForTimeout(900);
  await snap(page, 'desktop-card');

  // popup：以文章页为目标标签页，按真实 popup 宽度截取
  const tabId = await b.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
  const popup = await b.ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`chrome-extension://${b.extId}/popup.html?tabId=${tabId}`);
  await popup.waitForTimeout(1200);
  const box = await popup.locator('main').boundingBox();
  await snap(popup, 'desktop-popup', { clip: box ?? undefined });

  // 行内释义（词后）：直接改设置，内容脚本通过 storage.onChanged 即时生效
  await b.sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.inlineTranslation = { ...settings.inlineTranslation, mode: 'after' };
    await chrome.storage.local.set({ settings });
  });
  await page.bringToFront();
  await page.mouse.click(5, 790);
  await page.waitForTimeout(1500);
  await snap(page, 'desktop-inline');

  const opt = await b.ctx.newPage();
  for (const hash of ['books', 'appearance']) {
    await opt.goto(`chrome-extension://${b.extId}/options.html#${hash}`);
    await opt.waitForTimeout(1500);
    await snap(opt, `desktop-options-${hash}`);
  }
  await b.close();
}

// 2) 手机（Edge for Android 尺寸）：文章 + 悬浮球、点按卡片、悬浮球菜单（本页生词）
{
  const b = await launch(MOBILE, { books: { enabled: ['cet6', 'gre'] } });
  const page = await b.ctx.newPage();
  await page.goto(`${base}/article.html`);
  // 悬浮球空闲 3 秒后半隐藏，在此之前截图以展示完整的球
  await page.waitForTimeout(2200);
  await snap(page, 'mobile-article');
  const mark = await pickMark(page, 'anticipate');
  await mark.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await mark.tap();
  await page.waitForTimeout(900);
  await snap(page, 'mobile-card');
  // 点空白处收起卡片，再点悬浮球打开菜单（默认“本页生词”页签）
  await page.touchscreen.tap(20, 120);
  await page.waitForTimeout(600);
  const ball = await page.evaluate(() => {
    const r = document.querySelector('hnw-float-host')?.shadowRoot?.querySelector('.ball')?.getBoundingClientRect();
    return r ? { x: Math.min(385, r.x + r.width / 2), y: r.y + r.height / 2 } : null;
  });
  if (!ball) throw new Error('手机端未出现悬浮球');
  await page.touchscreen.tap(ball.x, ball.y);
  await page.waitForTimeout(1100);
  await snap(page, 'mobile-menu');
  await b.close();
}

// 3) YouTube（桌面）：字幕上方注解 + Alt+L 当前字幕面板
{
  const b = await launch(DESKTOP, { books: { enabled: ['cet6', 'gre'] } });
  await routeYouTube(b.ctx);
  const page = await b.ctx.newPage();
  await page.goto('https://www.youtube.com/watch?v=store1');
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(2500);
  // 跳到第 2 条字幕并暂停，字幕停留在画面上
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 7; });
  await page.waitForTimeout(1500);
  await snap(page, 'desktop-yt-captions');
  await page.keyboard.press('Alt+KeyL');
  await page.waitForTimeout(1500);
  const open = await page.evaluate(() => !!document.querySelector('hnw-yt-panel-host')?.shadowRoot?.querySelector('.panel.in'));
  if (!open) throw new Error('Alt+L 未打开当前字幕面板');
  await snap(page, 'desktop-yt-panel');
  await b.close();
}

server.close();
console.log(JSON.stringify(shots, null, 2));
