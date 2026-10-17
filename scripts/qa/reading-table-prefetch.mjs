#!/usr/bin/env node
/** 冷表格邻列预读验收，不暖四角，也不改动既有滚动体验脚本的场景。
 * node scripts/qa/reading-table-prefetch.mjs --ext /tmp/hnw-scroll-round0 --label round0
 * node scripts/qa/reading-table-prefetch.mjs --ext /tmp/hnw-scroll-round5 --label round5
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const label = arg('--label', 'current').replace(/[^a-zA-Z0-9_-]/g, '_');
const output = path.resolve(arg('--output', '/tmp/hnw-table-prefetch'));
const waitMs = Number(arg('--wait-ms', '2000'));
fs.mkdirSync(output, { recursive: true });
const reportFile = path.join(output, `${label}-report.json`);
const report = { label, extension, startedAt: new Date().toISOString(), viewport: { width: 1280, height: 900 },
  scenario: '构造120格横纵overflow表格；全新页面先检查从未滚过的0-4邻列，冷阶段scrollLeft须为0；实际词级标记及CSS同时验证，再首次横移该列', errors: [] };
const write = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
const sentence = 'Obama and his administration carefully considered the first proposal because they wanted to abolish absurd rules and improve public education.';
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:18px/1.8 Arial;margin:32px;color:#222}#table-scroll{width:720px;height:480px;overflow:auto;border:1px solid #777}table{width:3600px;table-layout:fixed;border-collapse:collapse}td{width:290px;padding:16px;border:1px solid #aaa;vertical-align:top}</style><div id="table-scroll"><table><tbody>${Array.from({ length: 10 }, (_, row) => `<tr>${Array.from({ length: 12 }, (_, col) => `<td data-cell="${row}-${col}">${sentence}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

function installMeasurement() {
  const state = window.__tablePrefetch = { phase: 'cold', frames: [], longTasks: [], domPeakSampled: 0 };
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  state.words = cell => ['Obama', 'administration'].map(word => {
    const offset = cell.textContent.indexOf(word);
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let node, cursor = 0;
    while ((node = walker.nextNode())) { if (cursor + node.length > offset) break; cursor += node.length; }
    if (!node || offset < 0) return { word, textMatches: false, marked: false, styled: false };
    const mark = node.parentElement.closest('hnw-read:is([data-pos],[data-emphasis],[data-bionic],[data-prefix]),[data-hnw-reading-word]');
    const css = getComputedStyle(node.parentElement);
    const actual = node.textContent.slice(offset - cursor, offset - cursor + word.length);
    return { word, textMatches: actual === word, marked: !!mark, styled: !!mark && css.color === 'rgb(34, 85, 170)', color: css.color,
      pos: mark?.getAttribute('data-pos'), emphasis: mark?.getAttribute('data-emphasis') };
  });
  let previous;
  const frame = now => {
    const container = document.querySelector('#table-scroll');
    const target = document.querySelector('[data-cell="0-4"]');
    if (target && container) {
      const clip = container.getBoundingClientRect(), box = target.getBoundingClientRect();
      const words = state.words(target);
      state.frames.push({ at: now, interval: previous === undefined ? 0 : now - previous, phase: state.phase, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop,
        targetLeft: box.left, containerRight: clip.right, visible: box.left < clip.right && box.right > clip.left, words });
      if (state.frames.length % 20 === 0) state.domPeakSampled = Math.max(state.domPeakSampled, document.querySelectorAll('*').length);
    }
    previous = now; requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-table-prefetch-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: report.viewport,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
      settings.enabled = true; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after';
      const reading = settings.reading; reading.enabled = true; reading.wordStylePriority = 'reading';
      Object.assign(reading.bionic, { enabled: true, intensity: 'medium', interval: 1 });
      Object.assign(reading.syntax, { enabled: true, mode: 'color', modes: {}, verbs: true, nouns: true, adjectives: true, adverbs: true, pronouns: true, determiners: true, prepositions: true, conjunctions: true, numerals: true, interjections: true, particles: true });
      for (const key of Object.keys(reading.syntax.colors)) reading.syntax.colors[key] = '#2255aa';
      Object.assign(reading.emphasis, { negation: true, connectives: true, numbers: true, properNouns: true });
      for (const style of Object.values(reading.emphasis.styles)) Object.assign(style, { mode: 'marker', color: '#7e22ce' });
      reading.phrases.enabled = true;
      await chrome.storage.local.set({ settings }); return;
    }
    throw new Error('settings initialization timeout');
  });
  await context.addInitScript(installMeasurement);
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const cpu = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(metric => ['TaskDuration', 'LayoutDuration', 'ScriptDuration', 'RecalcStyleDuration'].includes(metric.name)).map(metric => [metric.name, metric.value]));
  const initialCpu = await cpu();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  report.geometry = await page.evaluate(() => {
    const container = document.querySelector('#table-scroll'), target = document.querySelector('[data-cell="0-4"]');
    const clip = container.getBoundingClientRect(), box = target.getBoundingClientRect();
    return { scrollLeft: container.scrollLeft, targetLeft: box.left, containerRight: clip.right, outsideDistancePx: box.left - clip.right,
      scrollMarginSupported: 'scrollMargin' in IntersectionObserver.prototype };
  });
  if (report.geometry.scrollLeft !== 0 || report.geometry.outsideDistancePx <= 0 || report.geometry.outsideDistancePx >= 800) throw new Error('构造目标未处于冷邻列800px预读区');
  await page.waitForFunction(() => window.__tablePrefetch.words(document.querySelector('[data-cell="0-0"]')).every(word => word.styled && word.textMatches));
  report.visibleFirstMarkedAt = await page.evaluate(() => performance.now());
  try {
    await page.waitForFunction(() => window.__tablePrefetch.words(document.querySelector('[data-cell="0-4"]')).every(word => word.styled && word.textMatches), undefined, { timeout: waitMs });
    report.prefetchedBeforeScroll = true;
  } catch (error) { if (error.name !== 'TimeoutError') throw error; report.prefetchedBeforeScroll = false; }
  // 保留若干真正的冷阶段rAF样本，避免刚完成标注就切换阶段而漏记首帧。
  await page.waitForTimeout(50);
  report.cold = await page.evaluate(() => ({ words: window.__tablePrefetch.words(document.querySelector('[data-cell="0-4"]')), scrollLeft: document.querySelector('#table-scroll').scrollLeft,
    frames: window.__tablePrefetch.frames.filter(frame => frame.phase === 'cold') }));
  const firstCold = report.cold.frames[0]?.at;
  const firstStyled = report.cold.frames.find(frame => frame.words.every(word => word.styled && word.textMatches));
  report.coldFirstStyledMs = firstStyled && firstCold !== undefined ? firstStyled.at - firstCold : null;
  await page.evaluate(() => {
    const state = window.__tablePrefetch, container = document.querySelector('#table-scroll'), target = document.querySelector('[data-cell="0-4"]');
    state.phase = 'first-entry'; container.scrollLeft += target.getBoundingClientRect().left - container.getBoundingClientRect().left - 30;
  });
  await page.waitForFunction(() => window.__tablePrefetch.words(document.querySelector('[data-cell="0-4"]')).every(word => word.styled && word.textMatches));
  await page.waitForTimeout(300);
  report.telemetry = await page.evaluate(() => ({ frames: window.__tablePrefetch.frames, longTasks: window.__tablePrefetch.longTasks, domPeakSampled: window.__tablePrefetch.domPeakSampled }));
  const entry = report.telemetry.frames.filter(frame => frame.phase === 'first-entry' && frame.visible);
  report.firstEntry = { frames: entry.length, firstVisibleFrameStyled: entry[0]?.words.every(word => word.styled && word.textMatches) ?? false,
    missingFrames: entry.filter(frame => frame.words.some(word => !word.styled || !word.textMatches)).length,
    visibleToStyledMs: entry.find(frame => frame.words.every(word => word.styled && word.textMatches))?.at - (entry[0]?.at ?? 0) };
  const finalCpu = await cpu(); report.cpuSeconds = Object.fromEntries(Object.keys(finalCpu).map(key => [key, finalCpu[key] - initialCpu[key]]));
  await page.screenshot({ path: path.join(output, `${label}.png`) });
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; await chrome.storage.local.set({ settings }); });
  await page.waitForFunction(() => !document.querySelector('hnw-read,hnw-mark,[data-hnw-reading-word]'));
  const restored = await page.locator('#table-scroll').textContent();
  report.restore = { originalTextMatches: restored === sentence.repeat(120), residualMarks: await page.locator('hnw-read,hnw-mark,[data-hnw-reading-word]').count() };
  report.validationPass = report.errors.length === 0 && report.restore.originalTextMatches
    && report.cold.frames.every(frame => frame.visible === false && frame.scrollLeft === 0 && frame.scrollTop === 0) && report.firstEntry.frames > 0;
  report.prefetchPass = report.validationPass && report.prefetchedBeforeScroll && report.cold.scrollLeft === 0 && report.firstEntry.firstVisibleFrameStyled;
} catch (error) { report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (context) await Promise.race([context.close(), new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {});
  for (const line of execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n')) if (line.includes(`--user-data-dir=${profile}`)) {
    try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch {}
  }
  fs.rmSync(profile, { recursive: true, force: true }); server.close(); report.finishedAt = new Date().toISOString(); write();
}
console.log(JSON.stringify({ reportFile, validationPass: report.validationPass, prefetchPass: report.prefetchPass, prefetchedBeforeScroll: report.prefetchedBeforeScroll,
  geometry: report.geometry, coldFirstStyledMs: report.coldFirstStyledMs, firstEntry: report.firstEntry, restore: report.restore, failure: report.failure }, null, 2));
if (report.validationPass === false) process.exitCode = 1;
