#!/usr/bin/env node
/** 实际文档快照上的连续滚动验收：分别测量整页与页面自带的纵向表格，不用停稳后的结果代替滚动覆盖。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const source = arg('--url', 'https://learn.chatgpt.com/docs/config-file/config-reference');
const cache = path.resolve(arg('--cache', '/tmp/hnw-continuous-scroll'));
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const label = arg('--label', 'current');
const mobile = process.argv.includes('--mobile');
const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
fs.mkdirSync(cache, { recursive: true });
const snapshotPath = path.join(cache, 'snapshot.html');
if (!fs.existsSync(snapshotPath) || process.argv.includes('--capture')) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport });
    const response = await page.goto(source, { waitUntil: 'networkidle', timeout: 45000 });
    assert.equal(response.status(), 200);
    const snapshot = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true), css = [], unreadable = [];
      for (const sheet of document.styleSheets) {
        try { css.push([...sheet.cssRules].map(rule => rule.cssText).join('\n')); }
        catch { unreadable.push(sheet.href); }
      }
      clone.querySelectorAll('script,noscript,style,link[rel="stylesheet"],link[rel="preload"],link[rel="modulepreload"]').forEach(el => el.remove());
      const style = document.createElement('style'); style.textContent = css.join('\n'); clone.querySelector('head').append(style);
      return { html: '<!doctype html>' + clone.outerHTML, title: document.title, url: location.href, unreadable };
    });
    assert.ok(!/just a moment|attention required|access denied/i.test(snapshot.title));
    assert.equal(snapshot.unreadable.length, 0, '快照不能丢失网页样式');
    fs.writeFileSync(snapshotPath, snapshot.html);
    delete snapshot.html;
    fs.writeFileSync(path.join(cache, 'source.json'), JSON.stringify(snapshot, null, 2));
  } finally { await browser.close(); }
}
const html = fs.readFileSync(snapshotPath);
const report = { label, source, viewport, snapshotSha256: createHash('sha256').update(html).digest('hex'),
  contentScriptSha256: createHash('sha256').update(fs.readFileSync(path.join(extension, 'content-scripts/content.js'))).digest('hex'),
  measurement: '实际页面HTML/CSS快照；持续wheel期间按原文偏移检查可见词的标记与计算样式；首访与返回都计入覆盖；外部资源隔离；桌面内层表格为原网页容器', scenarios: [], errors: [] };
const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-continuous-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
      settings.enabled = true; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after';
      const r = settings.reading; r.enabled = true; r.syntax.enabled = true; r.bionic.enabled = true; r.phrases.enabled = true;
      for (const key of ['negation', 'connectives', 'numbers', 'properNouns']) r.emphasis[key] = true;
      await chrome.storage.local.set({ settings }); return;
    }
    throw new Error('settings timeout');
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  if (process.argv.includes('--trace')) await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReturnAsStream' });
  const cpu = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(m => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(m.name)).map(m => [m.name, m.value]));
  const scenarios = mobile ? ['page'] : ['page', 'nested-table'];
  for (const scenario of scenarios) {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const setup = await page.evaluate(scenario => {
      const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
      const originalText = root.textContent;
      const nested = [...root.querySelectorAll('div')].find(el => el.clientHeight > 200 && el.scrollHeight > 5000 && /auto|scroll/.test(getComputedStyle(el).overflowY));
      if (scenario === 'nested-table' && !nested) return null;
      const target = scenario === 'nested-table' ? nested : root;
      if (scenario === 'nested-table') target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const probes = [...target.querySelectorAll('p,td,li')].filter(el => {
        if (el.closest('nav,header,footer,aside,pre,code,button,[hidden],[aria-hidden="true"]') || el.querySelector('p,li,td')) return false;
        return (el.textContent.match(/[A-Za-z]+/g) ?? []).length >= 3 && el.getBoundingClientRect().width > 0;
      }).map(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node, offset = 0;
        while ((node = walker.nextNode())) {
          if (!node.parentElement.closest('code,pre')) {
            const match = /\b[A-Za-z]{3,}\b/.exec(node.data);
            if (match) {
              const clips = []; for (let parent = el.parentElement; parent; parent = parent.parentElement) {
                const css = getComputedStyle(parent); if (/(auto|scroll|hidden|clip)/.test(css.overflowX + css.overflowY)) clips.push(parent);
              }
              return { el, offset: offset + match.index, word: match[0], clips };
            }
          }
          offset += node.length;
        }
      }).filter(Boolean);
      const state = window.__continuous = { root, originalText, target, probes, frames: [], samples: [], tasks: [], phase: 'warmup', running: true };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) state.tasks.push({ at: entry.startTime, duration: entry.duration, phase: state.phase }); }).observe({ type: 'longtask' });
      let previous, lastSample = 0;
      const sample = now => {
        if (!state.running) return;
        state.frames.push({ at: now, interval: previous === undefined ? 0 : now - previous, phase: state.phase }); previous = now;
        if (now - lastSample >= 50) {
          lastSample = now; let visible = 0, marked = 0, styled = 0;
          for (const probe of probes) {
            const box = probe.el.getBoundingClientRect();
            if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) continue;
            if (probe.clips.some(el => { const clip = el.getBoundingClientRect(); return box.bottom <= clip.top || box.top >= clip.bottom || box.right <= clip.left || box.left >= clip.right; })) continue;
            const walker = document.createTreeWalker(probe.el, NodeFilter.SHOW_TEXT); let node, offset = 0;
            while ((node = walker.nextNode())) { if (offset + node.length > probe.offset) break; offset += node.length; }
            if (!node) continue;
            const range = document.createRange(); range.setStart(node, probe.offset - offset); range.setEnd(node, Math.min(node.length, probe.offset - offset + probe.word.length));
            const wordBox = range.getBoundingClientRect();
            if (wordBox.bottom <= 0 || wordBox.top >= innerHeight || probe.clips.some(el => { const clip = el.getBoundingClientRect(); return wordBox.bottom <= clip.top || wordBox.top >= clip.bottom || wordBox.right <= clip.left || wordBox.left >= clip.right; })) continue;
            visible++;
            const mark = node.parentElement.closest('[data-pos],[data-emphasis],[data-bionic],[data-hnw-reading-word]');
            if (mark && node.data.slice(probe.offset - offset, probe.offset - offset + probe.word.length) === probe.word) {
              marked++; const css = getComputedStyle(mark); if (css.textDecorationLine !== 'none' || css.backgroundImage !== 'none' || mark.hasAttribute('data-prefix')) styled++;
            }
          }
          state.samples.push({ at: now, phase: state.phase, visible, marked, styled, y: scenario === 'nested-table' ? target.scrollTop : scrollY + document.body.scrollTop });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return { probes: probes.length, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
    }, scenario);
    if (!setup) { report.scenarios.push({ scenario, skipped: '没有页面自带的纵向长表格' }); continue; }
    await page.waitForTimeout(2000);
    const initialCpu = await cpu();
    const bounds = await page.evaluate(() => window.__continuous.target.getBoundingClientRect().toJSON());
    const moveMouse = async () => page.mouse.move(scenario === 'nested-table' ? Math.min(viewport.width - 30, bounds.x + bounds.width / 2) : Math.max(8, bounds.x - 8), scenario === 'nested-table' ? bounds.y + Math.min(bounds.height - 30, 250) : 350);
    await moveMouse();
    for (const [phase, direction] of [['down', 1], ['up', -1], ['down-again', 1], ['up-again', -1]]) {
      await page.evaluate(phase => { window.__continuous.phase = phase; }, phase);
      for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, direction * (scenario === 'nested-table' ? 120 : 180)); await page.waitForTimeout(60); }
    }
    await page.evaluate(() => { window.__continuous.phase = 'settled'; }); await page.waitForTimeout(1000);
    const metrics = await page.evaluate(() => {
      const s = window.__continuous; s.running = false;
      return { phases: ['down', 'up', 'down-again', 'up-again', 'settled'].map(phase => {
        const samples = s.samples.filter(x => x.phase === phase), frames = s.frames.filter(x => x.phase === phase).map(x => x.interval).sort((a, b) => a - b);
        const visible = samples.reduce((n, x) => n + x.visible, 0), marked = samples.reduce((n, x) => n + x.marked, 0);
        const tasks = s.tasks.filter(x => x.phase === phase);
        return { phase, samples: samples.length, visible, marked, coverage: visible ? marked / visible : null, incompleteSamples: samples.filter(x => x.visible > x.marked).length,
          yRange: [Math.min(...samples.map(x => x.y)), Math.max(...samples.map(x => x.y))], p95FrameMs: frames[Math.floor(frames.length * .95)], maxFrameMs: frames.at(-1), over50ms: frames.filter(x => x > 50).length,
          longTasks: tasks.length, maxTaskMs: Math.max(0, ...tasks.map(x => x.duration)) };
      }), dom: document.querySelectorAll('*').length, marks: document.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length };
    });
    const finalCpu = await cpu();
    assert.ok(metrics.phases.some(phase => phase.yRange[1] - phase.yRange[0] > 1000), `${scenario}: 必须实际发生滚动`);
    await page.screenshot({ path: path.join(cache, `${label}-${scenario}.png`) });
    await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.reading.enabled = false; await chrome.storage.local.set({ settings }); });
    await page.waitForFunction(() => !document.querySelector('hnw-read,[data-hnw-reading-word]'));
    const restored = await page.evaluate(() => window.__continuous.root.textContent === window.__continuous.originalText);
    assert.ok(restored, '关闭后完整原文必须还原');
    const result = { scenario, setup, ...metrics, cpuSeconds: Object.fromEntries(Object.keys(finalCpu).map(key => [key, finalCpu[key] - initialCpu[key]])), restored };
    report.scenarios.push(result); console.log(JSON.stringify(result));
    await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.reading.enabled = true; await chrome.storage.local.set({ settings }); });
  }
  if (process.argv.includes('--trace')) {
    const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end');
    const { stream } = await done; const parts = [];
    for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); parts.push(chunk.data); if (chunk.eof) break; }
    await cdp.send('IO.close', { handle: stream }); fs.writeFileSync(path.join(cache, `${label}-trace.json`), parts.join(''));
  }
  assert.deepEqual(report.errors, []);
} finally {
  if (context) await context.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(cache, `${label}-report.json`), JSON.stringify(report, null, 2));
}
