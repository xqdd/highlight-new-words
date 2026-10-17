#!/usr/bin/env node
/** 真实长页面性能验收；旧、新扩展使用相同缓存快照和浏览器视口。
 * node scripts/qa/reading-performance.mjs --ext /tmp/hnw-reading-perf-before --label before
 * node scripts/qa/reading-performance.mjs --ext .output/chrome-mv3 --label after
 * --live 重新获取真实页面；--modes off,vocabulary,all；--rounds 3；--timeout-ms 20000；--profile 保存CPU采样。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const cache = path.resolve(arg('--cache', '/tmp/hnw-reading-performance'));
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const label = arg('--label', 'current').replace(/[^a-zA-Z0-9_-]/g, '_');
const sourceUrl = arg('--url', 'https://en.wikipedia.org/wiki/Barack_Obama');
const timeout = Number(arg('--timeout-ms', '20000'));
const modes = arg('--modes', 'off,vocabulary,all').split(',');
const rounds = Number(arg('--rounds', '1'));
const observeMs = Number(arg('--observe-ms', '10000'));
const wheelPositions = arg('--wheel-positions', 'top').split(',');
if (!wheelPositions.every(position => ['top', 'middle', 'end'].includes(position))) throw new Error('未知滚轮测量位置');
if (!modes.every(mode => ['off', 'vocabulary', 'all'].includes(mode))) throw new Error('未知测量模式');
if (!Number.isInteger(rounds) || rounds < 1 || !Number.isFinite(observeMs) || observeMs < 0) throw new Error('无效测量轮数或观察时间');
fs.mkdirSync(cache, { recursive: true });
const reportFile = path.join(cache, `${label}-report.json`);
const report = { label, extension, sourceUrl, rounds, observeMs, wheelPositions, startedAt: new Date().toISOString(), viewport: { width: 1280, height: 900 }, measurement: '首次观察后跳转正文中部、末尾，连续跳转并返回首屏，再用真实wheel上下往返；逐阶段测量交互、rAF帧间隔、长任务、50ms心跳和CDP CPU差值；固定缓存快照，关闭外部资源请求', runs: [] };
const write = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
let expectedParagraphTexts = [];
let expectedArticleText = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, name, ms = timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: external timeout ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
// 整个renderer卡死时context.close可能无法返回，最终以独立进程组终止该次浏览器。
async function cleanup(context) {
  try { await bounded(context.close(), 'browser close', 3000); }
  catch { /* 下方按独占profile终止浏览器进程，避免阻塞后续模式。 */ }
}

async function capture() {
  const browser = await bounded(chromium.launch({ headless: true, channel: 'chromium' }), 'capture launch');
  try {
    const page = await bounded(browser.newPage({ viewport: report.viewport }), 'capture page');
    await bounded(page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }), 'live goto', 50000);
    await delay(1500);
    const snapshot = await bounded(page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script,noscript,link[rel="preload"],link[rel="modulepreload"]').forEach(node => node.remove());
      const css = [], unreadableStyles = [];
      for (const sheet of document.styleSheets) {
        try { css.push([...sheet.cssRules].map(rule => rule.cssText).join('\n')); }
        catch { if (sheet.href) unreadableStyles.push(sheet.href); }
      }
      clone.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => node.remove());
      const head = clone.querySelector('head');
      const base = document.createElement('base'); base.href = location.href; head.prepend(base);
      const style = document.createElement('style'); style.textContent = css.join('\n'); head.append(style);
      // 保留跨源样式地址以便显式记录，资源不参与快照回放，确保旧新输入相同。
      return { html: '<!doctype html>\n' + clone.outerHTML, title: document.title, url: location.href, elements: document.querySelectorAll('*').length, paragraphs: document.querySelectorAll('.mw-parser-output p').length, cssSheets: css.length, unreadableStyles };
    }), 'capture DOM');
    if (!snapshot.title.includes('Barack Obama') || snapshot.paragraphs < 100) throw new Error(`真实文章捕获不完整: ${snapshot.title}, ${snapshot.paragraphs} paragraphs`);
    fs.writeFileSync(path.join(cache, 'snapshot.html'), snapshot.html);
    delete snapshot.html;
    fs.writeFileSync(path.join(cache, 'snapshot-meta.json'), JSON.stringify({ ...snapshot, capturedAt: new Date().toISOString() }, null, 2));
  } finally { await bounded(browser.close(), 'capture close', 3000).catch(() => {}); }
}

function installMeasurement() {
  const perf = window.__hnwPerf = { longTasks: [], heartbeats: [], frames: [], heartbeatMaxDelay: 0, heartbeatSamples: 0, firstReadingMarkMs: null, domReady: null };
  let previousFrame;
  const frame = now => { if (previousFrame !== undefined) perf.frames.push({ start: now, interval: now - previousFrame }); previousFrame = now; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const publish = () => window.__hnwReportPerf?.({ ...perf, measuredAtMs: performance.now() }).catch(() => {});
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) perf.longTasks.push({ start: entry.startTime, duration: entry.duration }); publish(); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let expected = performance.now() + 50;
  setInterval(() => { const now = performance.now(); const delay = Math.max(0, now - expected); perf.heartbeats.push({ start: now, delay }); perf.heartbeatMaxDelay = Math.max(perf.heartbeatMaxDelay, delay); perf.heartbeatSamples++; expected = now + 50; if (perf.heartbeatSamples % 20 === 0) publish(); }, 50);
  const ready = () => {
    perf.domReady = performance.now();
    const find = () => {
      if (perf.firstReadingMarkMs !== null) return;
      const visible = [...document.querySelectorAll('hnw-read,[data-hnw-reading-word]')].some(node => { const box = node.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.width > 0; });
      if (visible) { perf.firstReadingMarkMs = performance.now() - perf.domReady; observer.disconnect(); }
    };
    const observer = new MutationObserver(find); observer.observe(document.documentElement, { subtree: true, childList: true });
    const probe = document.createElement('div'); probe.id = 'hnw-performance-probe'; probe.dataset.hnwUi = 'performance';
    probe.style.cssText = 'position:fixed;right:16px;top:12px;z-index:2147483647;background:white;color:black;padding:8px';
    probe.innerHTML = '<button type="button">probe</button><input aria-label="performance probe" style="width:80px">';
    probe.querySelector('button').addEventListener('click', () => { probe.dataset.clicked = String(performance.now()); });
    document.documentElement.append(probe); find();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
}

async function setSettings(worker, mode, globalEnabled = true) {
  await bounded(worker.evaluate(async ({ mode, globalEnabled }) => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings) {
        settings.enabled = globalEnabled && mode !== 'off'; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after'; settings.code.enabled = true;
        const r = settings.reading;
        r.enabled = mode === 'all'; Object.assign(r.bionic, { enabled: true, intensity: 'medium', interval: 1 });
        Object.assign(r.syntax, { enabled: true, verbs: true, nouns: true, adjectives: true, adverbs: true, pronouns: true, determiners: true, prepositions: true, conjunctions: true, numerals: true, interjections: true, particles: true });
        Object.assign(r.emphasis, { negation: true, connectives: true, numbers: true, properNouns: true });
        r.phrases.enabled = true;
        await chrome.storage.local.set({ settings }); return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('settings initialization timed out');
  }, { mode, globalEnabled }), 'settings update');
}

const cpu = async cdp => Object.fromEntries((await bounded(cdp.send('Performance.getMetrics'), 'CDP metrics')).metrics.filter(m => ['TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration'].includes(m.name)).map(m => [m.name, m.value]));

async function run(mode, replayUrl, round) {
  const result = { mode, round, status: 'running', phases: [], errors: [], consoleErrors: [] }; report.runs.push(result); write();
  let context;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-reading-perf-'));
  const start = Date.now();
  try {
    context = await bounded(chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: report.viewport, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }), 'extension launch');
    // Playwright的persistent context不公开Browser对象；profile标识用于最后清理进程。
    const worker = context.serviceWorkers()[0] ?? await bounded(context.waitForEvent('serviceworker'), 'service worker');
    await setSettings(worker, mode);
    await bounded(context.addInitScript(installMeasurement), 'measurement init');
    const page = await bounded(context.newPage(), 'new page');
    await bounded(page.exposeBinding('__hnwReportPerf', (_, data) => { result.lastTelemetry = data; write(); }), 'partial telemetry');
    page.setDefaultTimeout(timeout); page.on('pageerror', error => { result.errors.push(error.message); write(); });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (message.text().includes('Failed to load resource: net::ERR_FAILED')) result.blockedResourceErrors = (result.blockedResourceErrors ?? 0) + 1;
      else result.consoleErrors.push(message.text());
    });
    await bounded(page.route('**/*', route => route.request().url().startsWith(replayUrl) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort()), 'replay routing');
    const cdp = await bounded(context.newCDPSession(page), 'CDP session'); await bounded(cdp.send('Performance.enable'), 'CDP enable');
    if (process.argv.includes('--profile')) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    const initialCpu = await cpu(cdp);
    await bounded(page.goto(replayUrl, { waitUntil: 'domcontentloaded', timeout }), 'replay navigation');
    result.navigationMs = Date.now() - start; write();
    // 保留正文指针交互，测量标注出现前后真实浏览器响应。
    const moveIntoParagraph = async () => {
      const point = await bounded(page.evaluate(() => {
        const p = [...document.querySelectorAll('.mw-parser-output p')].find(node => { const b = node.getBoundingClientRect(); return b.top >= 0 && b.top < innerHeight - 50 && b.width > 100 && b.height > 20; });
        if (!p) return { x: innerWidth / 2, y: innerHeight / 2 };
        const box = p.getBoundingClientRect(); return { x: Math.min(innerWidth - 30, box.left + box.width / 2), y: box.top + Math.min(25, box.height / 2) };
      }), 'hover article position');
      await bounded(page.mouse.move(point.x, point.y), 'hover article');
    };
    await moveIntoParagraph();
    await delay(observeMs);
    result.initial = await bounded(page.evaluate(() => ({ ...window.__hnwPerf, readingMarks: document.querySelectorAll('hnw-read').length, elements: document.querySelectorAll('*').length })), '10s metrics'); write();
    // 每个位置都直接测试交互，再等待标注；避免等后台工作结束才得出“流畅”的结论。
    const measurePhase = async (name, position, continuous = false) => {
      const phase = { name }; result.phases.push(phase); write();
      const initialMetrics = await cpu(cdp);
      const since = await bounded(page.evaluate(() => performance.now()), `${name} start`);
      const phaseStarted = Date.now();
      phase.target = await bounded(page.evaluate(position => {
        const paragraphs = [...document.querySelectorAll('.mw-parser-output p')].filter(p => p.textContent.trim().length > 100);
        const index = Math.min(paragraphs.length - 1, Math.floor((paragraphs.length - 1) * position));
        const target = paragraphs[index];
        if (!target) throw new Error('missing article target');
        document.querySelector('[data-hnw-perf-target]')?.removeAttribute('data-hnw-perf-target');
        target.dataset.hnwPerfTarget = 'true';
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        return { paragraphIndex: index, totalParagraphs: paragraphs.length, text: target.textContent.slice(0, 160), y: scrollY };
      }, position), `${name} scroll target`);
      if (continuous === 'wheel') {
        phase.wheelPositions = []; const wheelStarted = Date.now();
        await page.mouse.move(700, 500);
        for (const direction of [1, -1]) for (let step = 0; step < 24; step++) {
          await bounded(page.mouse.wheel(0, direction * 520), 'wheel scrolling');
          await delay(40);
          phase.wheelPositions.push(await bounded(page.evaluate(() => scrollY), 'wheel position'));
        }
        phase.wheelDurationMs = Date.now() - wheelStarted;
        phase.wheelTravelPx = phase.wheelPositions.reduce((sum, y, i, positions) => sum + Math.abs(y - (positions[i - 1] ?? phase.target.y)), 0);
        // 分开记录连续滚动本身与后续停稳补标，避免只用混合区间判断实际拖动体验。
        phase.activeWheelFrames = await bounded(page.evaluate(since => {
          const frames = window.__hnwPerf.frames.filter(sample => sample.start >= since).map(sample => sample.interval).sort((a, b) => a - b);
          return { count: frames.length, maxMs: Math.max(0, ...frames), p95Ms: frames[Math.max(0, Math.ceil(frames.length * 0.95) - 1)] ?? null, over50ms: frames.filter(interval => interval > 50).length };
        }, since), `${name} active wheel frames`);
      } else if (continuous) {
        const scrollStarted = Date.now();
        for (let step = 1; step <= 16; step++) {
          await bounded(page.evaluate(fraction => {
            const article = document.querySelector('#mw-content-text > .mw-parser-output');
            const bounds = article.getBoundingClientRect();
            scrollTo({ top: scrollY + bounds.top + bounds.height * fraction, behavior: 'instant' });
          }, step / 16), `continuous scroll ${step}`);
          await delay(70);
        }
        phase.continuousScrollMs = Date.now() - scrollStarted;
        // 连续滚动的落点再次设为正文末段，以同一个目标判断覆盖。
        await bounded(page.locator('[data-hnw-perf-target]').scrollIntoViewIfNeeded(), 'continuous final target');
      }
      const clickStarted = Date.now(); await bounded(page.locator('#hnw-performance-probe button').click(), `${name} probe click`);
      phase.clickResponseMs = Date.now() - clickStarted;
      const inputStarted = Date.now(); await bounded(page.locator('#hnw-performance-probe input').fill('responsive'), `${name} probe input`);
      phase.inputResponseMs = Date.now() - inputStarted;
      phase.probeInput = await bounded(page.locator('#hnw-performance-probe input').inputValue(), 'probe input acknowledgement');
      if (mode === 'all') await bounded(page.waitForFunction(() => document.querySelector('[data-hnw-perf-target] hnw-read,[data-hnw-perf-target] [data-hnw-reading-word]'), undefined, { timeout: 10000 }), `${name} offscreen annotation`, 12000);
      phase.annotationResponseMs = Date.now() - phaseStarted;
      await moveIntoParagraph(); await delay(700);
      phase.metrics = await bounded(page.evaluate(since => {
        const perf = window.__hnwPerf;
        const longTasks = perf.longTasks.filter(task => task.start >= since);
        const heartbeats = perf.heartbeats.filter(sample => sample.start >= since);
        const frames = perf.frames.filter(sample => sample.start >= since).map(sample => sample.interval).sort((a, b) => a - b);
        return { readingMarks: document.querySelectorAll('hnw-read,[data-hnw-reading-word]').length, targetMarks: document.querySelector('[data-hnw-perf-target]').querySelectorAll('hnw-read,[data-hnw-reading-word]').length,
          elements: document.querySelectorAll('*').length, frames: { count: frames.length, maxMs: Math.max(0, ...frames), p95Ms: frames[Math.max(0, Math.ceil(frames.length * 0.95) - 1)] ?? null, over50ms: frames.filter(interval => interval > 50).length },
          longTasks: { count: longTasks.length, totalMs: longTasks.reduce((total, task) => total + task.duration, 0), maxMs: Math.max(0, ...longTasks.map(task => task.duration)) }, heartbeatMaxDelayMs: Math.max(0, ...heartbeats.map(sample => sample.delay)), heartbeatSamples: heartbeats.length };
      }, since), `${name} metrics`);
      const finalMetrics = await cpu(cdp);
      phase.cpuSeconds = Object.fromEntries(Object.keys(finalMetrics).map(key => [key, finalMetrics[key] - initialMetrics[key]]));
      phase.wallMs = Date.now() - phaseStarted; write();
    };
    await measurePhase('middle', 0.5);
    await measurePhase('end', 1);
    await measurePhase('continuous', 1, true);
    await measurePhase('return-top', 0);
    for (const position of wheelPositions) await measurePhase(position === 'top' ? 'wheel-roundtrip' : `wheel-${position}`, { top: 0, middle: 0.5, end: 1 }[position], 'wheel');
    result.probeInput = result.phases.at(-1).probeInput;
    await delay(1000);
    result.final = await bounded(page.evaluate(() => ({ ...window.__hnwPerf, readingMarks: document.querySelectorAll('hnw-read').length })), 'final metrics');
    result.longTaskSummary = { count: result.final.longTasks.length, totalMs: result.final.longTasks.reduce((sum, entry) => sum + entry.duration, 0), maxMs: Math.max(0, ...result.final.longTasks.map(entry => entry.duration)) };
    const finalCpu = await cpu(cdp); result.cpuSeconds = Object.fromEntries(Object.keys(finalCpu).map(key => [key, finalCpu[key] - initialCpu[key]]));
    if (process.argv.includes('--profile')) {
      const { profile: cpuProfile } = await bounded(cdp.send('Profiler.stop'), 'CPU profile');
      result.profile = path.join(cache, `${label}-${mode}-${round}.cpuprofile`);
      fs.writeFileSync(result.profile, JSON.stringify(cpuProfile));
    }
    await bounded(page.screenshot({ path: path.join(cache, `${label}-${mode}-${round}.png`) }), 'screenshot');
    await setSettings(worker, mode, false);
    await bounded(page.waitForFunction(() => !document.querySelector('hnw-read,hnw-mark,[data-hnw-reading-word]')), 'disable cleanup');
    result.restore = await bounded(page.evaluate(() => ({ paragraphs: [...document.querySelectorAll('.mw-parser-output p')].map(p => p.textContent), articleText: document.querySelector('#mw-content-text > .mw-parser-output').textContent, residualReadingMarks: document.querySelectorAll('hnw-read').length, residualTools: document.querySelectorAll('hnw-reading-tools,[data-hnw-ui="reading-phrase"]').length })), 'restored text');
    result.restore.originalTextMatches = JSON.stringify(expectedParagraphTexts) === JSON.stringify(result.restore.paragraphs); delete result.restore.paragraphs;
    result.restore.completeArticleTextMatches = result.restore.articleText === expectedArticleText; delete result.restore.articleText;
    result.status = result.restore.originalTextMatches && result.restore.completeArticleTextMatches && result.probeInput === 'responsive' ? 'passed' : 'failed';
  } catch (error) { result.status = 'failed'; result.failure = error.stack ?? String(error); }
  finally {
    result.wallMs = Date.now() - start; write();
    if (context) await cleanup(context);
    // 仅清理此轮独占profile的浏览器，避免误杀其他agent浏览器。
    const { execFileSync } = await import('node:child_process');
    try {
      const lines = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n');
      for (const line of lines) if (line.includes(`--user-data-dir=${profile}`)) { const pid = Number(line.trim().split(/\s+/)[0]); try { process.kill(pid, 'SIGKILL'); } catch {} }
    } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); }
    catch (error) { result.cleanupWarning = error.message; write(); }
  }
}

let server;
try {
  if (process.argv.includes('--live') || !fs.existsSync(path.join(cache, 'snapshot.html'))) await capture();
  const html = fs.readFileSync(path.join(cache, 'snapshot.html'));
  report.snapshot = { ...JSON.parse(fs.readFileSync(path.join(cache, 'snapshot-meta.json'), 'utf8')), htmlSha256: createHash('sha256').update(html).digest('hex'), bytes: html.length };
  const browser = await bounded(chromium.launch({ headless: true }), 'baseline text launch');
  try {
    const page = await bounded(browser.newPage(), 'baseline text page'); await bounded(page.setContent(html.toString(), { waitUntil: 'domcontentloaded' }), 'baseline content');
    expectedParagraphTexts = await bounded(page.locator('.mw-parser-output p').allTextContents(), 'baseline paragraphs');
    // 页面另外两个同类节点是无正文的页眉图标；正文是mw-content-text的直接子节点。
    expectedArticleText = await bounded(page.locator('#mw-content-text > .mw-parser-output').textContent(), 'baseline complete article');
    report.snapshot.articleTextSha256 = createHash('sha256').update(expectedArticleText).digest('hex');
  } finally { await bounded(browser.close(), 'baseline browser close', 3000).catch(() => {}); }
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const replayUrl = `http://127.0.0.1:${server.address().port}/article`;
  for (let round = 1; round <= rounds; round++) for (const mode of modes) await run(mode, replayUrl, round);
} catch (error) { report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally { server?.close(); report.finishedAt = new Date().toISOString(); write(); }
console.log(JSON.stringify({ reportFile, snapshotSha256: report.snapshot?.htmlSha256, failure: report.failure, runs: report.runs.map(run => ({ mode: run.mode, round: run.round, status: run.status, firstReadingMarkMs: run.initial?.firstReadingMarkMs, cpuSeconds: run.cpuSeconds, longTaskSummary: run.longTaskSummary, failure: run.failure, phases: run.phases })) }, null, 2));
if (report.runs.some(run => run.status !== 'passed')) process.exitCode = 1;
