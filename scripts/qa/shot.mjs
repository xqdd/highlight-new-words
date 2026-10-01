#!/usr/bin/env node
/**
 * 共享视觉 QA 脚本：加载已构建的扩展（不负责构建），对本地 fixture / 线上页面 / popup / options 截图。
 *
 * 用法：
 *   node scripts/qa/shot.mjs --ext <扩展目录> [选项]
 *
 * 选项：
 *   --ext <dir>          已解包扩展目录（必填），如 .output/chrome-mv3 或 $OUT_DIR/chrome-mv3
 *   --out <dir>          截图输出目录（默认 /tmp/gauntlet/shots/qa）
 *   --pages <list>       fixture 名称，逗号分隔（tests/fixtures/<name>.html），默认 article,dark,dynamic；'none' 表示不截 fixture
 *   --url <url>          额外截一个线上页面（可重复传多次）
 *   --sizes <list>       mobile,desktop（默认两者）。mobile=390x844 触屏 DPR2；desktop=1280x800 DPR1
 *   --ui <list>          额外截扩展页面：popup,options（默认不截）；popup 会以第一个页面为目标标签页
 *   --tap <word>         在每个页面上点按(mobile)/悬停(desktop) 该词条的第一个高亮，截卡片图；
 *                        传 'auto' 则选择视口内第一个高亮
 *   --settings <json>    写入前与默认设置深合并的 settings 局部对象（JSON 字符串或 .json 文件路径），
 *                        如 '{"inlineTranslation":{"mode":"ruby"},"books":{"enabled":["cet6","gre"]}}'
 *   --seed <json>        直接写入 chrome.storage.local 的键值（JSON 字符串或文件），如 sourceBooks / srcBook:<id> / localBooks / knownWords
 *   --wait <ms>          页面加载后等待高亮完成的时间（默认 2500）
 *   --full               整页截图（默认只截视口）
 *   --scroll <px>        截图前滚动距离（默认 0）
 *   --headed             有头模式（调试用）
 *
 * 输出：<out>/<page>-<size>.png、<page>-<size>-card.png、popup-<size>.png、options-<size>.png，
 * 并在 stdout 打印每个页面的统计 JSON（高亮数、不同词条数、页面错误）。
 *
 * 实现要点：
 * - 每个尺寸使用独立的临时 profile（launchPersistentContext），通过扩展 service worker 写 chrome.storage 播种
 * - fixture 通过本地 HTTP 服务提供（解包扩展默认无 file:// 访问权限）
 * - playwright 优先从仓库 devDependencies 解析，找不到时回退 /tmp/gauntlet/node_modules
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const req = createRequire('/tmp/gauntlet/node_modules/');
    return req('playwright');
  }
}

// ---------------- 参数解析 ----------------
function parseArgs(argv) {
  const args = { url: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const boolFlags = ['full', 'headed'];
    if (boolFlags.includes(key)) args[key] = true;
    else if (key === 'url') args.url.push(argv[++i]);
    else args[key] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.ext) {
  console.error('缺少 --ext <扩展目录>，详见脚本头部说明');
  process.exit(1);
}
const extDir = path.resolve(args.ext);
const outDir = path.resolve(args.out ?? '/tmp/gauntlet/shots/qa');
const pages = (args.pages ?? 'article,dark,dynamic').split(',').filter((p) => p && p !== 'none');
const sizes = (args.sizes ?? 'mobile,desktop').split(',');
const uiPages = (args.ui ?? '').split(',').filter(Boolean);
const waitMs = Number(args.wait ?? 2500);
const readJsonArg = (v) => (v === undefined ? undefined : JSON.parse(fs.existsSync(v) ? fs.readFileSync(v, 'utf8') : v));
const settingsPatch = readJsonArg(args.settings);
const seed = readJsonArg(args.seed);
fs.mkdirSync(outDir, { recursive: true });

const SIZES = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0' },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false },
};

// ---------------- fixture 静态服务 ----------------
function startFixtureServer() {
  const dir = path.join(ROOT, 'tests/fixtures');
  const server = http.createServer((req, res) => {
    // 避免浏览器自动请求 favicon 产生 404 噪音
    if (req.url === '/favicon.ico') return void res.writeHead(204).end();
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------- 主流程 ----------------
const { chromium } = await loadPlaywright();
const server = await startFixtureServer();
const base = `http://127.0.0.1:${server.address().port}`;
const targets = [...pages.map((p) => ({ name: p, url: `${base}/${p}.html` })),
  ...args.url.map((u, i) => ({ name: `live${i + 1}-${new URL(u).hostname.replace(/\W+/g, '_')}`, url: u }))];
const report = [];

for (const sizeName of sizes) {
  const size = SIZES[sizeName];
  if (!size) throw new Error(`未知尺寸 ${sizeName}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-qa-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: !args.headed,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    ...size,
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    const extId = new URL(sw.url()).host;
    // 等待后台完成首次迁移/初始化（settings 键出现），再播种
    await sw.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        if ((await chrome.storage.local.get('settings')).settings) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await sw.evaluate(
      async ({ settingsPatch, seed }) => {
        if (seed) await chrome.storage.local.set(seed);
        if (settingsPatch) {
          const cur = (await chrome.storage.local.get('settings')).settings ?? {};
          const merge = (a, b) => {
            if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object') return b === undefined ? a : b;
            const out = { ...a };
            for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
            return out;
          };
          await chrome.storage.local.set({ settings: merge(cur, settingsPatch) });
        }
      },
      { settingsPatch, seed },
    );

    let firstTabPage = null;
    for (const t of targets) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' || m.text().includes('[hnw]') ? errors.push(`console.${m.type()}: ${m.text()}`) : null);
      const t0 = Date.now();
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(waitMs);
      if (args.scroll) await page.evaluate((y) => window.scrollTo(0, y), Number(args.scroll));
      const stats = await page.evaluate(() => {
        const marks = [...document.querySelectorAll('hnw-mark')];
        return {
          marks: marks.length,
          lemmas: new Set(marks.map((m) => m.getAttribute('data-lemma'))).size,
          translations: document.querySelectorAll('hnw-mark hnw-tr').length,
          sample: [...new Set(marks.slice(0, 12).map((m) => m.getAttribute('data-lemma')))],
        };
      });
      const file = path.join(outDir, `${t.name}-${sizeName}.png`);
      await page.screenshot({ path: file, fullPage: !!args.full });
      const entry = { page: t.name, size: sizeName, ...stats, loadMs: Date.now() - t0, shots: [file], errors };

      if (args.tap) {
        const handle = await page.evaluateHandle((word) => {
          const marks = [...document.querySelectorAll('hnw-mark')];
          if (word !== 'auto') return marks.find((m) => m.getAttribute('data-lemma') === word) ?? null;
          return marks.find((m) => { const r = m.getBoundingClientRect(); return r.top > 80 && r.bottom < innerHeight * 0.6; }) ?? marks[0] ?? null;
        }, args.tap);
        const mark = handle.asElement();
        if (mark) {
          await mark.scrollIntoViewIfNeeded();
          // 让滚动引起的“滚动关闭卡片”先发生，再触发打开
          await page.waitForTimeout(200);
          if (size.hasTouch) await mark.tap();
          else await mark.hover();
          await page.waitForTimeout(700);
          const cardFile = path.join(outDir, `${t.name}-${sizeName}-card.png`);
          await page.screenshot({ path: cardFile });
          entry.shots.push(cardFile);
          entry.cardOpen = await page.evaluate(() => {
            const host = document.querySelector('hnw-card-host');
            const card = host?.shadowRoot?.querySelector('.card');
            return !!card && !card.hidden;
          });
        } else {
          entry.cardOpen = false;
          entry.errors.push(`未找到可点击的高亮: ${args.tap}`);
        }
      }
      report.push(entry);
      if (!firstTabPage) firstTabPage = page;
      else await page.close();
    }

    for (const ui of uiPages) {
      const page = await ctx.newPage();
      let url = `chrome-extension://${extId}/${ui}.html`;
      if (ui === 'popup' && firstTabPage) {
        // 用 SW 查询第一个页面的 tabId，popup 通过 ?tabId= 展示该页数据
        const tabUrl = firstTabPage.url();
        const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, tabUrl);
        if (tabId) url += `?tabId=${tabId}`;
      }
      await page.goto(url);
      await page.waitForTimeout(800);
      const file = path.join(outDir, `${ui}-${sizeName}.png`);
      if (ui === 'popup' && sizeName === 'desktop') {
        // 桌面 popup 实际是固定宽度的小窗：按内容区域裁剪
        const box = await page.locator('main').boundingBox();
        await page.screenshot({ path: file, clip: box ?? undefined });
      } else {
        await page.screenshot({ path: file, fullPage: !!args.full || ui === 'options' });
      }
      report.push({ page: ui, size: sizeName, shots: [file] });
      await page.close();
    }
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

server.close();
console.log(JSON.stringify(report, null, 2));
