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
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--lang=zh-CN'],
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

// 2) 手机（Edge for Android 尺寸）：文章、点按卡片、popup
{
  const b = await launch(MOBILE, { books: { enabled: ['cet6', 'gre'] } });
  const page = await b.ctx.newPage();
  await page.goto(`${base}/article.html`);
  await page.waitForTimeout(3000);
  await snap(page, 'mobile-article');
  const mark = await pickMark(page, 'anticipate');
  await mark.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await mark.tap();
  await page.waitForTimeout(900);
  await snap(page, 'mobile-card');
  const tabId = await b.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url());
  const popup = await b.ctx.newPage();
  await popup.goto(`chrome-extension://${b.extId}/popup.html?tabId=${tabId}`);
  await popup.waitForTimeout(1200);
  await snap(popup, 'mobile-popup');
  await b.close();
}

server.close();
console.log(JSON.stringify(shots, null, 2));
