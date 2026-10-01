#!/usr/bin/env node
/**
 * 生成 tests/fixtures/sites 下的离线快照（精简 DOM），供 `run.mjs --offline` 回归。
 *
 * 用法：node scripts/compat/snapshot.mjs [--sites off-wikipedia,off-mdn] [--max-kb 300] [--no-xvfb]
 *   站点取 sites.json 中 group=offline 且带 `snapshotOf`（对应 live 站点 id）的条目；editable.html 为手工 fixture，不由本脚本生成。
 *
 * 精简规则（体积与版权：只保留回归需要的结构与文本）：
 * - 去掉 script / noscript / iframe / object / embed / link（样式表内联后删除）/ meta（charset、viewport 除外）、HTML 注释、内联事件属性；
 * - 图片、视频、canvas、picture 换成同尺寸的灰色占位块；大段内联 SVG 换成同尺寸空占位；
 * - 页面全部样式表（含跨域，用 Node 侧拉取）合并后，只保留选择器命中精简后 DOM 的规则（@media/@supports 递归过滤，@font-face/@import 丢弃），
 *   CSS 自定义属性按 var() 引用闭包裁剪；
 * - 删除 display:none 的子树（折叠菜单、语言列表等）；超出体积上限时，按文档纵坐标从下往上截断（保留前若干屏），二分查找满足上限的最大截断高度；
 * - 链接改成绝对地址，文件头注释写明来源、抓取时间与用途。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = path.join(ROOT, 'scripts/compat');
const OUT_DIR = path.join(ROOT, 'tests/fixtures/sites');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--no-xvfb') args['no-xvfb'] = true;
  else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
// 与 run.mjs 一致：有头 Chromium 套 xvfb，降低被识别为自动化的概率
if (!args['no-xvfb'] && !process.env.COMPAT_IN_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, COMPAT_IN_XVFB: '1' } });
  process.exit(r.status ?? 1);
}
const MAX_BYTES = Number(args['max-kb'] ?? 300) * 1024;

const siteFile = JSON.parse(fs.readFileSync(path.join(HERE, 'sites.json'), 'utf8'));
const liveById = new Map(siteFile.sites.map((s) => [s.id, s]));
let targets = siteFile.sites.filter((s) => s.group === 'offline' && s.snapshotOf);
if (args.sites) targets = targets.filter((s) => args.sites.split(',').includes(s.id));

async function loadChromium() {
  try {
    return (await import('patchright')).chromium;
  } catch {}
  const globalRoot = execSync('npm root -g').toString().trim();
  return createRequire(`${globalRoot}/`)('patchright').chromium;
}

/** 页面内：收集样式表文本（同源直接读 cssRules，跨域返回 href 交给 Node 拉取） */
function collectSheets() {
  const out = [];
  for (const sh of document.styleSheets) {
    try {
      out.push({ text: [...sh.cssRules].map((r) => r.cssText).join('\n'), media: sh.media?.mediaText || '' });
    } catch {
      out.push({ href: sh.href, media: sh.media?.mediaText || '' });
    }
  }
  return out;
}

/**
 * 页面内：精简 DOM 并按 cutY（文档纵坐标）截断，返回序列化 HTML（样式另行注入）。
 * 在克隆上操作前先读取原始几何信息，保证占位尺寸和截断位置基于真实渲染。
 */
function buildSnapshot({ cutY, css, meta }) {
  // 1) 在原 DOM 上记录几何（data-snap-* 临时属性），克隆后使用
  let seq = 0;
  const geo = new Map();
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    el.setAttribute('data-snap-id', String(++seq));
    // display:none 的子树（折叠菜单、语言列表等）不参与渲染，快照里直接删除以控制体积
    geo.set(String(seq), { top: r.top + scrollY, w: Math.round(r.width), h: Math.round(r.height), none: getComputedStyle(el).display === 'none', invisible: getComputedStyle(el).visibility !== 'visible' });
  }
  // 整棵子树都没有可见的渲染面积（收起的菜单、visibility:hidden 的下拉层、弹层模板等）也视同不可见。后序遍历：自身或任一后代有面积即可见
  const visible = (el) => {
    let v = false;
    for (const c of el.children) if (visible(c)) v = true;
    const g = geo.get(el.getAttribute('data-snap-id'));
    if (g && !g.invisible && (g.w > 0 || g.h > 0)) v = true;
    if (g && !v && el.tagName !== 'BR' && !el.closest('head')) g.none = true;
    return v;
  };
  visible(document.body);
  const root = document.documentElement.cloneNode(true);
  for (const el of document.body.querySelectorAll('[data-snap-id]')) el.removeAttribute('data-snap-id');

  const drop = 'script,noscript,iframe,object,embed,link,style,template,meta:not([charset]):not([name=viewport]),base';
  root.querySelectorAll(drop).forEach((e) => e.remove());
  // 截断：整块位于 cutY 之下的元素删除（从后往前，先删深层）
  const all = [...root.querySelectorAll('body [data-snap-id]')].reverse();
  for (const el of all) {
    const g = geo.get(el.getAttribute('data-snap-id'));
    if (g && (g.none || g.top > cutY) && root.contains(el)) el.remove(); // 克隆树脱离文档，isConnected 恒为 false，用 contains 判断是否已随祖先删除
  }
  const placeholder = (el, g, label) => {
    const d = document.createElement('div');
    d.setAttribute('data-snap-placeholder', label);
    const disp = g.w && g.h ? `display:inline-block;width:${g.w}px;height:${g.h}px;max-width:100%;` : 'display:none;';
    d.setAttribute('style', `${disp}background:#d9d9d9;vertical-align:middle`);
    el.replaceWith(d);
  };
  for (const el of root.querySelectorAll('img,video,canvas,picture,audio')) {
    if (!root.contains(el)) continue;
    placeholder(el, geo.get(el.getAttribute('data-snap-id')) ?? { w: 0, h: 0 }, el.tagName.toLowerCase());
  }
  for (const el of root.querySelectorAll('svg')) {
    if (root.contains(el) && el.outerHTML.length > 600) placeholder(el, geo.get(el.getAttribute('data-snap-id')) ?? { w: 0, h: 0 }, 'svg');
  }
  // 属性清理：事件、data-*（站点运行时状态，体积大）、srcset 等；链接转绝对地址
  for (const el of root.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name;
      if (n.startsWith('on') || n === 'srcset' || n === 'nonce' || n === 'integrity' || (n.startsWith('data-') && n !== 'data-snap-placeholder' && n !== 'data-testid')) el.removeAttribute(n);
      // 框架序列化的超长属性（如 Guardian 的 <gu-island props>）与渲染无关
      else if (a.value.length > 1000 && !['href', 'src', 'd', 'style', 'class'].includes(n)) el.removeAttribute(n);
    }
    if (el.tagName === 'A' && el.getAttribute('href')) {
      try { el.setAttribute('href', new URL(el.getAttribute('href'), location.href).href); } catch {}
    }
  }
  // 注释节点
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());
  // 缩进类空白折叠为单个空格（pre/code/textarea 内保留，保证等宽排版与禁标检测不变）
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const t = tw.currentNode;
    if (/\s{2,}/.test(t.data) && !t.parentElement?.closest('pre,code,textarea,[style*="pre"]')) t.data = t.data.replace(/\s{2,}/g, ' ');
  }

  // 2) 样式过滤：只保留命中精简 DOM 的规则（在一个脱离文档的 HTML 文档里匹配）
  const doc = document.implementation.createHTMLDocument('');
  doc.replaceChild(doc.importNode(root, true), doc.documentElement);
  const matches = (selText) => {
    // 去掉伪类/伪元素后再匹配：:hover、::before 等规则只要宿主元素存在就保留
    const parts = selText.split(',');
    return parts.some((p) => {
      const s = p.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, (m) => (/^:(not|is|where|has)\(/.test(m) ? m : '')).trim() || '*';
      try { return !!doc.querySelector(s); } catch { return false; }
    });
  };
  // 第一遍：按选择器筛出命中的规则树（保留 @media/@supports/@layer 嵌套）
  const pick = (rules) => {
    const out = [];
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        if (r.selectorText.startsWith(':root') || r.selectorText === 'html' || r.selectorText === 'body' || matches(r.selectorText)) out.push({ rule: r });
      } else if (r instanceof CSSMediaRule || (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule)) {
        // 高对比度/打印/减弱动效等与回归无关的媒体条件整体丢弃
        if (/forced-colors|print|prefers-reduced-motion|prefers-contrast/.test(r.conditionText)) continue;
        const inner = pick(r.cssRules);
        if (inner.length) out.push({ wrap: `@${r instanceof CSSMediaRule ? 'media' : 'supports'} ${r.conditionText}`, inner });
      } else if (r.constructor.name === 'CSSLayerBlockRule') {
        out.push(...pick(r.cssRules));
      }
      // @font-face/@keyframes/@import 等丢弃：字体与动画对回归无意义
    }
    return out;
  };
  const trees = [];
  for (const { text, media } of css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text.replace(/@import[^;]+;/g, ''));
      const inner = pick(sheet.cssRules);
      if (inner.length) trees.push(media && media !== 'all' ? [{ wrap: `@media ${media}`, inner }] : inner);
    } catch {}
  }
  // 第二遍：CSS 变量按引用闭包裁剪。设计系统（如 GitHub Primer）在 :root 上声明上千个主题变量，只保留被用到的
  const styleRules = [];
  const walkRules = (list) => list.forEach((n) => (n.rule ? styleRules.push(n.rule) : walkRules(n.inner)));
  trees.forEach(walkRules);
  const varRe = /var\(\s*(--[\w-]+)/g;
  const used = new Set();
  const defs = new Map();
  for (const r of styleRules) {
    for (const p of r.style) {
      const v = r.style.getPropertyValue(p);
      if (p.startsWith('--')) { if (!defs.has(p)) defs.set(p, []); defs.get(p).push(v); } else for (const m of v.matchAll(varRe)) used.add(m[1]);
    }
  }
  for (const el of root.querySelectorAll('[style]')) for (const m of el.getAttribute('style').matchAll(varRe)) used.add(m[1]);
  const queue = [...used];
  while (queue.length) for (const v of defs.get(queue.pop()) ?? []) for (const m of v.matchAll(varRe)) if (!used.has(m[1])) { used.add(m[1]); queue.push(m[1]); }
  const serialize = (r) => {
    const decl = [];
    for (const p of r.style) {
      if (p.startsWith('--') && !used.has(p)) continue;
      decl.push(`${p}:${r.style.getPropertyValue(p)}${r.style.getPropertyPriority(p) ? '!important' : ''}`);
    }
    return decl.length ? `${r.selectorText}{${decl.join(';')}}` : '';
  };
  const emit = (list) => list.map((n) => (n.rule ? serialize(n.rule) : ((t) => (t ? `${n.wrap}{${t}}` : ''))(emit(n.inner)))).filter(Boolean).join('\n');
  const kept = trees.map(emit).filter(Boolean);
  root.querySelectorAll('[data-snap-id]').forEach((e) => e.removeAttribute('data-snap-id'));
  const head = root.querySelector('head') ?? root.insertBefore(document.createElement('head'), root.firstChild);
  if (!head.querySelector('meta[charset]')) head.insertAdjacentHTML('afterbegin', '<meta charset="utf-8">');
  const style = document.createElement('style');
  style.textContent = kept.join('\n').replace(/url\((?!["']?data:)[^)]*\)/g, 'none');
  head.appendChild(style);
  return `<!doctype html>\n<!-- ${meta} -->\n${root.outerHTML}`;
}

const chromium = await loadChromium();
const dir = fs.mkdtempSync('/tmp/compat-snapshot-');
const ctx = await chromium.launchPersistentContext(dir, { headless: false, channel: 'chromium', locale: 'en-US', viewport: { width: 1280, height: 800 } });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const t of targets) {
  const live = liveById.get(t.snapshotOf);
  const page = await ctx.newPage();
  try {
    await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    // 先滚动触发懒加载内容，再回顶
    for (let i = 0; i < 8; i++) { await page.evaluate(() => scrollBy(0, innerHeight)); await page.waitForTimeout(300); }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(800);
    const sheets = await page.evaluate(collectSheets);
    for (const s of sheets) {
      if (s.href) s.text = await fetch(s.href).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    }
    const css = sheets.filter((s) => s.text);
    const meta = `离线快照：${live.url} ，抓取于 ${new Date().toISOString().slice(0, 10)}，由 scripts/compat/snapshot.mjs 精简（去脚本/iframe/图片，仅保留命中样式），仅用于本扩展兼容性回归测试；内容版权归原站点所有${live.url.includes('wikipedia.org') ? '（CC BY-SA 4.0）' : ''}`;
    // 内部滚动容器（如 Guardian）时 scrollHeight 只有一屏，取所有元素底边的最大值
    const fullH = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.body.querySelectorAll('*')].map((e) => e.getBoundingClientRect().bottom + scrollY)));
    // 二分查找满足体积上限的最大截断高度（至少保留 1 屏）
    let lo = 800, hi = fullH + 10, best = null;
    const tryCut = async (cutY) => page.evaluate(buildSnapshot, { cutY, css, meta });
    const whole = await tryCut(hi);
    if (Buffer.byteLength(whole) <= MAX_BYTES) best = { html: whole, cutY: hi };
    else {
      for (let i = 0; i < 9 && hi - lo > 200; i++) {
        const mid = Math.round((lo + hi) / 2);
        const html = await tryCut(mid);
        if (Buffer.byteLength(html) <= MAX_BYTES) { best = { html, cutY: mid }; lo = mid; } else hi = mid;
      }
      if (!best) best = { html: await tryCut(lo), cutY: lo };
    }
    fs.writeFileSync(path.join(OUT_DIR, t.fixture), best.html);
    console.log(`[snapshot] ${t.id} → ${t.fixture} ${(Buffer.byteLength(best.html) / 1024).toFixed(0)}KB，保留到 y=${best.cutY}/${fullH}`);
  } catch (e) {
    console.log(`[snapshot] ${t.id} 失败：${String(e.message).split('\n')[0]}`);
  } finally {
    await page.close().catch(() => {});
  }
}
await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });
