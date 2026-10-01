#!/usr/bin/env node
/**
 * 常用网站兼容性与性能测试：同一页面分三组（baseline 不加载扩展 / ours 本扩展 / relingo 对标）对比
 * LCP、CLS、长任务(TBT 近似)、脚本执行时间、JS 堆、扩展脚本 CPU、高亮数量与首次高亮耗时、控制台错误归因、
 * 截图像素差（热力图）与布局偏移，手机 390x844 与桌面 1280x800 各跑一遍。
 *
 * 用法（不负责改代码，只读站点；默认自动套 xvfb-run 以有头模式运行）：
 *   node scripts/compat/run.mjs [选项]
 *
 * 选项：
 *   --sites <ids>        逗号分隔的站点 id（见 sites.json），默认全部 live 站点
 *   --group <names>      按 group 选择，如 github,news；offline 表示 tests/fixtures/sites 快照
 *   --offline            等价于 --group offline，且默认 --configs baseline,ours，并按阈值给出退出码
 *   --configs <list>     baseline,ours,relingo（默认三者；offline 默认不跑 relingo）
 *   --viewports <list>   mobile,desktop（默认两者，两种尺寸并行跑）
 *   --ext <dir>          本扩展解包目录，默认 /tmp/gauntlet/out/compat/chrome-mv3
 *   --build              先执行 OUT_DIR=/tmp/gauntlet/out/compat npm run build（失败时每 60s 重试，最多 3 次）
 *   --out <dir>          输出根目录，默认 /tmp/gauntlet/compat（results/ 与 shots/ 子目录）
 *   --scroll-seconds <n> 无限滚动页持续滚动秒数，默认 30
 *   --settings <json>    覆盖 ours 的设置补丁，默认 {"books":{"enabled":["cet6"]},"inlineTranslation":{"mode":"after"}}
 *   --no-xvfb            不自动套 xvfb-run（已有 DISPLAY 且想看窗口时）
 *
 * 输出：
 *   <out>/results/<site>-<viewport>.json  三组原始指标 + 对比结论（阈值判定）
 *   <out>/results/all.json                全部汇总
 *   <out>/shots/<site>-<viewport>-<config>-{top,scroll3}.png，以及 -diff-<config>-{top,scroll3}.png 热力图
 *   Markdown 汇总报告（report.mjs）与 tests/fixtures/sites 离线快照待正式测试阶段补充，当前为预研骨架。
 *
 * 依赖：Patchright（Playwright 的反检测分支）。仓库不引入该依赖，按以下顺序解析：
 *   1. import('patchright')；2. 全局安装的 patchright@1.63.0（`npm root -g`）；3. /tmp/gauntlet/node_modules 的 playwright（无反检测，兜底）。
 * Relingo 对标：复制 /tmp/gauntlet/bench/login/profile（已登录免费账号，B2 + 右侧注解）到临时目录后加载
 * /tmp/gauntlet/bench/login/relingo-ext，不改动原 profile。
 * X 的 cookie 从 /home/cuishuqiang/me/personal/deep-research/x-cookie 运行时读取，只注入临时 profile，不写入结果/仓库；
 * X 页面只滚动浏览，不做任何点击/写操作。
 *
 * 测量方法要点（详见 README）：
 * - 主世界 init script 用 PerformanceObserver 收集 longtask / LCP / layout-shift，并用 live HTMLCollection 轮询首次高亮时间；
 * - CDP Performance.getMetrics 取 ScriptDuration/TaskDuration/LayoutDuration/JSHeapUsedSize（GC 后）；
 * - CDP Profiler 采样（0.5ms）按调用栈中是否含 chrome-extension://<id>/ 归因扩展 CPU，并据此判定“扩展归因长任务”；
 * - 控制台：测量期间不开 Runtime 域（降低被检测风险），页面结束前再 Runtime.enable/Log.enable，V8 会回放已缓存的消息，
 *   按调用栈 URL 与执行上下文 origin 归因到 本扩展 / Relingo / 页面；
 * - 布局：baseline 跑两遍得到“页面自身波动”噪声，排除不稳定元素后，按 tag+文本 配对主要元素的文档坐标，
 *   区分 markSelf（含生词的元素自身变高/变宽）、pushed（被上方生词换行推移）、unexplained（无生词却偏移/变形）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = path.join(ROOT, 'scripts/compat');

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['offline', 'build', 'no-xvfb'].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));

// 自动套 xvfb-run：有头 Chromium（扩展 + 反检测都更接近真实用户），不依赖桌面 DISPLAY
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
const EXT = path.resolve(args.ext ?? '/tmp/gauntlet/out/compat/chrome-mv3');
const RELINGO_EXT = '/tmp/gauntlet/bench/login/relingo-ext';
const RELINGO_PROFILE = '/tmp/gauntlet/bench/login/profile';
const X_COOKIE_FILE = '/home/cuishuqiang/me/personal/deep-research/x-cookie';
const SCROLL_SECONDS = Number(args['scroll-seconds'] ?? 30);
const OURS_SETTINGS = JSON.parse(args.settings ?? '{"books":{"enabled":["cet6"]},"inlineTranslation":{"mode":"after"}}');
const offlineMode = !!args.offline || args.group === 'offline';
const CONFIG_NAMES = (args.configs ?? (offlineMode ? 'baseline,ours' : 'baseline,ours,relingo')).split(',');
const VIEWPORT_NAMES = (args.viewports ?? 'mobile,desktop').split(',');

/** 阈值（与 README 一致）：LCP 增量 < max(5%, 100ms)；扩展归因长任务最长 ≤ 80ms（“50ms 级”）；CLS 增量 ≤ 0.01（≈0） */
export const THRESHOLDS = { lcpRatio: 0.05, lcpMs: 100, extLongTaskMs: 80, clsDelta: 0.01 };

const VIEWPORTS = {
  mobile: {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0',
  },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false },
};

const siteFile = JSON.parse(fs.readFileSync(path.join(HERE, 'sites.json'), 'utf8'));
let sites = siteFile.sites.map((s) => ({ ...siteFile.defaults, ...s, forbid: [...siteFile.defaults.forbid, ...(s.forbid ?? [])] }));
if (args.sites) {
  const ids = args.sites.split(',');
  sites = sites.filter((s) => ids.includes(s.id));
} else if (args.group || offlineMode) {
  const groups = (args.group ?? 'offline').split(',');
  sites = sites.filter((s) => groups.includes(s.group));
} else {
  sites = sites.filter((s) => s.group !== 'offline');
}
if (!sites.length) throw new Error('没有选中任何站点');
fs.mkdirSync(RESULTS, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------- 依赖解析 ----------------
async function loadChromium() {
  try {
    return (await import('patchright')).chromium;
  } catch {}
  try {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(`${globalRoot}/`)('patchright').chromium;
  } catch {}
  console.warn('[compat] 未找到 patchright，回退 playwright（无反检测）');
  return createRequire('/tmp/gauntlet/node_modules/')('playwright').chromium;
}

function buildExtension() {
  for (let i = 1; i <= 3; i++) {
    const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, env: { ...process.env, OUT_DIR: path.dirname(EXT) }, encoding: 'utf8' });
    if (r.status === 0) return;
    console.warn(`[compat] 构建失败（第 ${i} 次），可能是其他模块正在修改，60s 后重试\n${(r.stdout + r.stderr).slice(-1500)}`);
    if (i < 3) spawnSync('sleep', ['60']);
  }
  throw new Error('扩展构建连续失败');
}

/** X cookie 文件是浏览器复制的 `k=v; k2=v2` 串，只注入 .x.com 域 */
function readXCookies() {
  const raw = fs.readFileSync(X_COOKIE_FILE, 'utf8').trim();
  return raw.split(/;\s*/).filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' };
  });
}

// ---------------- 本地 fixture 服务（offline 快照） ----------------
function startFixtureServer() {
  const dir = path.join(ROOT, 'tests/fixtures/sites');
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') return void res.writeHead(204).end();
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------- 页面内注入/采集函数 ----------------

/** 主世界 init script：尽早注册性能观察者（longtask 无缓冲，必须在页面开始时注册） */
function initScript() {
  if (window.top !== window || window.__compat) return;
  const C = (window.__compat = { lt: [], lcp: [], cls: [], firstMark: {} });
  const observe = (type, fn) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true });
    } catch {}
  };
  observe('longtask', (e) => C.lt.push([Math.round(e.startTime), Math.round(e.duration)]));
  observe('largest-contentful-paint', (e) => C.lcp.push([Math.round(e.startTime), e.size, e.element ? e.element.tagName : null]));
  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    const src = (e.sources || []).slice(0, 3).map((s) => (s.node && s.node.nodeType === 1 ? s.node.tagName + (s.node.id ? '#' + s.node.id : '') : '#text'));
    C.cls.push([Math.round(e.startTime), e.value, src.join(',')]);
  });
  // 首次高亮时间：live HTMLCollection 的 length 有缓存，50ms 轮询开销可忽略，三组一致
  const cols = { ours: document.getElementsByTagName('hnw-mark'), relingo: document.getElementsByTagName('relin-highlight') };
  const timer = setInterval(() => {
    for (const k in cols) if (!C.firstMark[k] && cols[k].length) C.firstMark[k] = Math.round(performance.now());
    if (performance.now() > 60000) clearInterval(timer);
  }, 50);
}

/** 验证页/拦截页识别（只做识别，不绕过） */
function detectGate() {
  const title = document.title || '';
  const text = (document.body ? document.body.innerText : '').slice(0, 4000);
  const hay = `${title}\n${text}`.toLowerCase();
  const pats = ['just a moment', 'verify you are human', 'are you a robot', 'unusual traffic', 'prove your humanity', 'checking your browser',
    'attention required', 'captcha', 'press & hold', 'confirm you’re not a bot', "confirm you're not a bot", 'access denied', 'enable javascript and cookies'];
  const hit = pats.find((p) => hay.includes(p));
  return { title, hit: hit ?? null, textLen: text.length, url: location.href };
}

/** 生词标记统计：数量、违规位置（代码/输入区等）、交互元素内、行高膨胀、容器溢出 */
function markStats({ forbid }) {
  const vh = innerHeight;
  const pick = (tag) => [...document.getElementsByTagName(tag)];
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const one = (tag, wordOf) => {
    const marks = pick(tag);
    const violations = [];
    for (const sel of forbid) {
      let n = 0;
      const samples = [];
      for (const m of marks) {
        let host = null;
        try { host = m.parentElement && m.parentElement.closest(sel); } catch { break; }
        if (host) { n++; if (samples.length < 3) samples.push(`${wordOf(m)} @ ${describe(host)}`); }
      }
      if (n) violations.push({ selector: sel, count: n, samples });
    }
    const interactive = {};
    for (const sel of ['a', 'button', '[role=button]', 'nav', 'label', 'h1,h2,h3', 'th,td', 'summary']) {
      interactive[sel] = marks.filter((m) => m.parentElement && m.parentElement.closest(sel)).length;
    }
    // 行高膨胀：单行 mark 的高度相对父元素 line-height（只看前 4 屏内的前 400 个）
    let checked = 0, inflated = 0;
    const inflateSamples = [];
    const overflow = [];
    const seenContainers = new Set();
    for (const m of marks) {
      const r = m.getBoundingClientRect();
      if (r.width === 0 || r.top + scrollY > vh * 4) continue;
      if (++checked > 400) break;
      const p = m.parentElement;
      const cs = getComputedStyle(p);
      const fs = parseFloat(cs.fontSize) || 16;
      const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight) || fs * 1.2;
      if (m.getClientRects().length === 1 && r.height > lh * 1.15 + 1) {
        inflated++;
        if (inflateSamples.length < 5) inflateSamples.push({ word: wordOf(m), markH: Math.round(r.height), lineH: Math.round(lh), parent: describe(p) });
      }
      // 小容器（按钮/链接卡片/表格单元）被行内译文撑出溢出
      const box = p.closest('button,[role=button],a,li,td,th,h1,h2,h3,h4');
      if (box && !seenContainers.has(box)) {
        seenContainers.add(box);
        const bcs = getComputedStyle(box);
        if (/(hidden|clip)/.test(bcs.overflow + bcs.overflowX) && box.scrollWidth > box.clientWidth + 2 && overflow.length < 8) {
          overflow.push({ word: wordOf(m), container: describe(box), scrollW: box.scrollWidth, clientW: box.clientWidth });
        }
      }
    }
    const inView = marks.filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < vh; }).length;
    return { count: marks.length, inView, violations, interactive, lineCheck: { checked: Math.min(checked, 400), inflated, samples: inflateSamples }, overflow };
  };
  const ours = one('hnw-mark', (m) => m.getAttribute('data-lemma'));
  ours.lemmas = new Set(pick('hnw-mark').map((m) => m.getAttribute('data-lemma'))).size;
  ours.translations = pick('hnw-tr').filter((t) => t.getAttribute('data-tr')).length;
  const relingo = one('relin-highlight', (m) => (m.textContent || '').trim().slice(0, 20));
  return { ours, relingo, nodes: document.getElementsByTagName('*').length, scrollHeight: document.documentElement.scrollHeight };
}

/** 视口内高亮的矩形（CSS px，视口坐标），用于热力图里区分“生词标记本身”的像素 */
function markRects() {
  const out = [];
  for (const tag of ['hnw-mark', 'relin-highlight']) {
    for (const m of document.getElementsByTagName(tag)) {
      for (const r of m.getClientRects()) {
        if (r.bottom > 0 && r.top < innerHeight && r.width > 0) out.push([r.left, r.top, r.width, r.height]);
      }
      if (out.length > 3000) return out;
    }
  }
  return out;
}

/** 布局抽样：主要元素的文档坐标 + 文本键（innerText 不含 ::before 生成的译文） */
function layoutSample() {
  const SEL = 'h1,h2,h3,h4,p,li,blockquote,table,pre,img,video,button,a,nav,header,footer,input,textarea,figure,[contenteditable=true],[role=button],[role=navigation],[role=textbox],article,aside';
  const limit = innerHeight * 4;
  const seen = new Map();
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (el.closest('hnw-card-host,relingo-app')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const top = r.top + scrollY;
    if (top > limit || top + r.height < 0) continue;
    const tag = el.tagName.toLowerCase();
    let text = '';
    if (tag === 'img' || tag === 'video') text = (el.getAttribute('src') || '').slice(-50);
    else text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    if (!text && !['img', 'video', 'input', 'textarea', 'nav', 'header', 'footer', 'table'].includes(tag)) continue;
    const base = `${tag}|${text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const hasMark = !!el.querySelector('hnw-mark,relin-highlight');
    out.push({ k: `${base}|${n}`, x: Math.round(r.left), y: Math.round(top), w: Math.round(r.width), h: Math.round(r.height), m: hasMark ? 1 : 0 });
    if (out.length >= 1500) break;
  }
  return out;
}

/** 可编辑区快照：内部标记数量 + 内容（textarea 取 value，其余取 innerHTML 长度与摘要） */
function editableSnapshot(selectors) {
  const out = [];
  for (const sel of selectors) {
    let els = [];
    try { els = [...document.querySelectorAll(sel)]; } catch {}
    els.slice(0, 5).forEach((el, i) => {
      const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      const content = isField ? el.value : el.innerHTML;
      out.push({ sel, i, tag: el.tagName.toLowerCase(), marks: el.querySelectorAll('hnw-mark,hnw-tr,relin-highlight').length, len: content.length, head: content.slice(0, 200) });
    });
  }
  return out;
}

// ---------------- Node 侧工具 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null);
const mainEval = (page, fn, arg) => page.evaluate(fn, arg, undefined, false);

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(list.map((x) => [x.name, x.value]));
  return {
    ts: m.Timestamp * 1000, // TimeTicks ms，与 CPU profile 同一时钟
    scriptMs: Math.round(m.ScriptDuration * 1000),
    taskMs: Math.round(m.TaskDuration * 1000),
    layoutMs: Math.round(m.LayoutDuration * 1000),
    styleMs: Math.round(m.RecalcStyleDuration * 1000),
    heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2),
    nodes: m.Nodes,
  };
}

/**
 * CPU profile 归因：每个采样按调用栈判定归属（栈中任一帧来自某扩展 → 该扩展；否则页面/空闲/GC/其他），
 * 返回 { owners: { [owner]: ms }, sampleAt(tStartMs,tEndMs) } 用于按阶段/长任务窗口统计。
 */
function analyzeProfile(profile, extIds) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const owner = new Map();
  const walk = (node, inherited) => {
    let o = inherited;
    if (!o) {
      const url = node.callFrame.url || '';
      const ext = url.startsWith('chrome-extension://') ? url.slice(19).split('/')[0] : null;
      if (ext) o = extIds[ext] ?? 'other-ext';
    }
    const fn = node.callFrame.functionName;
    const self = o ?? (fn === '(idle)' ? 'idle' : fn === '(garbage collector)' ? 'gc' : fn === '(program)' ? 'program' : (node.callFrame.url ? 'page' : null));
    owner.set(node.id, self ?? 'page');
    for (const c of node.children ?? []) walk(byId.get(c), o);
  };
  walk(profile.nodes[0], null);
  // 采样时间轴（µs → ms）
  const samples = [];
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i];
    const dur = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    samples.push([t / 1000, dur, owner.get(profile.samples[i])]);
  }
  const sum = (from, to) => {
    const acc = {};
    for (const [ts, dur, o] of samples) if (ts >= from && ts < to) acc[o] = (acc[o] ?? 0) + dur;
    for (const k in acc) acc[k] = Math.round(acc[k]);
    return acc;
  };
  return { sum };
}

// ---------------- 扩展/浏览器上下文 ----------------
async function launchConfig(chromium, cfg, vpName, needXCookies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `compat-${cfg}-${vpName}-`));
  const exts = cfg === 'ours' ? [EXT] : cfg === 'relingo' ? [RELINGO_EXT] : [];
  if (cfg === 'relingo') {
    // 复制登录态 profile，避免改动原始采集环境；去掉单例锁
    fs.cpSync(RELINGO_PROFILE, dir, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(path.join(dir, f), { force: true });
  }
  const launchArgs = [
    // xvfb 下多个窗口互相遮挡时 Chromium 会降频/暂停渲染，三组都关掉以免测量失真
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--no-first-run', '--no-default-browser-check',
  ];
  if (exts.length) launchArgs.push(`--disable-extensions-except=${exts.join(',')}`, `--load-extension=${exts.join(',')}`);
  const ctx = await chromium.launchPersistentContext(dir, { headless: false, channel: 'chromium', args: launchArgs, locale: 'en-US', ...VIEWPORTS[vpName] });
  await ctx.addInitScript(initScript);
  if (needXCookies) await ctx.addCookies(readXCookies());
  const extIds = {};
  if (exts.length) {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
    const id = new URL(sw.url()).host;
    extIds[id] = cfg;
    if (cfg === 'ours') {
      // 等后台初始化写出默认 settings，再深合并测试设置
      await sw.evaluate(async (patch) => {
        for (let i = 0; i < 50 && !(await chrome.storage.local.get('settings')).settings; i++) await new Promise((r) => setTimeout(r, 100));
        const cur = (await chrome.storage.local.get('settings')).settings ?? {};
        const merge = (a, b) => {
          if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object') return b === undefined ? a : b;
          const o = { ...a };
          for (const k of Object.keys(b)) o[k] = merge(a[k], b[k]);
          return o;
        };
        await chrome.storage.local.set({ settings: merge(cur, patch) });
      }, OURS_SETTINGS);
    }
    await sleep(1500);
    // 关掉扩展安装时自动打开的引导页
    for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close().catch(() => {});
  }
  return { ctx, dir, extIds, cfg, vpName };
}

async function closeConfig(c) {
  await c.ctx.close().catch(() => {});
  fs.rmSync(c.dir, { recursive: true, force: true });
}

// ---------------- 单次运行 ----------------
async function gotoWithGate(page, url, settleMs) {
  const t0 = Date.now();
  let status = null;
  let navError = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    status = resp?.status() ?? null;
  } catch (e) {
    navError = String(e.message).split('\n')[0];
  }
  return { t0, status, navError };
}

async function waitLoaded(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
}

/** 遇到验证页：等待后复核，最多两次（不做任何绕过操作） */
async function checkGate(page) {
  const history = [];
  for (const wait of [0, 15000, 25000]) {
    if (wait) await sleep(wait);
    const g = await page.evaluate(detectGate).catch((e) => ({ hit: 'evaluate-failed', error: String(e.message).slice(0, 120) }));
    history.push(g);
    if (!g.hit) return { blocked: false, waitedMs: history.length > 1 ? 15000 * (history.length - 1) : 0, history };
  }
  return { blocked: true, history };
}

async function smoothScroll(page, totalPx, stepPx, intervalMs) {
  for (let y = 0; y < totalPx; y += stepPx) {
    await page.evaluate((dy) => window.scrollBy(0, dy), stepPx).catch(() => {});
    await sleep(intervalMs);
  }
}

/**
 * 跑一个站点 × 一个配置。light=true 仅用于预热（缓存、验证 cookie），只做导航与等待。
 * 返回指标对象；截图写入 SHOTS。
 */
async function runOnce(conf, site, url, { light = false, tag = 'measure' } = {}) {
  const { ctx, extIds, cfg, vpName } = conf;
  const page = await ctx.newPage();
  const res = { cfg, vp: vpName, site: site.id, tag, url };
  const cdp = await ctx.newCDPSession(page);
  try {
    const nav = await gotoWithGate(page, url, site.settleMs);
    res.httpStatus = nav.status;
    if (nav.navError) res.navError = nav.navError;
    // 导航提交后再开 Performance/Profiler（跨站导航会换渲染进程，提前开启会丢失）
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => {});
    if (!light) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }
    const tStart = (await metrics(cdp).catch(() => ({ ts: 0 }))).ts;
    await waitLoaded(page);
    const gate = await checkGate(page);
    res.gate = { blocked: gate.blocked, waitedMs: gate.waitedMs ?? null, hit: gate.history.at(-1).hit, title: gate.history.at(-1).title, finalUrl: page.url() };
    if (gate.history.some((g) => g.hit)) res.gate.firstHit = gate.history.find((g) => g.hit).hit;
    if (light) {
      await sleep(Math.min(site.settleMs, 5000));
      return res;
    }
    await sleep(site.settleMs);

    // ---- 首屏：性能指标 ----
    const shotBase = `${site.id}-${vpName}-${cfg}${tag === 'measure' ? '' : '-' + tag}`;
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(300);
    const mSettle = await metrics(cdp);
    const perfNow = await mainEval(page, () => performance.now()).catch(() => null);
    const clockOffset = perfNow == null ? null : mSettle.ts - perfNow; // TimeTicks(ms) = performance.now() + offset
    const perf = await mainEval(page, () => {
      const C = window.__compat ?? { lt: [], lcp: [], cls: [], firstMark: {} };
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { lt: C.lt, lcp: C.lcp, cls: C.cls, firstMark: C.firstMark, dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null, load: nav ? Math.round(nav.loadEventEnd) : null, fcp: fcp ? Math.round(fcp.startTime) : null };
    }).catch(() => null);
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    const heapSettle = (await metrics(cdp)).heapMB;
    res.settle = {
      lcp: perf?.lcp.at(-1)?.[0] ?? null,
      lcpElement: perf?.lcp.at(-1)?.[2] ?? null,
      fcp: perf?.fcp ?? null,
      dcl: perf?.dcl ?? null,
      load: perf?.load ?? null,
      cls: +(perf?.cls ?? []).reduce((a, e) => a + e[1], 0).toFixed(4),
      clsEntries: (perf?.cls ?? []).slice(0, 12),
      longTasks: perf?.lt ?? [],
      tbt: (perf?.lt ?? []).reduce((a, [, d]) => a + Math.max(0, d - 50), 0),
      firstMark: perf?.firstMark ?? {},
      scriptMs: mSettle.scriptMs, taskMs: mSettle.taskMs, layoutMs: mSettle.layoutMs, styleMs: mSettle.styleMs, heapMB: heapSettle, nodes: mSettle.nodes,
    };
    res.marks = await page.evaluate(markStats, { forbid: site.forbid }).catch((e) => ({ error: String(e.message).slice(0, 200) }));
    res.layoutTop = await page.evaluate(layoutSample).catch(() => []);
    res.rectsTop = await page.evaluate(markRects).catch(() => []);
    res.shotTop = path.join(SHOTS, `${shotBase}-top.png`);
    await page.screenshot({ path: res.shotTop, timeout: 20000 }).catch((e) => (res.shotError = String(e.message).slice(0, 120)));
    if (site.editable) res.editable = await page.evaluate(editableSnapshot, site.editable).catch(() => null);

    // ---- 滚动 3 屏：懒处理是否补上 ----
    const vh = VIEWPORTS[vpName].viewport.height;
    const tScroll0 = (await metrics(cdp)).ts;
    const ltBefore = perf?.lt.length ?? 0;
    await smoothScroll(page, vh * 3, Math.round(vh / 2), 250);
    await sleep(2500);
    const mScroll = await metrics(cdp);
    res.scroll3 = {
      marksInView: await page.evaluate(() => ({
        ours: [...document.getElementsByTagName('hnw-mark')].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; }).length,
        relingo: [...document.getElementsByTagName('relin-highlight')].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; }).length,
        scrollY: Math.round(scrollY),
      })).catch(() => null),
      scriptMs: mScroll.scriptMs - mSettle.scriptMs,
      taskMs: mScroll.taskMs - mSettle.taskMs,
    };
    res.rectsScroll3 = await page.evaluate(markRects).catch(() => []);
    res.shotScroll3 = path.join(SHOTS, `${shotBase}-scroll3.png`);
    await page.screenshot({ path: res.shotScroll3, timeout: 20000 }).catch(() => {});
    const ltAfterScroll = await mainEval(page, () => window.__compat?.lt ?? []).catch(() => []);
    res.scroll3.longTasks = ltAfterScroll.slice(ltBefore);
    const phases = [['load', tStart, mSettle.ts], ['scroll3', tScroll0, mScroll.ts]];

    // ---- 无限滚动：持续 N 秒 ----
    if (site.kind === 'infinite') {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      const mInf0 = await metrics(cdp);
      const marks0 = await page.evaluate(() => document.getElementsByTagName('hnw-mark').length + document.getElementsByTagName('relin-highlight').length).catch(() => 0);
      const lt0 = ltAfterScroll.length;
      // 帧率：rAF 计数，记录 >50ms 的帧间隔（掉帧/卡顿）
      await mainEval(page, () => {
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
      const fps = await mainEval(page, () => { const F = window.__compatFps; F.on = false; return { frames: F.frames, jank: F.jank, maxGap: Math.round(F.maxGap) }; }).catch(() => null);
      const mInf1 = await metrics(cdp);
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      const heapEnd = (await metrics(cdp)).heapMB;
      const ltAll = await mainEval(page, () => window.__compat?.lt ?? []).catch(() => []);
      const lts = ltAll.slice(lt0);
      res.infinite = {
        seconds: SCROLL_SECONDS,
        scrollY: await page.evaluate(() => Math.round(scrollY)).catch(() => null),
        marksAdded: (await page.evaluate(() => document.getElementsByTagName('hnw-mark').length + document.getElementsByTagName('relin-highlight').length).catch(() => 0)) - marks0,
        longTasks: lts,
        tbt: lts.reduce((a, [, d]) => a + Math.max(0, d - 50), 0),
        scriptMs: mInf1.scriptMs - mInf0.scriptMs,
        taskMs: mInf1.taskMs - mInf0.taskMs,
        layoutMs: mInf1.layoutMs - mInf0.layoutMs,
        heapStartMB: mInf0.heapMB,
        heapEndMB: heapEnd,
        heapGrowthMB: +(heapEnd - mInf0.heapMB).toFixed(2),
        nodesStart: mInf0.nodes,
        nodesEnd: mInf1.nodes,
        fps: fps ? { ...fps, avg: +(fps.frames / SCROLL_SECONDS).toFixed(1) } : null,
      };
      phases.push(['infinite', mInf0.ts, mInf1.ts]);
    }

    // ---- 可编辑区输入测试（只在本地编辑器 demo / 本地 fixture 中输入，不提交） ----
    if (site.typeTest) {
      const sentence = ' The government will consolidate its comprehensive strategy to mitigate the inevitable consequences.';
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        const loc = page.locator(site.typeTest).first();
        await loc.click({ timeout: 5000 });
        await page.keyboard.press('End');
        await page.keyboard.type(sentence, { delay: 5 });
        await sleep(3000);
        res.typeTest = await page.evaluate(({ sel, sentence }) => {
          const el = document.querySelector(sel);
          return { marksInside: el.querySelectorAll('hnw-mark,hnw-tr,relin-highlight').length, textKept: el.innerText.replace(/\s+/g, ' ').includes(sentence.trim()) };
        }, { sel: site.typeTest, sentence });
      } catch (e) {
        res.typeTest = { error: String(e.message).split('\n')[0] };
      }
    }

    // ---- SPA 路由切换 ----
    if (site.spa) {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        const before = page.url();
        await page.locator(site.spa.click).first().click({ timeout: 5000 });
        await sleep(7000);
        res.spa = { label: site.spa.label, from: before, to: page.url(), marks: await page.evaluate(markStats, { forbid: site.forbid }).then((s) => ({ ours: s.ours.count, oursInView: s.ours.inView, relingo: s.relingo.count, relingoInView: s.relingo.inView })) };
      } catch (e) {
        res.spa = { label: site.spa.label, error: String(e.message).split('\n')[0] };
      }
    }

    // ---- CPU 归因 ----
    const { profile } = await cdp.send('Profiler.stop');
    const prof = analyzeProfile(profile, extIds);
    res.cpu = Object.fromEntries(phases.map(([name, a, b]) => [name, prof.sum(a, b)]));
    // 长任务归因：窗口内某扩展采样占比 ≥ 50% 视为该扩展引发
    if (clockOffset != null) {
      const attribute = (list) => list.map(([st, d]) => {
        const s = prof.sum(st + clockOffset, st + d + clockOffset);
        const top = Object.entries(s).filter(([k]) => ['ours', 'relingo', 'other-ext'].includes(k)).sort((a, b) => b[1] - a[1])[0];
        return { start: st, dur: d, ext: top && top[1] >= d * 0.5 ? top[0] : null, extMs: top ? top[1] : 0 };
      });
      res.settle.longTasksAttr = attribute(res.settle.longTasks);
      res.scroll3.longTasksAttr = attribute(res.scroll3.longTasks);
      if (res.infinite) res.infinite.longTasksAttr = attribute(res.infinite.longTasks);
    }

    // ---- 控制台：此时才开 Runtime/Log，V8 回放已缓存消息 ----
    res.console = await collectConsole(cdp, extIds);
  } catch (e) {
    res.error = String(e.stack ?? e).slice(0, 600);
  } finally {
    await cdp.detach().catch(() => {});
    await page.close().catch(() => {});
  }
  return res;
}

async function collectConsole(cdp, extIds) {
  const contexts = new Map();
  const items = [];
  const attrUrl = (url) => {
    if (!url || !url.startsWith('chrome-extension://')) return null;
    return extIds[url.slice(19).split('/')[0]] ?? 'other-ext';
  };
  const attr = (frames, ctxId, extraUrl, text) => {
    for (const f of frames ?? []) { const a = attrUrl(f.url); if (a) return a; }
    const a = attrUrl(extraUrl) ?? attrUrl(contexts.get(ctxId)?.origin);
    if (a) return a;
    const m = /chrome-extension:\/\/([a-p]{32})/.exec(text ?? '');
    if (m) return extIds[m[1]] ?? 'other-ext';
    return 'page';
  };
  cdp.on('Runtime.executionContextCreated', (e) => contexts.set(e.context.id, e.context));
  cdp.on('Runtime.consoleAPICalled', (e) => {
    if (!['error', 'warning', 'assert'].includes(e.type)) return;
    const text = e.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
    items.push({ kind: `console.${e.type}`, level: e.type === 'warning' ? 'warning' : 'error', text, src: attr(e.stackTrace?.callFrames, e.executionContextId, null, text), url: e.stackTrace?.callFrames?.[0]?.url ?? null });
  });
  cdp.on('Runtime.exceptionThrown', (e) => {
    const d = e.exceptionDetails;
    const text = (d.exception?.description ?? d.text ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300);
    items.push({ kind: 'exception', level: 'error', text, src: attr(d.stackTrace?.callFrames, d.executionContextId, d.url, text), url: d.url ?? null });
  });
  cdp.on('Log.entryAdded', (e) => {
    if (!['error', 'warning'].includes(e.entry.level)) return;
    const text = e.entry.text.slice(0, 300);
    items.push({ kind: `log.${e.entry.source}`, level: e.entry.level, text, src: attr(null, null, e.entry.url, text), url: e.entry.url ?? null });
  });
  await cdp.send('Runtime.enable').catch(() => {});
  await cdp.send('Log.enable').catch(() => {});
  await sleep(1000);
  await cdp.send('Runtime.disable').catch(() => {});
  await cdp.send('Log.disable').catch(() => {});
  const count = (src, level) => items.filter((i) => i.src === src && i.level === level).length;
  return {
    counts: { pageErrors: count('page', 'error'), oursErrors: count('ours', 'error'), oursWarnings: count('ours', 'warning'), relingoErrors: count('relingo', 'error'), relingoWarnings: count('relingo', 'warning') },
    items: items.slice(0, 80),
  };
}

// ---------------- 对比：像素差 + 布局差 ----------------

/** 在无扩展的 headless 页面里用 canvas 计算像素差并生成热力图（避免引入 pngjs/pixelmatch 依赖） */
async function pixelDiff(toolPage, fileA, fileB, fileNoise, rects, dpr, outFile) {
  if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return null;
  const b64 = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : null);
  const r = await toolPage.evaluate(async ({ a, b, n, rects, dpr }) => {
    const load = async (s) => createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob());
    const [ia, ib, inn] = await Promise.all([load(a), load(b), n ? load(n) : null]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const pix = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = pix(ia), db = pix(ib), dn = inn && inn.width >= w && inn.height >= h ? pix(inn) : null;
    // 生词标记区域（外扩 3px）
    const mask = new Uint8Array(w * h);
    for (const [x, y, rw, rh] of rects) {
      const x0 = Math.max(0, Math.floor((x - 3) * dpr)), y0 = Math.max(0, Math.floor((y - 3) * dpr));
      const x1 = Math.min(w, Math.ceil((x + rw + 3) * dpr)), y1 = Math.min(h, Math.ceil((y + rh + 3) * dpr));
      for (let yy = y0; yy < y1; yy++) mask.fill(1, yy * w + x0, yy * w + x1);
    }
    const out = new ImageData(w, h);
    const o = out.data;
    let diff = 0, inMark = 0, outside = 0, noise = 0;
    const rowOutside = new Uint32Array(h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const d = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]), Math.abs(da[p + 2] - db[p + 2]));
      const g = (da[p] + da[p + 1] + da[p + 2]) / 3;
      let R = 200 + g * 0.2, G = R, B = R; // 浅灰底图
      if (d > 24) {
        diff++;
        const nd = dn ? Math.max(Math.abs(da[p] - dn[p]), Math.abs(da[p + 1] - dn[p + 1]), Math.abs(da[p + 2] - dn[p + 2])) : 0;
        if (nd > 24) { noise++; R = 240; G = 200; B = 60; } // 黄：页面自身波动（baseline 两次就不同）
        else if (mask[i]) { inMark++; R = 60; G = 120; B = 240; } // 蓝：生词标记本身
        else { outside++; rowOutside[Math.floor(i / w)]++; R = 230; G = 30; B = 30; } // 红：标记之外的变化（推移/错位）
      }
      o[p] = R; o[p + 1] = G; o[p + 2] = B; o[p + 3] = 255;
    }
    // 标记之外变化集中的纵向区间（CSS px），便于定位
    const bands = [];
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const hot = y < h && rowOutside[y] > w * 0.02;
      if (hot && start < 0) start = y;
      if (!hot && start >= 0) { if (y - start > 4 * dpr) bands.push([Math.round(start / dpr), Math.round(y / dpr)]); start = -1; }
    }
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(out, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const total = w * h;
    return { png: btoa(bin), diffPct: +(diff / total * 100).toFixed(2), markPct: +(inMark / total * 100).toFixed(2), outsidePct: +(outside / total * 100).toFixed(2), noisePct: +(noise / total * 100).toFixed(2), bands: bands.slice(0, 10) };
  }, { a: b64(fileA), b: b64(fileB), n: b64(fileNoise), rects, dpr });
  fs.writeFileSync(outFile, Buffer.from(r.png, 'base64'));
  delete r.png;
  return { ...r, heatmap: outFile };
}

/** 布局差：按元素键配对，排除 baseline 两次加载就不稳定的元素 */
function layoutDiff(base, base2, ext) {
  const T = 3;
  const idx = (list) => new Map(list.map((e) => [e.k, e]));
  const B = idx(base), B2 = idx(base2 ?? []), E = idx(ext);
  const unstable = new Set();
  if (base2) for (const [k, e] of B) { const o = B2.get(k); if (!o || Math.abs(o.y - e.y) > T || Math.abs(o.h - e.h) > T || Math.abs(o.x - e.x) > T || Math.abs(o.w - e.w) > T) unstable.add(k); }
  const pairs = [];
  for (const [k, b] of B) {
    if (unstable.has(k)) continue;
    const e = E.get(k);
    if (e) pairs.push({ k, b, e, dx: e.x - b.x, dy: e.y - b.y, dw: e.w - b.w, dh: e.h - b.h });
  }
  pairs.sort((p, q) => p.b.y - q.b.y);
  const markSelf = [], pushed = [], unexplained = [];
  let growthAbove = 0; // 上方含生词元素累计增高
  for (const p of pairs) {
    const moved = Math.abs(p.dx) > T || Math.abs(p.dy) > T;
    const resized = Math.abs(p.dw) > T || Math.abs(p.dh) > T;
    if (!moved && !resized) continue;
    const item = { key: p.k.slice(0, 80), dx: p.dx, dy: p.dy, dw: p.dw, dh: p.dh, y: p.b.y };
    if (p.e.m && resized && Math.abs(p.dx) <= T) markSelf.push(item);
    else if (!resized && Math.abs(p.dx) <= T && p.dy > 0 && growthAbove > 0 && p.dy <= growthAbove + T) pushed.push(item);
    else if (p.e.m && Math.abs(p.dx) <= T && p.dy > 0 && growthAbove > 0) pushed.push(item);
    else unexplained.push(item);
    if (p.e.m && p.dh > T) growthAbove = Math.max(growthAbove, p.dy + p.dh);
  }
  // 容器类元素（article/nav 等）包含子元素增高时自身变高是正常的：从 unexplained 中剔除“只变高、未移动、未变宽”的容器
  const containerTags = ['article', 'aside', 'nav', 'header', 'footer', 'table', 'figure', 'li', 'blockquote'];
  const realUnexplained = unexplained.filter((u) => !(containerTags.includes(u.key.split('|')[0]) && Math.abs(u.dx) <= T && Math.abs(u.dw) <= T && Math.abs(u.dy) <= T && u.dh > 0 && growthAbove > 0));
  return {
    sampled: base.length, paired: pairs.length, unstable: unstable.size,
    markSelf: markSelf.length, pushed: pushed.length, unexplained: realUnexplained.length,
    maxPushPx: Math.max(0, ...pushed.map((p) => p.dy)),
    horizontal: pairs.filter((p) => Math.abs(p.dx) > T || Math.abs(p.dw) > T).length,
    samples: { markSelf: markSelf.slice(0, 6), pushed: pushed.slice(0, 4), unexplained: realUnexplained.slice(0, 10) },
  };
}

function judge(base, ext) {
  if (!base?.settle || !ext?.settle) return null;
  const lcpB = base.settle.lcp, lcpE = ext.settle.lcp;
  const lcpDelta = lcpB != null && lcpE != null ? lcpE - lcpB : null;
  const lcpLimit = lcpB != null ? Math.max(lcpB * THRESHOLDS.lcpRatio, THRESHOLDS.lcpMs) : null;
  const extLts = [...(ext.settle.longTasksAttr ?? []), ...(ext.scroll3?.longTasksAttr ?? []), ...(ext.infinite?.longTasksAttr ?? [])].filter((t) => t.ext === ext.cfg);
  const maxExtLt = Math.max(0, ...extLts.map((t) => t.dur));
  const clsDelta = +(ext.settle.cls - base.settle.cls).toFixed(4);
  return {
    lcpDelta, lcpLimit: lcpLimit && Math.round(lcpLimit), lcpPass: lcpDelta == null ? null : lcpDelta < lcpLimit,
    extLongTasks: extLts.length, maxExtLongTask: maxExtLt, longTaskPass: maxExtLt <= THRESHOLDS.extLongTaskMs,
    tbtDelta: ext.settle.tbt - base.settle.tbt,
    clsDelta, clsPass: clsDelta <= THRESHOLDS.clsDelta,
    scriptDelta: ext.settle.scriptMs - base.settle.scriptMs,
    heapDeltaMB: +(ext.settle.heapMB - base.settle.heapMB).toFixed(2),
  };
}

// ---------------- 主流程 ----------------
if (args.build) buildExtension();
if (CONFIG_NAMES.includes('ours') && !fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`扩展未构建：${EXT}（加 --build）`);
const chromium = await loadChromium();
const server = sites.some((s) => s.fixture) ? await startFixtureServer() : null;
const urlOf = (s) => (s.fixture ? `http://127.0.0.1:${server.address().port}/${s.fixture}` : s.url);
const needX = sites.some((s) => s.cookies === 'x');
const toolBrowser = await chromium.launch({ headless: true });
const toolPage = await toolBrowser.newPage();
const all = [];

async function runViewport(vpName) {
  const confs = {};
  const ensure = async (cfg) => {
    if (!confs[cfg] || !confs[cfg].ctx.pages) confs[cfg] = await launchConfig(chromium, cfg, vpName, needX);
    return confs[cfg];
  };
  for (const site of sites) {
    const url = urlOf(site);
    const entry = { site: site.id, name: site.name, url, vp: vpName, runs: {}, at: new Date().toISOString() };
    console.log(`[compat] ${vpName} ${site.id} 开始`);
    for (const cfg of CONFIG_NAMES) {
      let conf;
      try {
        conf = await ensure(cfg);
        // 预热：缓存、验证页 cookie；baseline 额外完整跑一遍作为“页面自身波动”噪声参照
        const warm = await runOnce(conf, site, url, cfg === 'baseline' ? { tag: 'noise' } : { light: true, tag: 'warm' });
        const run = await runOnce(conf, site, url);
        run.warmGate = warm.gate;
        entry.runs[cfg] = run;
        if (cfg === 'baseline') entry.noise = warm;
      } catch (e) {
        entry.runs[cfg] = { cfg, error: String(e.stack ?? e).slice(0, 600) };
        if (conf) { await closeConfig(conf); delete confs[cfg]; }
      }
    }
    // 对比
    const base = entry.runs.baseline;
    const dpr = VIEWPORTS[vpName].deviceScaleFactor;
    entry.compare = {};
    for (const cfg of CONFIG_NAMES.filter((c) => c !== 'baseline')) {
      const ext = entry.runs[cfg];
      if (!base?.settle || !ext?.settle) continue;
      const c = (entry.compare[cfg] = { judge: judge(base, ext) });
      c.layout = layoutDiff(base.layoutTop ?? [], entry.noise?.layoutTop, ext.layoutTop ?? []);
      c.pixelTop = await pixelDiff(toolPage, base.shotTop, ext.shotTop, entry.noise?.shotTop, ext.rectsTop ?? [], dpr, path.join(SHOTS, `${site.id}-${vpName}-diff-${cfg}-top.png`)).catch((e) => ({ error: String(e.message).slice(0, 200) }));
      c.pixelScroll3 = await pixelDiff(toolPage, base.shotScroll3, ext.shotScroll3, entry.noise?.shotScroll3, ext.rectsScroll3 ?? [], dpr, path.join(SHOTS, `${site.id}-${vpName}-diff-${cfg}-scroll3.png`)).catch((e) => ({ error: String(e.message).slice(0, 200) }));
    }
    // 结果文件不保留大数组（布局样本/矩形），只留摘要
    for (const r of [...Object.values(entry.runs), entry.noise].filter(Boolean)) { delete r.layoutTop; delete r.rectsTop; delete r.rectsScroll3; }
    fs.writeFileSync(path.join(RESULTS, `${site.id}-${vpName}.json`), JSON.stringify(entry, null, 2));
    all.push(entry);
    const j = entry.compare.ours?.judge;
    console.log(`[compat] ${vpName} ${site.id} 完成 ours: marks=${entry.runs.ours?.marks?.ours?.count ?? '-'} lcpΔ=${j?.lcpDelta ?? '-'} clsΔ=${j?.clsDelta ?? '-'} maxExtLT=${j?.maxExtLongTask ?? '-'} oursErr=${entry.runs.ours?.console?.counts?.oursErrors ?? '-'}`);
  }
  for (const c of Object.values(confs)) await closeConfig(c);
}

await Promise.all(VIEWPORT_NAMES.map((vp) => runViewport(vp)));
await toolBrowser.close();
server?.close();
const allFile = path.join(RESULTS, offlineMode ? 'all-offline.json' : 'all.json');
// 分批运行时合并已有结果（同 site+vp 以新结果为准）
let merged = all;
if (fs.existsSync(allFile) && (args.sites || args.group)) {
  const prev = JSON.parse(fs.readFileSync(allFile, 'utf8'));
  const keys = new Set(all.map((e) => `${e.site}|${e.vp}`));
  merged = [...prev.filter((e) => !keys.has(`${e.site}|${e.vp}`)), ...all];
}
fs.writeFileSync(allFile, JSON.stringify(merged, null, 2));

// offline 模式：按阈值给退出码，便于回归
if (offlineMode) {
  const fails = [];
  for (const e of all) {
    const j = e.compare.ours?.judge;
    const m = e.runs.ours?.marks?.ours;
    if (!j) { fails.push(`${e.site}/${e.vp}: 无结果`); continue; }
    if (j.lcpPass === false) fails.push(`${e.site}/${e.vp}: LCP 增量 ${j.lcpDelta}ms > ${j.lcpLimit}ms`);
    if (!j.longTaskPass) fails.push(`${e.site}/${e.vp}: 扩展长任务 ${j.maxExtLongTask}ms`);
    if (!j.clsPass) fails.push(`${e.site}/${e.vp}: CLS 增量 ${j.clsDelta}`);
    if (m?.violations?.length) fails.push(`${e.site}/${e.vp}: 禁标区域出现高亮 ${m.violations.map((v) => `${v.selector}×${v.count}`).join(', ')}`);
    if (e.runs.ours?.console?.counts?.oursErrors) fails.push(`${e.site}/${e.vp}: 扩展报错 ${e.runs.ours.console.counts.oursErrors} 条`);
    if (e.runs.ours?.typeTest && (e.runs.ours.typeTest.marksInside || !e.runs.ours.typeTest.textKept)) fails.push(`${e.site}/${e.vp}: 可编辑区被改动`);
  }
  console.log(fails.length ? `[compat] 阈值未通过：\n  ${fails.join('\n  ')}` : '[compat] offline 阈值全部通过');
  process.exitCode = fails.length ? 1 : 0;
}
console.log(`[compat] 结果：${allFile}`);
