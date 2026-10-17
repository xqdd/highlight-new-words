#!/usr/bin/env node
/** 原生 HTML 对照验收：性能探针只收集 rAF 和 longtask；覆盖检查在测量阶段结束后独立执行。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const site = arg('--site', 'wiki');
if (!['wiki', 'learn'].includes(site)) throw new Error('未知 site');
const sourceCache = site === 'wiki' ? '/tmp/hnw-reading-performance' : '/tmp/hnw-continuous-scroll';
const cache = path.resolve(arg('--cache', '/tmp/hnw-native-performance'));
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const label = arg('--label', 'current').replace(/[^a-zA-Z0-9_-]/g, '_');
const modes = arg('--modes', 'native,vocabulary,reading,all').split(',');
if (!modes.every(mode => ['native', 'vocabulary', 'reading', 'all'].includes(mode))) throw new Error('未知 mode');
const mobile = process.argv.includes('--mobile');
const coldJumps = process.argv.includes('--cold-jumps');
const jumpProbeOnly = process.argv.includes('--jump-probe-only');
const trace = process.argv.includes('--trace');
const onlyJump73 = process.argv.includes('--only-jump-73');
const onlyJumps = arg('--only-jumps', onlyJump73 ? '73' : null)?.split(',').map(Number);
if (onlyJumps && !onlyJumps.every(position => position > 0 && position < 100)) throw new Error('跳转进度必须介于0和100');
const timingDetail = process.argv.includes('--timing-detail');
const startupSettleMs = Number(arg('--startup-settle-ms', '0'));
if (!Number.isFinite(startupSettleMs) || startupSettleMs < 0) throw new Error('无效初始化停留时间');
const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
const timeout = Number(arg('--timeout-ms', '25000'));
const steps = Number(arg('--steps', '16'));
const sourceHtml = fs.readFileSync(path.join(sourceCache, 'snapshot.html'));
let html = sourceHtml;
if (mobile) {
  // 桌面快照可能固定 width=1120；手机验收统一为真实设备宽度，并让原生与扩展使用同一份文档。
  const dom = new JSDOM(sourceHtml.toString());
  const meta = dom.window.document.querySelector('meta[name="viewport"]') ?? dom.window.document.createElement('meta');
  meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1';
  dom.window.document.head.append(meta); html = Buffer.from(dom.serialize()); dom.window.close();
}
fs.mkdirSync(cache, { recursive: true });
const reportFile = path.join(cache, `${label}-${site}${mobile ? '-mobile' : ''}.json`);
const report = { label, site, extension, viewport, jumpProbeOnly, timingDetail, onlyJumps, trace, isMobile: mobile, mobileViewportMeta: mobile ? 'width=device-width, initial-scale=1' : null,
  startupSettleMs, startupScenario: startupSettleMs ? '新文档顶部停留后跳转；跳前单独核验目标是否已有标记' : '新文档立即滚动/跳转，包含初始化并发上界',
  outerWheelPointer: '导航前预先定位外层鼠标，外层跳转setup后立即发送wheel；仅nested场景在setup后移动鼠标',
  contentScriptSha256: createHash('sha256').update(fs.readFileSync(path.join(extension, 'content-scripts/content.js'))).digest('hex'),
  sourceSnapshotSha256: createHash('sha256').update(sourceHtml).digest('hex'), coldJumps, jumpCacheState: coldJumps ? '每个 jump-* 使用新文档，不预热正文；浏览器进程和扩展资源缓存保留' : '复用当前文档，跳转目标可能已被之前的滚动访问', snapshotSha256: createHash('sha256').update(html).digest('hex'),
  startedAt: new Date().toISOString(), measurement: '真实 wheel；首访冷启动、冷滚动、固定随机进度后立即 wheel、返回和原网页内层滚动分别记录。性能阶段只记录 rAF/longtask；全文和范围覆盖在阶段结束检查。原生模式不加载扩展。', runs: [] };
const write = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, name, ms = timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: ${ms}ms timeout`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function installProbe({ timingDetail } = {}) {
  const s = window.__nativePerf = { frames: [], tasks: [], phase: 'startup', active: true, previous: undefined };
  if (timingDetail) {
    s.wheelEvents = [];
    addEventListener('wheel', event => s.wheelEvents.push({ at: performance.now(), eventAt: event.timeStamp, phase: s.phase, deltaY: event.deltaY }), { capture: true, passive: true });
  }
  const frame = now => {
    if (!s.active) return;
    if (s.previous !== undefined) s.frames.push({ at: now, ms: now - s.previous, phase: s.phase });
    s.previous = now; requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver(list => { for (const e of list.getEntries()) s.tasks.push({ at: e.startTime, ms: e.duration, phase: s.phase }); }).observe({ type: 'longtask', buffered: true });
}
function initializePageRoots(site) {
  window.__nativeRoot = document.querySelector(site === 'wiki' ? '#mw-content-text > .mw-parser-output' : 'article') ?? document.querySelector('main') ?? document.body;
  let host = window.__nativeRoot;
  while (host && !(host.scrollHeight > host.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(host).overflowY))) host = host.parentElement;
  window.__nativePageTarget = host ?? document.scrollingElement;
}
async function configure(worker, mode) {
  await bounded(worker.evaluate(async mode => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
      // 总开关也控制阅读辅助；用独立站点规则建立真正仅阅读的模式。
      settings.enabled = true;
      settings.sites = { mode: 'all', disabled: mode === 'reading' ? ['127.0.0.1'] : [], allowed: [] };
      settings.readingSites = { mode: 'all', disabled: [], allowed: [] };
      settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after';
      const r = settings.reading; r.enabled = mode === 'reading' || mode === 'all';
      Object.assign(r.bionic, { enabled: true, intensity: 'medium', interval: 1 });
      Object.assign(r.syntax, { enabled: true, verbs: true, nouns: true, adjectives: true, adverbs: true, pronouns: true, determiners: true, prepositions: true, conjunctions: true, numerals: true, interjections: true, particles: true });
      Object.assign(r.emphasis, { negation: true, connectives: true, numbers: true, properNouns: true });
      r.phrases.enabled = true;
      await chrome.storage.local.set({ settings }); return;
    }
    throw new Error('settings timeout');
  }, mode), 'configure');
}
const cpu = async cdp => Object.fromEntries((await bounded(cdp.send('Performance.getMetrics'), 'CPU metrics')).metrics
  .filter(m => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(m.name)).map(m => [m.name, m.value]));
const difference = (a, b) => Object.fromEntries(Object.keys(b).map(key => [key, b[key] - a[key]]));
const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let canonicalText;
// 正文基线始终由完全无扩展的浏览器建立，避免在插入译文后才取原文。
async function baseline() {
  const browser = await bounded(chromium.launch({ headless: true, channel: 'chromium' }), 'baseline launch');
  try {
    const page = await browser.newPage({ viewport, isMobile: mobile });
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await bounded(page.goto(origin, { waitUntil: 'domcontentloaded' }), 'baseline navigation');
    return await page.evaluate(site => (document.querySelector(site === 'wiki' ? '#mw-content-text > .mw-parser-output' : 'article') ?? document.querySelector('main') ?? document.body).textContent, site);
  } finally { await bounded(browser.close(), 'baseline close', 5000).catch(() => {}); }
}
async function run(mode) {
  const result = { mode, phases: [], errors: [], status: 'running' }; report.runs.push(result); write();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-native-perf-'));
  let context;
  try {
    context = await bounded(chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport, isMobile: mobile,
      args: mode === 'native' ? [] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }), 'browser launch');
    let worker;
    if (mode !== 'native') { worker = context.serviceWorkers()[0] ?? await bounded(context.waitForEvent('serviceworker'), 'worker'); await configure(worker, mode); }
    await context.addInitScript(installProbe, { timingDetail });
    const page = await context.newPage(); page.setDefaultTimeout(timeout);
    await page.mouse.move(mobile ? 8 : viewport.width - 35, viewport.height / 2);
    page.on('pageerror', error => result.errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
    if (trace) {
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline.stack,blink.user_timing', transferMode: 'ReturnAsStream' });
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    }
    const initialCpu = await cpu(cdp); const navigationStart = Date.now();
    await bounded(page.goto(origin, { waitUntil: 'domcontentloaded', timeout }), 'navigation');
    result.domContentLoadedMs = Date.now() - navigationStart;
    // 不等待预热：DOMContentLoaded 后马上开始首轮 wheel，启动单独截止。
    result.startup = { wallMs: Date.now() - navigationStart, cpuSeconds: difference(initialCpu, await cpu(cdp)) };
    await page.evaluate(initializePageRoots, site);
    result.actualViewport = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio, visualWidth: visualViewport?.width }));
    const collect = async (name, startCpu, since, extra = {}) => {
      const endCpu = await cpu(cdp);
      const metrics = await bounded(page.evaluate(({ name, since, timingDetail }) => {
        const s = window.__nativePerf, phaseClosePageAt = performance.now(); s.phase = 'checking';
        const frames = s.frames.filter(x => x.phase === name && x.at >= since).map(x => x.ms).sort((a, b) => a - b);
        const tasks = s.tasks.filter(x => x.phase === name && x.at >= since);
        const percentile = p => frames.length ? frames[Math.min(frames.length - 1, Math.ceil(frames.length * p) - 1)] : null;
        return { frames: { count: frames.length, p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: frames.at(-1) ?? null,
          over25ms: frames.filter(x => x > 25).length, over50ms: frames.filter(x => x > 50).length,
          droppedFrames: frames.reduce((n, ms) => n + Math.max(0, Math.round(ms / (1000 / 60)) - 1), 0) },
          longTasks: { count: tasks.length, totalMs: tasks.reduce((n, x) => n + x.ms, 0), maxMs: Math.max(0, ...tasks.map(x => x.ms)) }, y: window.__nativeScrollTarget?.scrollTop ?? scrollY,
          ...(timingDetail ? { phaseClosePageAt, framesRaw: s.frames.filter(x => x.phase === name && x.at >= since), tasksRaw: tasks,
            pageWheelEvents: s.wheelEvents.filter(event => event.phase === name) } : {}) };
      }, { name, since, timingDetail }), `${name} metrics`);
      result.phases.push({ name, ...extra, ...metrics, cpuSeconds: difference(startCpu, endCpu) }); write();
    };
    const wheel = async (name, position, nested = false) => {
      let freshDocumentStartup;
      if (coldJumps && name.startsWith('jump-')) {
        const reloadCpu = await cpu(cdp), reloadStarted = performance.now();
        await bounded(page.goto(origin, { waitUntil: 'domcontentloaded', timeout }), `${name} fresh navigation`);
        freshDocumentStartup = { wallMs: performance.now() - reloadStarted, cpuSeconds: difference(reloadCpu, await cpu(cdp)) };
        await bounded(page.evaluate(initializePageRoots, site), `${name} fresh roots`);
      }
      let startupSettle, targetBeforeJump;
      if (startupSettleMs && (name === 'cold-first-wheel' || freshDocumentStartup)) {
        const settleCpu = await cpu(cdp), settleStarted = performance.now();
        const topBefore = await page.evaluate(() => window.__nativePageTarget.scrollTop);
        await delay(startupSettleMs);
        startupSettle = { requestedMs: startupSettleMs, actualWallMs: performance.now() - settleStarted, topBefore,
          topAfter: await page.evaluate(() => window.__nativePageTarget.scrollTop), cpuSeconds: difference(settleCpu, await cpu(cdp)) };
      }
      if (startupSettleMs && name.startsWith('jump-')) {
        const inspectStarted = performance.now();
        targetBeforeJump = await bounded(page.evaluate(position => {
          const root = window.__nativeRoot, host = window.__nativePageTarget;
          const targetY = (host.scrollHeight - host.clientHeight) * position;
          const top = targetY - host.scrollTop, bottom = top + innerHeight;
          const rangesByNode = new Map();
          if (CSS.highlights) for (const [name, layer] of CSS.highlights) if (/hnw|reading/i.test(name)) for (const range of layer) {
            const entries = rangesByNode.get(range.startContainer) ?? []; entries.push(range); rangesByNode.set(range.startContainer, entries);
          }
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node, words = 0, readingWords = 0, vocabularyWords = 0;
          const examples = [], boxes = new Map();
          while ((node = walker.nextNode()) && words < 160) {
            const parent = node.parentElement;
            if (!node.data.trim() || parent.closest('script,style,code,pre,nav,button,[data-hnw-ui]')) continue;
            let box = boxes.get(parent); if (!box) { box = parent.getBoundingClientRect(); boxes.set(parent, box); }
            if (box.bottom <= top || box.top >= bottom || box.width === 0) continue;
            for (const match of node.data.matchAll(/\b[A-Za-z]{3,}\b/g)) {
              const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
              const wordBox = range.getBoundingClientRect();
              if (wordBox.bottom <= top || wordBox.top >= bottom || wordBox.width === 0) continue;
              let clipped = false;
              for (let el = parent; el && el !== host; el = el.parentElement) {
                if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowY)) {
                  const clip = el.getBoundingClientRect(); if (wordBox.bottom <= clip.top || wordBox.top >= clip.bottom) { clipped = true; break; }
                }
              }
              if (clipped) continue;
              words++;
              if (examples.length < 12) examples.push(match[0]);
              if (parent.closest('hnw-read,[data-hnw-reading-word],[data-pos],[data-bionic],[data-emphasis]')
                || rangesByNode.get(node)?.some(mark => mark.startOffset < match.index + match[0].length && mark.endOffset > match.index)) readingWords++;
              if (parent.closest('hnw-w,hnw-mark')) vocabularyWords++;
              if (words >= 160) break;
            }
          }
          return { position, targetY, currentY: host.scrollTop, words, readingWords, vocabularyWords, examples,
            targetUnvisited: words > 0 && readingWords === 0 && vocabularyWords === 0,
            targetReadingUnvisited: words > 0 && readingWords === 0 };
        }, position), `${name} unvisited target evidence`);
        targetBeforeJump.inspectionWallMs = performance.now() - inspectStarted;
      }
      if (trace) await page.evaluate(name => performance.mark(`${name}-setup-start`), name);
      const startCpu = await cpu(cdp);
      const setupNodeStarted = performance.now();
      const setup = await bounded(page.evaluate(({ name, position, nested, mobile }) => {
        const s = window.__nativePerf, setupStartPageAt = performance.now(); s.phase = name; s.previous = undefined;
        const root = window.__nativeRoot;
        const target = nested ? [...root.querySelectorAll('div')].find(el => el.clientHeight > 200 && el.scrollHeight > 5000 && /auto|scroll/.test(getComputedStyle(el).overflowY)) : window.__nativePageTarget;
        if (!target) return null;
        window.__nativeScrollTarget = target;
        if (nested) target.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (position !== null) target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight) * position;
        const box = nested ? target.getBoundingClientRect() : null;
        return { since: performance.now(), setupStartPageAt, startY: target.scrollTop, scrollHost: target.tagName, x: nested ? Math.max(5, Math.min(innerWidth - 10, box.left + box.width / 2)) : mobile ? 8 : innerWidth - 35,
          y: nested ? Math.max(5, Math.min(innerHeight - 10, box.top + 100)) : innerHeight / 2 };
      }, { name, position, nested, mobile }), `${name} jump`);
      const setupNodeAck = performance.now();
      if (!setup) { result.phases.push({ name, skipped: '没有原网页内层长滚动容器' }); return; }
      if (nested) await page.mouse.move(setup.x, setup.y);
      const firstWheelSendPageAt = timingDetail ? setup.since + performance.now() - setupNodeAck : undefined;
      let lastWheelAckObservedPageAt;
      const wheelStarted = performance.now(), wheelEvents = [], directionEndPositions = [];
      for (const direction of [1, -1]) {
        for (let i = 0; i < steps; i++) {
          const sendStartMs = performance.now() - wheelStarted;
          await bounded(page.mouse.wheel(0, direction * (nested ? 120 : 360)), `${name} wheel`);
          wheelEvents.push({ deltaY: direction * (nested ? 120 : 360), sendStartMs, ackMs: performance.now() - wheelStarted });
          if (timingDetail && direction === -1 && i === steps - 1) lastWheelAckObservedPageAt = setup.since + performance.now() - setupNodeAck;
          await delay(35);
        }
        directionEndPositions.push(await bounded(page.evaluate(() => window.__nativeScrollTarget.scrollTop), `${name} position`));
      }
      await collect(name, startCpu, setup.since, { startY: setup.startY, scrollHost: setup.scrollHost, nested, wheelWallMs: performance.now() - wheelStarted,
        ...(timingDetail ? { setupStartPageAt: setup.setupStartPageAt, setupEndPageAt: setup.since, firstWheelSendPageAt, lastWheelAckObservedPageAt,
          pageClockEstimateUncertaintyMs: setupNodeAck - setupNodeStarted,
          wheelAckObservation: '发送/ack时间由setup结束的页面performance.now加Node单调时钟增量估计，误差不超过setup往返耗时；不插入额外CDP测时命令；实际wheel交付以pageWheelEvents为准' } : {}),
        freshDocument: !!freshDocumentStartup, freshDocumentStartup,
        startupSettle, targetBeforeJump,
        directionEndPositions, actualScrollTravelPx: Math.abs(directionEndPositions[0] - setup.startY) + Math.abs(directionEndPositions[1] - directionEndPositions[0]),
        requestedDelayMs: 35, wheelEvents, maxWheelAckMs: Math.max(...wheelEvents.map(event => event.ackMs - event.sendStartMs)),
        maxWheelSendGapMs: Math.max(0, ...wheelEvents.slice(1).map((event, index) => event.sendStartMs - wheelEvents[index].sendStartMs)) });
      // 覆盖检查与截图不计入滚动阶段；只扫描当前可见文本，CSS Highlight 同时记录真实 Range 覆盖。
      const inspectCorrectness = canonicalText => {
        const root = window.__nativeRoot;
        const ranges = [];
        if (CSS.highlights) for (const [name, highlight] of CSS.highlights) if (/hnw|reading/i.test(name)) for (const range of highlight) ranges.push(range);
        const intervalsByNode = new Map();
        for (const range of ranges) {
          if (range.startContainer !== range.endContainer) continue;
          const intervals = intervalsByNode.get(range.startContainer) ?? [];
          intervals.push([range.startOffset, range.endOffset]); intervalsByNode.set(range.startContainer, intervals);
        }
        for (const [node, intervals] of intervalsByNode) {
          intervals.sort((a, b) => a[0] - b[0]); const merged = [];
          for (const interval of intervals) {
            const last = merged.at(-1);
            if (last && last[1] >= interval[0]) last[1] = Math.max(last[1], interval[1]); else merged.push([...interval]);
          }
          intervalsByNode.set(node, merged);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
        let visibleWords = 0, coveredWords = 0, vocabularyMarks = 0;
        while ((node = walker.nextNode())) {
          if (!node.data.trim() || node.parentElement.closest('script,style,code,pre,nav,button,[data-hnw-ui]')) continue;
          const words = [...node.data.matchAll(/\b[A-Za-z]{3,}\b/g)];
          for (const match of words) {
            const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
            const box = range.getBoundingClientRect();
            if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) continue;
            let clipped = false;
            for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
              if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowY)) { const clip = el.getBoundingClientRect(); if (box.bottom <= clip.top || box.top >= clip.bottom) { clipped = true; break; } }
            }
            if (clipped) continue;
            visibleWords++;
            if (node.parentElement.closest('hnw-read,[data-hnw-reading-word],[data-pos],[data-bionic],[data-emphasis]')
              || intervalsByNode.get(node)?.some(([start, end]) => start <= match.index && end >= match.index + match[0].length)
              || ranges.some(mark => {
              if (mark.startContainer === mark.endContainer) return false;
              const comparable = document.createRange(); comparable.setStart(mark.startContainer, mark.startOffset); comparable.setEnd(mark.endContainer, mark.endOffset);
              return comparable.compareBoundaryPoints(Range.START_TO_START, range) <= 0 && comparable.compareBoundaryPoints(Range.END_TO_END, range) >= 0;
            })) coveredWords++;
            if (node.parentElement.closest('hnw-w,hnw-mark')) vocabularyMarks++;
          }
        }
        const clone = root.cloneNode(true); clone.querySelectorAll('hnw-tr').forEach(node => node.remove());
        return { textPreserved: clone.textContent === canonicalText, visibleWords, coveredWords, coverage: visibleWords ? coveredWords / visibleWords : null, vocabularyMarks,
          readingRanges: ranges.length, readingElements: root.querySelectorAll('hnw-read,[data-hnw-reading-word]').length, elements: root.querySelectorAll('*').length };
      };
      const correctness = await bounded(page.evaluate(inspectCorrectness, canonicalText), `${name} correctness`);
      result.phases.at(-1).correctness = correctness;
      await delay(500);
      result.phases.at(-1).settledCorrectness = await bounded(page.evaluate(inspectCorrectness, canonicalText), `${name} settled correctness`);
      result.phases.at(-1).settledWaitMs = 500;
      await bounded(page.screenshot({ path: path.join(cache, `${label}-${site}-${mode}-${name}${mobile ? '-mobile' : ''}.png`) }), 'screenshot'); write();
    };
    if (jumpProbeOnly) {
      // 补充从修改 scrollTop 前至首个 rAF 的完整测量，不能拿滚动阶段的 p95 代替跳转响应。
      for (const [name, position] of [['jump-probe-73', .73], ['jump-probe-21', .21], ['jump-probe-94', .94]]) {
        await bounded(page.goto(origin, { waitUntil: 'domcontentloaded', timeout }), `${name} navigation`);
        await bounded(page.evaluate(initializePageRoots, site), `${name} roots`);
        const initialCpu = await cpu(cdp), commandStarted = performance.now();
        const probe = await bounded(page.evaluate(async ({ name, position }) => {
          const state = window.__nativePerf, target = window.__nativePageTarget;
          const startY = target.scrollTop, started = performance.now();
          state.phase = name; state.previous = started; window.__nativeScrollTarget = target;
          target.scrollTop = (target.scrollHeight - target.clientHeight) * position;
          const synchronousSetupMs = performance.now() - started;
          const firstRafAfterJumpMs = await new Promise(resolve => requestAnimationFrame(() => resolve(performance.now() - started)));
          return { since: started, startY, targetY: target.scrollTop, scrollHost: target.tagName,
            synchronousSetupMs, firstRafAfterJumpMs,
            actualScrollTravelPx: Math.abs(target.scrollTop - startY) };
        }, { name, position }), `${name} first RAF`);
        const commandWallMs = performance.now() - commandStarted;
        await collect(name, initialCpu, probe.since, { ...probe, commandWallMs, freshDocument: true });
        await delay(500);
        const textPreserved = await page.evaluate(canonicalText => {
          const clone = window.__nativeRoot.cloneNode(true); clone.querySelectorAll('hnw-tr').forEach(node => node.remove());
          return clone.textContent === canonicalText;
        }, canonicalText);
        result.phases.at(-1).correctness = { textPreserved }; write();
      }
    } else {
    if (!onlyJumps) await wheel('cold-first-wheel', null);
    for (const [name, position] of onlyJumps ? onlyJumps.map(position => [`jump-${position}`, position / 100]) : [['jump-73', .73], ['jump-21', .21], ['jump-94', .94], ['return-top', 0]]) await wheel(name, position);
    if (site === 'learn' && !mobile && (!onlyJumps || process.argv.includes('--include-nested'))) await wheel('nested-table', .53, true);
    // 跳转稳定性单独测量，几何查询与覆盖检查均不混入正式 wheel 性能样本。
    result.jumpStability = await bounded(page.evaluate(async () => {
      const target = window.__nativePageTarget;
      const started = performance.now(); target.scrollTop = (target.scrollHeight - target.clientHeight) * .59;
      let last = '', stableSince = started;
      for (;;) {
        let ranges = 0; if (CSS.highlights) for (const [name, highlight] of CSS.highlights) if (/hnw|reading/i.test(name)) ranges += highlight.size;
        const current = `${target.scrollTop}:${target.scrollHeight}:${ranges}:${document.querySelectorAll('hnw-read,hnw-mark').length}`;
        if (current !== last) { last = current; stableSince = performance.now(); }
        if (performance.now() - stableSince >= 500) return { elapsedMs: performance.now() - started, quietWindowMs: 500, timedOut: false };
        if (performance.now() - started > 10000) return { elapsedMs: performance.now() - started, quietWindowMs: 500, timedOut: true };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }), 'jump stability');
    const stabilization = await bounded(page.evaluate(async () => {
      const started = performance.now(); let last = '', stableSince = started;
      for (;;) {
        const current = `${window.__nativePageTarget.scrollTop}:${window.__nativePageTarget.scrollHeight}:${window.__nativeRoot.getBoundingClientRect().height}`;
        if (current !== last) { last = current; stableSince = performance.now(); }
        if (performance.now() - stableSince >= 300) return { elapsedMs: performance.now() - started, timedOut: false };
        if (performance.now() - started > 5000) return { elapsedMs: performance.now() - started, timedOut: true };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }), 'stabilization'); result.finalStabilization = stabilization;
    }
    if (trace) {
      const { profile: cpuProfile } = await bounded(cdp.send('Profiler.stop'), 'CPU profile');
      fs.writeFileSync(path.join(cache, `${label}-${site}-${mode}-cpu.json`), JSON.stringify(cpuProfile));
      const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await bounded(cdp.send('Tracing.end'), 'trace end');
      const { stream } = await bounded(done, 'trace complete');
      const chunks = [];
      for (;;) { const chunk = await bounded(cdp.send('IO.read', { handle: stream }), 'trace chunk'); chunks.push(chunk.data); if (chunk.eof) break; }
      await cdp.send('IO.close', { handle: stream });
      fs.writeFileSync(path.join(cache, `${label}-${site}-${mode}-trace.json`), chunks.join(''));
    }
    if (worker) {
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; settings.reading.enabled = false; await chrome.storage.local.set({ settings }); });
      await bounded(page.waitForFunction(() => !document.querySelector('hnw-read,hnw-mark,[data-hnw-reading-word]')), 'restore text');
      await delay(300);
      result.readingRangesAfterDisable = await page.evaluate(() => {
        let count = 0; if (CSS.highlights) for (const [name, highlight] of CSS.highlights) if (/hnw|reading/i.test(name)) count += highlight.size;
        return count;
      });
    }
    const restored = await page.evaluate(() => { window.__nativePerf.active = false; return window.__nativeRoot.textContent; });
    result.textRestored = restored === canonicalText;
    result.restoredTextLength = restored.length; result.canonicalTextLength = canonicalText.length;
    result.status = result.textRestored && result.errors.length === 0 && !result.readingRangesAfterDisable
      && result.phases.every(phase => phase.skipped || (phase.correctness?.textPreserved && phase.actualScrollTravelPx > 500)) ? 'complete' : 'failed';
  } catch (error) { result.status = 'failed'; result.error = error.stack; }
  finally {
    if (context) await bounded(context.close(), 'browser close', 5000).catch(() => {});
    // 卡死的渲染进程不能让后续模式和独立验收进程一直挂住。
    try { execFileSync('pkill', ['-f', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' }); } catch {}
    fs.rmSync(profile, { recursive: true, force: true }); write();
  }
  console.log(JSON.stringify({ mode, status: result.status, phases: result.phases.map(p => ({ name: p.name, ...p.frames, cpuSeconds: p.cpuSeconds })), error: result.error }));
}
try { canonicalText = await baseline(); for (const mode of modes) await run(mode); }
finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.finishedAt = new Date().toISOString(); write(); }
if (report.runs.some(run => run.status !== 'complete')) process.exitCode = 1;
