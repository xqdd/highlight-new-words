#!/usr/bin/env node
/** 同一完整Wiki快照上的滚动体验对照；逐帧检查已标词，而非只等待最终出现标记。
 * node scripts/qa/reading-scroll-experience.mjs --ext /tmp/hnw-scroll-round0 --label round0
 * --cache /tmp/hnw-reading-performance --output /tmp/hnw-scroll-experience
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const label = arg('--label', 'current').replace(/[^a-zA-Z0-9_-]/g, '_');
const cache = path.resolve(arg('--cache', '/tmp/hnw-reading-performance'));
const output = path.resolve(arg('--output', '/tmp/hnw-scroll-experience'));
const timeout = Number(arg('--timeout-ms', '20000'));
const maxGapMs = Number(arg('--max-gap-ms', '50'));
const maxFirstMarkMs = Number(arg('--max-first-mark-ms', '1000'));
const html = fs.readFileSync(path.join(cache, 'snapshot.html'));
fs.mkdirSync(output, { recursive: true });
const reportFile = path.join(output, `${label}-report.json`);
const report = { label, extension, startedAt: new Date().toISOString(), snapshotSha256: createHash('sha256').update(html).digest('hex'),
  viewport: { width: 1280, height: 900 }, limits: { maxGapMs, maxFirstMarkMs },
  qualityPolicy: '近距、跨一屏、整表往返作为保留体验判据；远距3600px往返仅诊断，不因可能超出有界缓存而硬判失败。首次未访补标独立衡量。',
  measurement: '固定完整Wiki快照；真实wheel往返和横向scrollLeft；rAF跟踪原文字符位置对应的可见词、DOM标记与计算样式，DOM峰值每20帧采样；无外部资源请求；构造表格单独标明', scenarios: [], errors: [] };
const write = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, name, ms = timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: timeout ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}

// 探针记录原文字符偏移，包装被拆除或重建后仍定位同一个词。
function installMeasurement() {
  const state = window.__scrollExperience = { probes: [], phases: [], active: null, longTasks: [] };
  const markerIds = new WeakMap(); let nextMarkerId = 1;
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  state.addProbe = (element, id, novel = false) => {
    const text = element.textContent;
    const match = /\bObama\b/.exec(text) ?? /\b[A-Za-z]{4,}\b/.exec(text);
    if (!match) throw new Error(`没有可跟踪词: ${id}`);
    const probe = { element, id, offset: match.index, length: match[0].length, text: match[0], novel, baseline: null, firstVisibleAt: null, firstMarkedAt: null, node: null };
    state.probes.push(probe); return { id, text: probe.text, offset: probe.offset };
  };
  state.sampleProbe = probe => {
    const bounds = probe.element.getBoundingClientRect();
    if (bounds.bottom < 0 || bounds.top > innerHeight || bounds.right < 0 || bounds.left > innerWidth) return { id: probe.id, visible: false };
    const walker = document.createTreeWalker(probe.element, NodeFilter.SHOW_TEXT);
    let node, offset = 0;
    while ((node = walker.nextNode())) { if (offset + node.length > probe.offset) break; offset += node.length; }
    if (!node) return { id: probe.id, visible: true, missingText: true, textMatches: false, marked: false, seenMarked: probe.firstMarkedAt !== null, styleMatches: false };
    const range = document.createRange(); range.setStart(node, probe.offset - offset); range.setEnd(node, Math.min(node.length, probe.offset - offset + probe.length));
    const box = range.getBoundingClientRect();
    const container = probe.element.closest('[data-scroll-table]');
    const clipping = container?.getBoundingClientRect();
    const visible = box.bottom > Math.max(0, clipping?.top ?? 0) && box.top < Math.min(innerHeight, clipping?.bottom ?? innerHeight)
      && box.right > Math.max(0, clipping?.left ?? 0) && box.left < Math.min(innerWidth, clipping?.right ?? innerWidth) && box.width > 0;
    if (!visible) return { id: probe.id, visible: false };
    const mark = node.parentElement?.closest('hnw-read:is([data-pos],[data-emphasis],[data-bionic],[data-prefix]),[data-hnw-reading-word]');
    const css = getComputedStyle(node.parentElement);
    const style = [css.color, css.textDecorationLine, css.textDecorationStyle, css.textDecorationColor, css.backgroundColor, css.backgroundImage, css.webkitTextStrokeWidth, css.webkitTextStrokeColor].join('|');
    const marked = !!mark;
    const actualText = node.textContent.slice(probe.offset - offset, probe.offset - offset + probe.length);
    if (mark && !markerIds.has(mark)) markerIds.set(mark, nextMarkerId++);
    const now = performance.now();
    probe.firstVisibleAt ??= now;
    if (marked) { probe.firstMarkedAt ??= now; probe.baseline ??= style; }
    return { id: probe.id, visible, marked, markerId: mark ? markerIds.get(mark) : null, seenMarked: probe.firstMarkedAt !== null, styleMatches: !!probe.baseline && style === probe.baseline,
      styleMismatch: probe.baseline && style !== probe.baseline ? { expected: probe.baseline, actual: style } : undefined,
      text: actualText, textMatches: actualText === probe.text };
  };
  let previous;
  const frame = now => {
    if (state.active) {
      const phase = state.active;
      phase.frames.push({ at: now, interval: previous === undefined ? 0 : now - previous, y: scrollY, x: phase.container?.scrollLeft ?? scrollX,
        probes: state.probes.map(state.sampleProbe) });
      if (phase.frames.length % 20 === 0) phase.domPeakSampled = Math.max(phase.domPeakSampled, document.querySelectorAll('*').length);
    }
    previous = now; requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  state.begin = (name, container = null) => {
    const phase = { name, start: performance.now(), frames: [], container, domPeakSampled: document.querySelectorAll('*').length };
    state.phases.push(phase); state.active = phase;
  };
  state.finish = () => {
    const phase = state.active; state.active = null;
    const frames = phase.frames;
    const intervals = frames.slice(1).map(frame => frame.interval).sort((a, b) => a - b);
    const gaps = [], reentries = [], markerInstances = {};
    for (const probe of state.probes) {
      let gapStart = null, gapFrames = 0;
      let previouslyVisible = null; const instances = new Set();
      for (const frame of frames) {
        const sample = frame.probes.find(sample => sample.id === probe.id);
        if (sample?.markerId) instances.add(sample.markerId);
        if (sample?.visible && previouslyVisible === false && sample.seenMarked) reentries.push({ probe: probe.id, at: frame.at, marked: sample.marked, styleMatches: sample.styleMatches, textMatches: sample.textMatches });
        previouslyVisible = sample?.visible ?? false;
        const missing = sample?.visible && sample.seenMarked && (!sample.marked || !sample.styleMatches || !sample.textMatches);
        if (missing) { gapStart ??= frame.at; gapFrames++; }
        else if (gapStart !== null) { gaps.push({ probe: probe.id, start: gapStart, durationMs: frame.at - gapStart, frames: gapFrames }); gapStart = null; gapFrames = 0; }
      }
      if (gapStart !== null) gaps.push({ probe: probe.id, start: gapStart, durationMs: frames.at(-1).at - gapStart, frames: gapFrames });
      markerInstances[probe.id] = instances.size;
    }
    const tasks = state.longTasks.filter(task => task.start >= phase.start);
    return { name: phase.name, durationMs: performance.now() - phase.start, frameCount: frames.length,
      frameIntervals: { p95Ms: intervals[Math.max(0, Math.ceil(intervals.length * 0.95) - 1)] ?? null, maxMs: Math.max(0, ...intervals), over50ms: intervals.filter(interval => interval > 50).length },
      longTasks: { count: tasks.length, maxMs: Math.max(0, ...tasks.map(task => task.duration)), totalMs: tasks.reduce((sum, task) => sum + task.duration, 0) },
      domPeakSampled: phase.domPeakSampled, gaps, maxVisibleGapMs: Math.max(0, ...gaps.map(gap => gap.durationMs)), markerInstances,
      reentries, reentryFirstFrameCoverage: reentries.length ? reentries.filter(entry => entry.marked && entry.styleMatches && entry.textMatches).length / reentries.length : null,
      visibleSamples: frames.flatMap(frame => frame.probes).filter(probe => probe.visible).length,
      missingMarkedFrames: frames.filter(frame => frame.probes.some(probe => probe.visible && probe.seenMarked && !probe.marked)).length,
      styleMismatchFrames: frames.filter(frame => frame.probes.some(probe => probe.visible && probe.marked && !probe.styleMatches)).length,
      textMismatchFrames: frames.filter(frame => frame.probes.some(probe => probe.visible && !probe.textMatches)).length,
      scrollYRange: [Math.min(...frames.map(frame => frame.y)), Math.max(...frames.map(frame => frame.y))],
      scrollXRange: [Math.min(...frames.map(frame => frame.x)), Math.max(...frames.map(frame => frame.x))], frames };
  };
}

const tableFixture = `<!doctype html><meta charset="utf-8"><title>构造横向表格场景</title><style>body{font:18px/1.8 Arial;margin:32px;color:#222}#table-scroll{width:720px;height:480px;overflow:auto;border:1px solid #777}table{width:3600px;table-layout:fixed;border-collapse:collapse}td{width:290px;padding:16px;border:1px solid #aaa;vertical-align:top}</style><div id="table-scroll" data-scroll-table><table><tbody>${Array.from({ length: 10 }, (_, row) => `<tr>${Array.from({ length: 12 }, (_, col) => `<td data-cell="${row}-${col}">Obama and his administration carefully considered the first proposal because they wanted to abolish absurd rules and improve public education.</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(request.url === '/table' ? tableFixture : html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-scroll-experience-'));
let context;
try {
  context = await bounded(chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: report.viewport,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }), 'launch');
  context.setDefaultTimeout(timeout);
  const worker = context.serviceWorkers()[0] ?? await bounded(context.waitForEvent('serviceworker'), 'worker');
  await bounded(worker.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
      settings.enabled = true; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after'; settings.code.enabled = true;
      const reading = settings.reading; reading.enabled = true; reading.wordStylePriority = 'reading';
      Object.assign(reading.bionic, { enabled: true, intensity: 'medium', interval: 1 });
      Object.assign(reading.syntax, { enabled: true, verbs: true, nouns: true, adjectives: true, adverbs: true, pronouns: true, determiners: true, prepositions: true, conjunctions: true, numerals: true, interjections: true, particles: true });
      Object.assign(reading.emphasis, { negation: true, connectives: true, numbers: true, properNouns: true });
      reading.phrases.enabled = true;
      await chrome.storage.local.set({ settings }); return;
    }
    throw new Error('settings initialization timeout');
  }), 'settings');
  await context.addInitScript(installMeasurement);
  const page = await context.newPage(); page.on('pageerror', error => { report.errors.push(error.message); write(); });
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const cpu = async () => Object.fromEntries((await bounded(cdp.send('Performance.getMetrics'), 'metrics')).metrics.filter(metric => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(metric.name)).map(metric => [metric.name, metric.value]));
  const measure = async (name, action, containerSelector = null, settleMs = 650) => {
    const result = { name, status: 'running' }; report.scenarios.push(result); write();
    const initial = await cpu();
    await page.evaluate(({ name, selector }) => window.__scrollExperience.begin(name, selector ? document.querySelector(selector) : null), { name, selector: containerSelector });
    await action(); await delay(settleMs);
    Object.assign(result, await page.evaluate(() => window.__scrollExperience.finish()));
    const final = await cpu(); result.cpuSeconds = Object.fromEntries(Object.keys(final).map(key => [key, final[key] - initial[key]]));
    result.status = 'measured'; write(); return result;
  };
  await bounded(page.goto(`${origin}/wiki`, { waitUntil: 'domcontentloaded' }), 'Wiki navigation');
  const originalArticle = await page.evaluate(html => new DOMParser().parseFromString(html, 'text/html').querySelector('#mw-content-text > .mw-parser-output').textContent, html.toString());
  await page.evaluate(() => {
    const paragraphs = [...document.querySelectorAll('.mw-parser-output p')].filter(element => element.textContent.length > 150 && element.getBoundingClientRect().height < 650 && /Obama/.test(element.textContent));
    const first = paragraphs[Math.floor(paragraphs.length * 0.1)], novel = paragraphs[Math.floor(paragraphs.length * 0.65)];
    first.dataset.scrollProbe = 'familiar'; novel.dataset.scrollProbe = 'novel';
    first.scrollIntoView({ block: 'center', behavior: 'instant' });
    window.__scrollExperience.addProbe(first, 'familiar');
    window.__scrollExperience.addProbe(novel, 'novel', true);
  });
  await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[0]).marked);
  await delay(500); await page.mouse.move(700, 450);
  await measure('familiar-near-roundtrip', async () => {
    for (let step = 0; step < 24; step++) { await page.mouse.wheel(0, step % 2 === 0 ? 180 : -180); await delay(35); }
  });
  await measure('familiar-cross-viewport', async () => {
    for (let step = 0; step < 12; step++) { await page.mouse.wheel(0, step % 2 === 0 ? 1450 : -1450); await delay(65); }
  });
  await measure('familiar-far-roundtrip', async () => {
    for (let step = 0; step < 8; step++) { await page.mouse.wheel(0, step % 2 === 0 ? 3600 : -3600); await delay(110); }
  });
  await measure('novel-first-visit', async () => {
    await page.locator('[data-scroll-probe="novel"]').evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.waitForFunction(() => window.__scrollExperience.probes.find(probe => probe.id === 'novel').firstMarkedAt !== null);
  });
  report.firstVisit = await page.evaluate(() => window.__scrollExperience.probes.map(probe => ({ id: probe.id, word: probe.text, firstVisibleAt: probe.firstVisibleAt, firstMarkedAt: probe.firstMarkedAt,
    visibleToMarkedMs: probe.firstMarkedAt === null || probe.firstVisibleAt === null ? null : probe.firstMarkedAt - probe.firstVisibleAt, baselineStyle: probe.baseline })));
  await measure('novel-cross-viewport', async () => {
    for (let step = 0; step < 12; step++) { await page.mouse.wheel(0, step % 2 === 0 ? 1450 : -1450); await delay(65); }
  });
  await page.screenshot({ path: path.join(output, `${label}-wiki.png`) });

  // 优先使用网页自身已有的横向容器；不改Wiki DOM制造“真实表格”。
  report.table = await page.evaluate(() => {
    for (const table of document.querySelectorAll('.mw-parser-output table')) {
      for (let parent = table.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const css = getComputedStyle(parent);
        if (parent.clientWidth > 200 && parent.scrollWidth > parent.clientWidth + 100 && /auto|scroll/.test(css.overflowX)) {
          parent.dataset.scrollTable = 'wiki'; parent.id ||= 'hnw-qa-wiki-scroll-table';
          return { source: 'Wiki原有可横滚表格', selector: `#${CSS.escape(parent.id)}`, width: parent.clientWidth, scrollWidth: parent.scrollWidth };
        }
      }
    }
    return { source: '构造场景', reason: '固定Wiki快照没有现成的横向overflow表格容器' };
  });
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; await chrome.storage.local.set({ settings }); });
  await page.waitForFunction(() => !document.querySelector('hnw-read,hnw-mark,[data-hnw-reading-word]'));
  report.wikiRestore = { completeArticleTextMatches: await page.locator('#mw-content-text > .mw-parser-output').textContent() === originalArticle,
    residualMarks: await page.locator('hnw-read,hnw-mark,[data-hnw-reading-word]').count() };
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = true; await chrome.storage.local.set({ settings }); });
  if (report.table.source === '构造场景') { await page.goto(`${origin}/table`, { waitUntil: 'domcontentloaded' }); report.table.selector = '#table-scroll'; }
  const selector = report.table.selector;
  const originalTableText = report.table.source === '构造场景'
    ? await page.evaluate(fixture => new DOMParser().parseFromString(fixture, 'text/html').querySelector('#table-scroll').textContent, tableFixture)
    : await page.locator(selector).textContent();
  report.table.probes = await page.locator(selector).evaluate(element => {
    element.scrollIntoView({ block: 'center', behavior: 'instant' }); element.scrollLeft = 0;
    window.__scrollExperience.probes = [];
    const cells = [...element.querySelectorAll('td')].filter(cell => /[A-Za-z]{4,}/.test(cell.textContent));
    window.__scrollExperience.addProbe(cells[0], 'table-left');
    const firstRow = cells.filter(cell => cell.parentElement === cells[0].parentElement);
    window.__scrollExperience.addProbe(firstRow.at(-1), 'table-right', true);
    const lastRow = cells.filter(cell => cell.parentElement === cells.at(-1).parentElement);
    if (lastRow[0] !== cells[0] && element.scrollHeight > element.clientHeight + 50) {
      window.__scrollExperience.addProbe(lastRow[0], 'table-bottom-left', true);
      window.__scrollExperience.addProbe(lastRow.at(-1), 'table-bottom-right', true);
    }
    return window.__scrollExperience.probes.length;
  });
  await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[0]).marked);
  await measure('table-first-visit', async () => {
    await page.locator(selector).evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[1]).marked);
    await page.locator(selector).evaluate(element => { element.scrollLeft = 0; });
    await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[0]).marked);
  }, selector);
  const box = await page.locator(selector).boundingBox(); await page.mouse.move(box.x + Math.min(box.width / 2, 350), box.y + Math.min(box.height / 2, 200));
  await measure('table-real-wheel-roundtrip', async () => {
    for (const direction of [1, -1]) for (let step = 0; step < 10; step++) { await page.mouse.wheel(direction * 320, 0); await delay(45); }
  }, selector);
  await measure('table-scrollLeft-roundtrip', async () => {
    for (let step = 0; step < 10; step++) { await page.locator(selector).evaluate((element, step) => { element.scrollLeft = step % 2 === 0 ? element.scrollWidth : 0; }, step); await delay(70); }
  }, selector);
  if (report.table.probes === 4) {
    await measure('table-grid-first-visit', async () => {
      await page.locator(selector).evaluate(element => { element.scrollLeft = 0; element.scrollTop = element.scrollHeight; });
      await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[2]).marked);
      await page.locator(selector).evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[3]).marked);
      await page.locator(selector).evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
      await page.waitForFunction(() => window.__scrollExperience.sampleProbe(window.__scrollExperience.probes[0]).marked);
    }, selector);
    await measure('table-whole-grid-roundtrip', async () => {
      for (let turn = 0; turn < 3; turn++) for (const [right, bottom] of [[true, false], [true, true], [false, true], [false, false]]) {
        await page.locator(selector).evaluate((element, { right, bottom }) => {
          element.scrollLeft = right ? element.scrollWidth : 0; element.scrollTop = bottom ? element.scrollHeight : 0;
        }, { right, bottom }); await delay(80);
      }
    }, selector);
  }
  report.tableFirstVisit = await page.evaluate(() => window.__scrollExperience.probes.map(probe => ({ id: probe.id, firstVisibleAt: probe.firstVisibleAt, firstMarkedAt: probe.firstMarkedAt,
    visibleToMarkedMs: probe.firstMarkedAt === null || probe.firstVisibleAt === null ? null : probe.firstMarkedAt - probe.firstVisibleAt })));
  await page.screenshot({ path: path.join(output, `${label}-table.png`) });
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; await chrome.storage.local.set({ settings }); });
  await page.waitForFunction(() => !document.querySelector('hnw-read,hnw-mark,[data-hnw-reading-word]'));
  report.tableRestore = { completeTextMatches: await page.locator(selector).textContent() === originalTableText,
    residualMarks: await page.locator('hnw-read,hnw-mark,[data-hnw-reading-word]').count() };
  const familiarPhases = report.scenarios.filter(phase => !phase.name.includes('first-visit') && phase.name !== 'familiar-far-roundtrip');
  const horizontal = report.scenarios.filter(phase => phase.name.startsWith('table-'));
  report.validationPass = report.errors.length === 0 && report.wikiRestore.completeArticleTextMatches && report.tableRestore.completeTextMatches && horizontal.every(phase => phase.scrollXRange[1] - phase.scrollXRange[0] > 100);
  report.experiencePass = report.validationPass && familiarPhases.every(phase => phase.maxVisibleGapMs <= maxGapMs && phase.styleMismatchFrames === 0 && phase.textMismatchFrames === 0)
    && report.firstVisit.every(probe => probe.visibleToMarkedMs !== null && probe.visibleToMarkedMs <= maxFirstMarkMs);
} catch (error) { report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (context) await bounded(context.close(), 'close', 3000).catch(() => {});
  for (const line of execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n')) if (line.includes(`--user-data-dir=${profile}`)) {
    try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch {}
  }
  fs.rmSync(profile, { recursive: true, force: true }); server.close(); report.finishedAt = new Date().toISOString(); write();
}
console.log(JSON.stringify({ reportFile, validationPass: report.validationPass, experiencePass: report.experiencePass, failure: report.failure,
  firstVisit: report.firstVisit, table: report.table, scenarios: report.scenarios.map(({ frames, ...phase }) => phase) }, null, 2));
if (report.validationPass === false) process.exitCode = 1;
