#!/usr/bin/env node
/**
 * 兼容性补测（Camoufox / Firefox 内核）：Patchright Chromium 在部分站点（如 Reddit 并行跑时）会被 reCAPTCHA
 * “Prove your humanity”验证页拦截，本脚本改用带反检测的 Camoufox（Firefox 152）加载 Firefox 版扩展补测这些站点。
 * 分组：baseline（无扩展）/ ours（默认设置）/ ours-after（默认 + “词后”行内译文）/ relingo（可选，Firefox 版 Relingo）。
 * 每组先预热 1 次（缓存与验证 cookie 留在临时 profile），再轮流交替正式测量 --repeat 次，结论取中位数。
 *
 * 用法：
 *   node scripts/compat/run-camoufox.mjs --sites reddit-post,reddit-feed [--viewports mobile,desktop] [--repeat 3]
 *     [--configs baseline,ours,ours-after] [--ext /tmp/gauntlet/out/compat-ff/firefox-mv3] [--out /tmp/gauntlet/compat] [--no-xvfb]
 *
 * 输出（不覆盖 run.mjs 的 Chromium 结果）：
 *   <out>/results/<site>-<viewport>-camoufox.json
 *   <out>/shots/<site>-<viewport>-camoufox-<config>-{top,scroll3}.png，以及 -camoufox-diff-<config>-{top,scroll3}.png 热力图
 *
 * 复用：页面内采集函数（initScript/detectGate/markStats/markRects/layoutSample）与对比函数（layoutDiff/pixelDiff/median）
 * 在运行时从 run.mjs 源码中按函数名截取后执行，口径与 Chromium 版保持一致（run.mjs 顶层会直接开跑，不能 import）。
 *
 * 依赖：全局安装的 camofox-browser 包自带的 camoufox-js（launchOptions，通过 addons 加载解包扩展）与 playwright-core（firefox）。
 *
 * 局限（结果 JSON 的 limitations 字段同样写明）：
 * - 测的是 Firefox 版扩展（wxt 的 firefox-mv3 构建），不是 Chrome 版；数值不能和 Chromium 结果直接比较，只在同一脚本的组间比较；
 * - Firefox 不支持 longtask、layout-shift 条目，没有 CDP：长任务/CLS/TBT、ScriptDuration、JS 堆、扩展 CPU 归因均为 N/A。
 *   长任务用“事件循环阻塞”近似（init script 里 16ms 定时器的超时间隔 > 50ms 记一次），不能归因到扩展；
 *   布局偏移改用 run.mjs 的 getBoundingClientRect 布局差（layoutDiff）；
 * - 手机尺寸只能模拟 390x844、DPR 2、触屏（hasTouch，pointer:coarse 生效），Playwright Firefox 不支持 isMobile，
 *   UA 保持 Camoufox 指纹（Linux 桌面 Firefox），站点按窄屏响应式布局而不是移动版 UA 出页；
 * - Juggler 合成的鼠标事件 pointerType 为空，扩展的悬停判定（pointerType==='mouse'）收不到，
 *   桌面卡片检查改为在页面里派发 pointerType=mouse 的 PointerEvent（非可信事件），手机用 tap；
 * - ours-after 不能经扩展页写 storage（Juggler 不能导航到 moz-extension://），改为复制一份构建产物，
 *   仅把默认设置里的 inlineTranslation.mode 由 off 改为 after，等价于 run.mjs 的设置补丁；
 * - 控制台：Playwright Firefox 的 console/pageerror 事件，按 moz-extension://<uuid> 归因（ours 的 uuid 由偏好固定）；
 *   后台脚本的报错不在页面控制台里，收不到；
 * - 遇到验证页只等待后复核（15s、25s），不做任何绕过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = path.join(ROOT, 'scripts/compat');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  if (['no-xvfb'].includes(key)) args[key] = true;
  else args[key] = process.argv[++i];
}

// 同 run.mjs：自动套 xvfb-run，有头 Camoufox
if (!args['no-xvfb'] && !process.env.COMPAT_IN_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, COMPAT_IN_XVFB: '1' },
  });
  process.exit(r.status ?? 1);
}

const OUT = path.resolve(args.out ?? '/tmp/gauntlet/compat');
const RESULTS = path.join(OUT, 'results');
const SHOTS = path.join(OUT, 'shots');
const WORK = path.join(OUT, 'camoufox');
const EXT = path.resolve(args.ext ?? '/tmp/gauntlet/out/compat-ff/firefox-mv3');
const RELINGO_EXT = path.join(WORK, 'relingo-ff');
const OURS_ID = 'highlight-new-words@xqdd';
/** 固定本扩展的 moz-extension uuid，控制台消息按它归因 */
const OURS_UUID = '11111111-2222-4333-8444-555555555555';
const SCROLL_SECONDS = Number(args['scroll-seconds'] ?? 30);
const CONFIG_NAMES = (args.configs ?? 'baseline,ours,ours-after').split(',');
const VIEWPORT_NAMES = (args.viewports ?? 'mobile,desktop').split(',');
const REPEAT = Math.max(1, Number(args.repeat ?? 3));
const roleOf = (cfg) => (cfg.startsWith('ours') ? 'ours' : cfg);
const THRESHOLDS = { lcpRatio: 0.05, lcpMs: 100 };

// Firefox 不支持 isMobile；手机尺寸只模拟窄屏 + DPR + 触屏
const VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false },
};

const LIMITATIONS = [
  'Firefox 版扩展（firefox-mv3 构建）在 Camoufox（Firefox 152）下的结果，数字不能与 Chromium 结果直接比较',
  'longtask / layout-shift 条目 Firefox 不支持：CLS、TBT、扩展归因长任务为 N/A；loopLag 为事件循环阻塞近似，不可归因',
  '无 CDP：ScriptDuration、JS 堆、扩展 CPU 归因为 N/A',
  '手机尺寸为 390x844 + DPR2 + hasTouch，不支持 isMobile，UA 为桌面 Firefox',
  '桌面卡片检查用页面派发的 pointerType=mouse 合成事件（Juggler 鼠标事件 pointerType 为空）',
  'ours-after 用复制的构建产物把默认 inlineTranslation.mode 改为 after（Juggler 不能打开 moz-extension 页面写设置）',
  '控制台只含页面与内容脚本消息，后台脚本报错不可见',
];

// ---------------- 从 run.mjs 截取共用函数 ----------------
const RUN_SRC = fs.readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
/** 按函数名截取 run.mjs 中的函数声明源码：先配平参数括号，再配平函数体花括号（被截取函数中的字符串/模板里括号均成对） */
function extractFunction(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(RUN_SRC);
  if (!m) throw new Error(`run.mjs 中找不到函数 ${name}`);
  let i = m.index + m[0].length;
  for (let depth = 1; depth > 0; i++) depth += RUN_SRC[i] === '(' ? 1 : RUN_SRC[i] === ')' ? -1 : 0;
  i = RUN_SRC.indexOf('{', i);
  let j = i + 1;
  for (let depth = 1; depth > 0; j++) depth += RUN_SRC[j] === '{' ? 1 : RUN_SRC[j] === '}' ? -1 : 0;
  return RUN_SRC.slice(m.index, j);
}
const shared = new Function('fs', 'path', [
  ...['initScript', 'detectGate', 'markStats', 'markRects', 'layoutSample', 'layoutDiff', 'pixelDiff'].map(extractFunction),
  'return { initScript, detectGate, markStats, markRects, layoutSample, layoutDiff, pixelDiff };',
].join('\n'))(fs, path);
const { initScript, detectGate, markStats, markRects, layoutSample, layoutDiff, pixelDiff } = shared;

/** 事件循环阻塞近似（Firefox 无 longtask）：16ms 定时器的实际间隔超过 66ms 视为主线程被阻塞 >50ms，记录 [start, blockedMs] */
function loopLagScript() {
  if (window.top !== window || window.__compatLag) return;
  const L = (window.__compatLag = []);
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - last > 66) L.push([Math.round(last), Math.round(now - last - 16)]);
    last = now;
    if (now > 120000) clearInterval(timer);
  }, 16);
}

// ---------------- 依赖 ----------------
const GLOBAL = execSync('npm root -g').toString().trim();
const CAMO_PKG = path.join(GLOBAL, 'camofox-browser');
const { firefox } = createRequire(`${CAMO_PKG}/`)('playwright-core');
const { launchOptions } = await import(path.join(CAMO_PKG, 'node_modules/camoufox-js/dist/index.js'));
const { generateFingerprint } = await import(path.join(CAMO_PKG, 'node_modules/camoufox-js/dist/fingerprints.js'));

const siteFile = JSON.parse(fs.readFileSync(path.join(HERE, 'sites.json'), 'utf8'));
const ids = (args.sites ?? 'reddit-post,reddit-feed').split(',');
const sites = siteFile.sites.filter((s) => ids.includes(s.id)).map((s) => ({ ...siteFile.defaults, ...s, forbid: [...siteFile.defaults.forbid, ...(s.forbid ?? [])] }));
if (!sites.length) throw new Error('没有选中任何站点');
fs.mkdirSync(RESULTS, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

/** ours-after：复制构建产物，只把默认设置的行内译文模式改为“词后” */
function prepareOursAfter() {
  const dir = path.join(WORK, 'ours-after-ext');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(EXT, dir, { recursive: true });
  let patched = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        const out = src.replaceAll('inlineTranslation:{mode:`off`,blur:!1', 'inlineTranslation:{mode:`after`,blur:!1');
        if (out !== src) { fs.writeFileSync(p, out); patched++; }
      }
    }
  };
  walk(dir);
  if (!patched) throw new Error('ours-after：构建产物里没找到默认 inlineTranslation 设置，无法生成“词后”版本');
  return dir;
}

// 全部组与尺寸共用同一份 Linux 指纹，避免组间因指纹（字体/屏幕）不同产生差异
const FINGERPRINT = generateFingerprint(undefined, { operatingSystems: ['linux'], screen: { minWidth: 1366, minHeight: 900 } });
/**
 * Camoufox 每次启动随机一个字体间距种子（fonts:spacing_seed，反字体指纹），不同实例的字形位置有亚像素差，
 * 会让像素差把整页文字都算成“变化”。各组固定同一个种子，组间像素差才只反映扩展造成的变化。
 */
const CAMOU_CONFIG = { 'fonts:spacing_seed': Math.floor(Math.random() * 1_073_741_824), 'window.history.length': 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null);

async function launchConfig(cfg, vpName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `compat-camo-${cfg}-${vpName}-`));
  const addons = cfg === 'ours' ? [EXT] : cfg === 'ours-after' ? [OURS_AFTER_EXT] : cfg === 'relingo' ? [RELINGO_EXT] : [];
  const opts = await launchOptions({
    headless: false, os: 'linux', humanize: false, enable_cache: true, fingerprint: FINGERPRINT, addons, i_know_what_im_doing: true, config: { ...CAMOU_CONFIG },
    firefox_user_prefs: { 'extensions.webextensions.uuids': JSON.stringify({ [OURS_ID]: OURS_UUID }) },
  });
  const ctx = await firefox.launchPersistentContext(dir, { ...opts, locale: 'en-US', ...VIEWPORTS[vpName] });
  await ctx.addInitScript(initScript);
  await ctx.addInitScript(loopLagScript);
  await sleep(2500); // 等扩展后台初始化写出默认设置
  for (const p of ctx.pages().slice(1)) await p.close().catch(() => {});
  return { ctx, dir, cfg, vpName };
}

async function closeConfig(c) {
  await c.ctx.close().catch(() => {});
  fs.rmSync(c.dir, { recursive: true, force: true });
}

/** 遇到验证页：等待后复核，最多两次（不做任何绕过操作）；同 run.mjs#checkGate */
async function checkGate(page) {
  const history = [];
  for (const wait of [0, 15000, 25000]) {
    if (wait) await sleep(wait);
    const g = await page.evaluate(detectGate).catch((e) => ({ hit: 'evaluate-failed', error: String(e.message).slice(0, 120) }));
    history.push(g);
    if (!g.hit) return { blocked: false, waitedMs: wait ? (wait === 15000 ? 15000 : 40000) : 0, history };
  }
  return { blocked: true, history };
}

/** 控制台消息归因：Firefox 把内容脚本的错误/警告以“[JavaScript Error: ... {file: moz-extension://...}]”形式报给页面 */
function consoleCollector(page) {
  const items = [];
  const srcOf = (text, url) => {
    const hay = `${url ?? ''} ${text}`;
    if (hay.includes(`moz-extension://${OURS_UUID}`)) return 'ours';
    if (hay.includes('moz-extension://')) return 'other-ext';
    return 'page';
  };
  page.on('console', (m) => {
    const text = m.text().slice(0, 300);
    const type = m.type();
    const level = type === 'error' || text.startsWith('[JavaScript Error') ? 'error' : type === 'warning' || text.startsWith('[JavaScript Warning') ? 'warning' : null;
    if (!level) return;
    const url = m.location()?.url ?? null;
    // 测量脚本自身（init script 注册 Firefox 不支持的 longtask/layout-shift）产生的警告，不计入页面
    if (url === 'debugger eval code') return;
    items.push({ kind: `console.${type}`, level, text, src: srcOf(text, url), url });
  });
  page.on('pageerror', (e) => {
    const text = String(e.stack ?? e).split('\n').slice(0, 3).join(' | ').slice(0, 300);
    items.push({ kind: 'pageerror', level: 'error', text, src: srcOf(text, null), url: null });
  });
  return () => {
    const count = (src, level) => items.filter((i) => i.src === src && i.level === level).length;
    return {
      counts: { pageErrors: count('page', 'error'), pageWarnings: count('page', 'warning'), oursErrors: count('ours', 'error'), oursWarnings: count('ours', 'warning'), otherExtErrors: count('other-ext', 'error') },
      items: items.slice(0, 80),
    };
  };
}

/** 卡片能否打开：选首屏内不在链接/按钮里的高亮（避免触发站点导航），手机 tap，桌面派发 pointerType=mouse 的指向事件 */
async function cardCheck(page, vpName) {
  const handle = await page.evaluateHandle(() => [...document.getElementsByTagName('hnw-mark')].find((m) => {
    const r = m.getBoundingClientRect();
    return r.width > 0 && r.top > 80 && r.bottom < innerHeight * 0.7 && !m.closest('a,button,[role=button],[role=link],summary,label');
  }) ?? null);
  const mark = handle.asElement();
  if (!mark) return { tried: false, reason: '首屏没有不在链接内的高亮' };
  const word = await mark.getAttribute('data-lemma');
  if (VIEWPORTS[vpName].hasTouch) await mark.tap({ timeout: 5000 }).catch(() => {});
  else await mark.evaluate((m) => {
    const r = m.getBoundingClientRect();
    const o = { bubbles: true, composed: true, pointerType: 'mouse', clientX: r.left + 3, clientY: r.top + 3 };
    m.dispatchEvent(new PointerEvent('pointerover', o));
    m.dispatchEvent(new PointerEvent('pointermove', o));
  });
  await sleep(1200);
  const st = await page.evaluate(() => {
    const c = document.querySelector('hnw-card-host')?.shadowRoot?.querySelector('.card');
    return c ? { open: !c.hidden, cls: c.className, text: c.innerText.replace(/\s+/g, ' ').slice(0, 80) } : { open: false };
  }).catch((e) => ({ open: false, error: String(e.message).slice(0, 120) }));
  return { tried: true, via: VIEWPORTS[vpName].hasTouch ? 'tap' : 'synthetic-pointerover', word, ...st };
}

async function runOnce(conf, site, { light = false, tag = 'measure', shots = true } = {}) {
  const { ctx, cfg, vpName } = conf;
  const page = await ctx.newPage();
  const res = { cfg, vp: vpName, site: site.id, tag, url: site.url, engine: 'camoufox' };
  const consoleResult = consoleCollector(page);
  try {
    try {
      const resp = await page.goto(site.url, { waitUntil: 'commit', timeout: 45000 });
      res.httpStatus = resp?.status() ?? null;
    } catch (e) {
      res.navError = String(e.message).split('\n')[0];
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    const gate = await checkGate(page);
    res.gate = { blocked: gate.blocked, waitedMs: gate.waitedMs ?? null, hit: gate.history.at(-1).hit, title: gate.history.at(-1).title, finalUrl: page.url() };
    if (gate.history.some((g) => g.hit)) res.gate.firstHit = gate.history.find((g) => g.hit).hit;
    const shotBase = `${site.id}-${vpName}-camoufox-${cfg}${tag === 'measure' ? '' : '-' + tag}`;
    if (light) {
      await sleep(Math.min(site.settleMs, 5000));
      if (gate.blocked) await page.screenshot({ path: path.join(SHOTS, `${shotBase}-gate.png`) }).catch(() => {});
      return res;
    }
    await sleep(site.settleMs);

    // ---- 首屏 ----
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(300);
    const perf = await page.evaluate(() => {
      const C = window.__compat ?? { lt: [], lcp: [], cls: [], firstMark: {} };
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { lcp: C.lcp, firstMark: C.firstMark, lag: window.__compatLag ?? [], dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null, load: nav ? Math.round(nav.loadEventEnd) : null, fcp: fcp ? Math.round(fcp.startTime) : null, ttfb: nav ? Math.round(nav.responseStart) : null, now: Math.round(performance.now()), supported: PerformanceObserver.supportedEntryTypes };
    }).catch(() => null);
    res.settle = {
      lcp: perf?.lcp.at(-1)?.[0] ?? null,
      lcpElement: perf?.lcp.at(-1)?.[2] ?? null,
      fcp: perf?.fcp ?? null, ttfb: perf?.ttfb ?? null, dcl: perf?.dcl ?? null, load: perf?.load ?? null,
      cls: null, tbt: null, longTasks: null, // Firefox 不支持 layout-shift / longtask
      loopLag: perf?.lag ?? [],
      loopLagMax: Math.max(0, ...(perf?.lag ?? []).map((x) => x[1])),
      loopLagOver50: (perf?.lag ?? []).length,
      firstMark: perf?.firstMark ?? {},
      supportedEntryTypes: perf?.supported ?? null,
    };
    res.marks = await page.evaluate(markStats, { forbid: site.forbid }).catch((e) => ({ error: String(e.message).slice(0, 200) }));
    res.layoutTop = await page.evaluate(layoutSample).catch(() => []);
    res.rectsTop = await page.evaluate(markRects).catch(() => []);
    if (shots) {
      res.shotTop = path.join(SHOTS, `${shotBase}-top.png`);
      await page.screenshot({ path: res.shotTop, timeout: 20000 }).catch((e) => (res.shotError = String(e.message).slice(0, 120)));
    }

    // ---- 滚动 3 屏 ----
    const vh = VIEWPORTS[vpName].viewport.height;
    const lag0 = res.settle.loopLag.length;
    for (let y = 0; y < vh * 3; y += Math.round(vh / 2)) {
      await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(vh / 2)).catch(() => {});
      await sleep(250);
    }
    await sleep(2500);
    res.scroll3 = {
      marksInView: await page.evaluate(() => ({
        ours: [...document.getElementsByTagName('hnw-mark')].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; }).length,
        relingo: [...document.getElementsByTagName('relin-highlight')].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; }).length,
        scrollY: Math.round(scrollY),
      })).catch(() => null),
    };
    res.rectsScroll3 = await page.evaluate(markRects).catch(() => []);
    if (shots) {
      res.shotScroll3 = path.join(SHOTS, `${shotBase}-scroll3.png`);
      await page.screenshot({ path: res.shotScroll3, timeout: 20000 }).catch(() => {});
    }
    const lagAfterScroll = await page.evaluate(() => window.__compatLag ?? []).catch(() => []);
    res.scroll3.loopLag = lagAfterScroll.slice(lag0);

    // ---- 无限滚动：持续 N 秒 ----
    if (site.kind === 'infinite') {
      const count = () => page.evaluate(() => ({ marks: document.getElementsByTagName('hnw-mark').length + document.getElementsByTagName('relin-highlight').length, nodes: document.getElementsByTagName('*').length })).catch(() => ({ marks: 0, nodes: 0 }));
      const c0 = await count();
      const lagStart = lagAfterScroll.length;
      await page.evaluate(() => {
        const F = (window.__compatFps = { frames: 0, jank: 0, maxGap: 0, last: performance.now(), on: true });
        const tick = (t) => {
          const gap = t - F.last;
          F.last = t;
          F.frames++;
          if (gap > 50) F.jank++;
          if (gap > F.maxGap) F.maxGap = gap;
          if (F.on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }).catch(() => {});
      const tEnd = Date.now() + SCROLL_SECONDS * 1000;
      while (Date.now() < tEnd) {
        await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(vh * 0.8)).catch(() => {});
        await sleep(600);
      }
      const fps = await page.evaluate(() => { const F = window.__compatFps; F.on = false; return { frames: F.frames, jank: F.jank, maxGap: Math.round(F.maxGap) }; }).catch(() => null);
      const c1 = await count();
      const lagAll = await page.evaluate(() => window.__compatLag ?? []).catch(() => []);
      const lags = lagAll.slice(lagStart);
      res.infinite = {
        seconds: SCROLL_SECONDS,
        scrollY: await page.evaluate(() => Math.round(scrollY)).catch(() => null),
        marksAdded: c1.marks - c0.marks,
        nodesStart: c0.nodes, nodesEnd: c1.nodes,
        loopLag: lags, loopLagOver50: lags.length, loopLagMax: Math.max(0, ...lags.map((x) => x[1])),
        fps: fps ? { ...fps, avg: +(fps.frames / SCROLL_SECONDS).toFixed(1) } : null,
        tbt: null, heapGrowthMB: null, scriptMs: null,
      };
    }

    // ---- 卡片（ours 系，第 1 轮）----
    if (roleOf(cfg) === 'ours' && tag === 'measure') {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await sleep(800);
      res.card = await cardCheck(page, vpName).catch((e) => ({ tried: true, open: false, error: String(e.message).slice(0, 160) }));
      if (res.card.open) await page.screenshot({ path: path.join(SHOTS, `${shotBase}-card.png`) }).catch(() => {});
    }
  } catch (e) {
    res.error = String(e.stack ?? e).slice(0, 600);
  } finally {
    res.console = consoleResult();
    await page.close().catch(() => {});
  }
  return res;
}

/** 中位数摘要：数值取中位数，报错/违规取最坏值（同 run.mjs#summarize 的口径，去掉 Firefox 测不到的项） */
function summarize(runs) {
  const ok = runs.filter((r) => r?.settle && !r.gate?.blocked);
  const role = roleOf(runs[0]?.cfg ?? 'baseline');
  const s = { runs: runs.length, validRuns: ok.length, blocked: runs.filter((r) => r?.gate?.blocked).length, gateHits: runs.filter((r) => r?.gate?.firstHit).map((r) => r.gate.firstHit) };
  if (!ok.length) return s;
  const med = (f) => {
    const v = ok.map((r) => { try { return f(r); } catch { return null; } }).filter((x) => typeof x === 'number' && Number.isFinite(x));
    return v.length ? median(v) : null;
  };
  const max = (f) => Math.max(0, ...ok.map((r) => { try { return f(r) ?? 0; } catch { return 0; } }));
  Object.assign(s, {
    httpStatus: ok[0].httpStatus ?? null,
    lcp: med((r) => r.settle.lcp), fcp: med((r) => r.settle.fcp), load: med((r) => r.settle.load),
    cls: 'N/A', tbt: 'N/A', scriptMs: 'N/A', heapMB: 'N/A', cpuLoad: 'N/A',
    loopLagOver50: med((r) => r.settle.loopLagOver50), loopLagMax: med((r) => r.settle.loopLagMax),
    scroll3LoopLagMax: med((r) => Math.max(0, ...(r.scroll3?.loopLag ?? []).map((x) => x[1]))),
    nodes: med((r) => r.marks?.nodes),
    pageErrors: med((r) => r.console?.counts?.pageErrors ?? 0),
  });
  const errs = new Map();
  for (const r of ok) for (const it of r.console?.items ?? []) if (it.src === role && it.level === 'error') errs.set(it.text.slice(0, 160), it);
  if (role !== 'baseline') {
    Object.assign(s, {
      firstMark: med((r) => r.settle.firstMark?.[role]),
      marks: med((r) => r.marks?.[role]?.count), marksInView: med((r) => r.marks?.[role]?.inView),
      translations: role === 'ours' ? med((r) => r.marks?.ours?.translations) : null,
      scroll3InView: med((r) => r.scroll3?.marksInView?.[role]),
      extErrors: max((r) => r.console?.counts?.[`${role}Errors`]),
      extWarnings: max((r) => r.console?.counts?.[`${role}Warnings`]),
      extErrorSamples: [...errs.values()].slice(0, 5).map((e) => ({ kind: e.kind, text: e.text, url: e.url })),
      violations: max((r) => (r.marks?.[role]?.violations ?? []).reduce((a, v) => a + v.count, 0)),
      violationSamples: (ok.find((r) => r.marks?.[role]?.violations?.length)?.marks?.[role]?.violations ?? []).slice(0, 4),
      inflated: max((r) => r.marks?.[role]?.lineCheck?.inflated),
      inflatedSamples: (ok.find((r) => r.marks?.[role]?.lineCheck?.inflated)?.marks?.[role]?.lineCheck?.samples ?? []).slice(0, 3),
      overflow: max((r) => r.marks?.[role]?.overflow?.length),
      overflowSamples: (ok.find((r) => r.marks?.[role]?.overflow?.length)?.marks?.[role]?.overflow ?? []).slice(0, 3),
      interactive: ok[0].marks?.[role]?.interactive ?? null,
      card: ok.find((r) => r.card)?.card ?? null,
    });
  }
  if (ok.some((r) => r.infinite)) {
    s.infinite = {
      fps: med((r) => r.infinite.fps?.avg), jank: med((r) => r.infinite.fps?.jank), maxGap: med((r) => r.infinite.fps?.maxGap),
      loopLagOver50: med((r) => r.infinite.loopLagOver50), loopLagMax: med((r) => r.infinite.loopLagMax),
      nodesGrowth: med((r) => r.infinite.nodesEnd - r.infinite.nodesStart),
      marksAdded: med((r) => r.infinite.marksAdded), scrollY: med((r) => r.infinite.scrollY),
      tbt: 'N/A', heapGrowthMB: 'N/A',
    };
  }
  return s;
}

function judge(base, ext) {
  if (!base?.validRuns || !ext?.validRuns) return null;
  const lcpDelta = base.lcp != null && ext.lcp != null ? ext.lcp - base.lcp : null;
  const lcpLimit = base.lcp != null ? Math.max(base.lcp * THRESHOLDS.lcpRatio, THRESHOLDS.lcpMs) : null;
  return {
    lcpDelta, lcpLimit: lcpLimit && Math.round(lcpLimit), lcpPass: lcpDelta == null ? null : lcpDelta < lcpLimit,
    loopLagMaxDelta: ext.loopLagMax != null && base.loopLagMax != null ? ext.loopLagMax - base.loopLagMax : null,
    clsDelta: 'N/A', longTaskPass: 'N/A',
    errorsPass: !ext.extErrors, violationsPass: !ext.violations,
  };
}

// ---------------- 主流程 ----------------
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`Firefox 版扩展不存在：${EXT}`);
const OURS_AFTER_EXT = CONFIG_NAMES.includes('ours-after') ? prepareOursAfter() : null;
// 像素差工具页：无扩展的 headless Camoufox，只打开 about:blank 处理本地截图
const toolBrowser = await firefox.launch(await launchOptions({ headless: true, os: 'linux', i_know_what_im_doing: true }));
const toolPage = await toolBrowser.newPage();
const ffVersion = toolBrowser.version();

for (const vpName of VIEWPORT_NAMES) {
  const confs = {};
  const ensure = async (cfg) => (confs[cfg] ??= await launchConfig(cfg, vpName));
  const runSafe = async (cfg, site, opts) => {
    let conf;
    try {
      conf = await ensure(cfg);
      return await runOnce(conf, site, opts);
    } catch (e) {
      if (conf) { await closeConfig(conf); delete confs[cfg]; }
      return { cfg, vp: vpName, site: site.id, tag: opts.tag, error: String(e.stack ?? e).slice(0, 600) };
    }
  };
  for (const site of sites) {
    const resultFile = path.join(RESULTS, `${site.id}-${vpName}-camoufox.json`);
    const entry = { site: site.id, name: site.name, url: site.url, vp: vpName, engine: 'camoufox', browser: `Camoufox Firefox ${ffVersion}`, repeat: REPEAT, configs: CONFIG_NAMES, limitations: LIMITATIONS, runs: {}, at: new Date().toISOString() };
    for (const cfg of CONFIG_NAMES) entry.runs[cfg] = [];
    console.log(`[camoufox] ${vpName} ${site.id} 开始`);
    const t0 = Date.now();
    entry.warmGate = {};
    for (const cfg of CONFIG_NAMES) {
      entry.warmGate[cfg] = (await runSafe(cfg, site, { light: true, tag: 'warm' })).gate ?? null;
      await sleep(3000);
    }
    for (let round = 0; round < REPEAT; round++) {
      for (const cfg of CONFIG_NAMES) {
        const tag = round === 0 ? 'measure' : cfg === 'baseline' && round === 1 ? 'noise' : `r${round + 1}`;
        const run = await runSafe(cfg, site, { tag, shots: round === 0 || tag === 'noise' });
        run.round = round + 1;
        entry.runs[cfg].push(run);
        console.log(`[camoufox]   ${cfg} r${round + 1} gate=${run.gate?.blocked ? 'BLOCKED' : run.gate?.firstHit ? 'passed-after-wait' : 'ok'} lcp=${run.settle?.lcp ?? '-'} marks=${run.marks?.ours?.count ?? '-'} err=${run.error ? 'Y' : 'N'}`);
        await sleep(3000);
      }
    }
    entry.summary = Object.fromEntries(CONFIG_NAMES.map((c) => [c, summarize(entry.runs[c])]));
    const base = entry.runs.baseline?.[0];
    const noise = entry.runs.baseline?.[1];
    const dpr = VIEWPORTS[vpName].deviceScaleFactor;
    entry.compare = {};
    for (const cfg of CONFIG_NAMES.filter((c) => c !== 'baseline')) {
      const c = (entry.compare[cfg] = { judge: judge(entry.summary.baseline, entry.summary[cfg]) });
      const layouts = entry.runs[cfg].map((ext, i) => {
        const b = entry.runs.baseline?.[i] ?? base;
        const n = entry.runs.baseline?.[i === 1 ? 0 : 1];
        return b?.layoutTop?.length && ext.layoutTop?.length && !b.gate?.blocked && !ext.gate?.blocked ? layoutDiff(b.layoutTop, n?.layoutTop, ext.layoutTop) : null;
      }).filter(Boolean);
      if (layouts.length) {
        const pickMed = (k) => median(layouts.map((l) => l[k]));
        c.layout = { ...layouts[0], pushed: pickMed('pushed'), markSelf: pickMed('markSelf'), unexplained: pickMed('unexplained'), maxPushPx: pickMed('maxPushPx'), horizontal: pickMed('horizontal'), perRun: layouts.map((l) => ({ pushed: l.pushed, unexplained: l.unexplained, maxPushPx: l.maxPushPx, horizontal: l.horizontal })) };
      }
      const ext0 = entry.runs[cfg][0];
      if (base?.shotTop && ext0?.shotTop) {
        c.pixelTop = await pixelDiff(toolPage, base.shotTop, ext0.shotTop, noise?.shotTop, ext0.rectsTop ?? [], dpr, path.join(SHOTS, `${site.id}-${vpName}-camoufox-diff-${cfg}-top.png`)).catch((e) => ({ error: String(e.message).slice(0, 200) }));
        c.pixelScroll3 = await pixelDiff(toolPage, base.shotScroll3, ext0.shotScroll3, noise?.shotScroll3, ext0.rectsScroll3 ?? [], dpr, path.join(SHOTS, `${site.id}-${vpName}-camoufox-diff-${cfg}-scroll3.png`)).catch((e) => ({ error: String(e.message).slice(0, 200) }));
      }
    }
    for (const r of Object.values(entry.runs).flat()) { delete r.layoutTop; delete r.rectsTop; delete r.rectsScroll3; }
    entry.elapsedSec = Math.round((Date.now() - t0) / 1000);
    fs.writeFileSync(resultFile, JSON.stringify(entry, null, 2));
    console.log(`[camoufox] ${vpName} ${site.id} 完成（${entry.elapsedSec}s）→ ${resultFile}`);
  }
  for (const c of Object.values(confs)) await closeConfig(c);
}
await toolBrowser.close();
