#!/usr/bin/env node
/** Learn 真实页面停稳后的逐词范围审计，独立于性能计时运行。 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

const targetsOnly = process.argv.includes('--targets-only');
const output = targetsOnly ? '/tmp/hnw-learn-target-coverage-release-final2' : '/tmp/hnw-learn-coverage-release-final2';
fs.mkdirSync(output, { recursive: true });
const scopeSource = fs.readFileSync('src/content/reading/scope.ts', 'utf8');
const { ignoredReadingRanges } = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(scopeSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toString('base64'));
const snapshot = fs.readFileSync('/tmp/hnw-continuous-scroll/snapshot.html');
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(snapshot); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.resolve('.output/chrome-mv3');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-coverage-'));
const report = { output, waitMs: 1500, phases: [] };
let context;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const reading = await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
      settings.enabled = true; settings.sites = { mode: 'all', disabled: [], allowed: [] }; settings.readingSites = { mode: 'all', disabled: [], allowed: [] };
      settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after';
      const r = settings.reading; r.enabled = true;
      Object.assign(r.bionic, { enabled: true, intensity: 'medium', interval: 1 }); r.syntax.enabled = true;
      for (const key of Object.keys(r.syntax.colors)) r.syntax[`${key}s`] = true;
      for (const key of ['negation', 'connectives', 'numbers', 'properNouns']) r.emphasis[key] = true;
      r.phrases.enabled = true; await chrome.storage.local.set({ settings }); return r;
    }
    throw new Error('settings timeout');
  });
  const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const page = await context.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  for (const [name, position, nested] of [['jump-73', .73, false], ['jump-21', .21, false], ['jump-94', .94, false], ['nested-table', .5, true]]) {
    if (targetsOnly && nested) continue;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const setup = await page.evaluate(({ position, nested }) => {
      const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
      let host = root;
      while (host && !(host.scrollHeight > host.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(host).overflowY))) host = host.parentElement;
      const target = nested ? [...root.querySelectorAll('div')].find(el => el.clientHeight > 200 && el.scrollHeight > 5000 && /auto|scroll/.test(getComputedStyle(el).overflowY)) : host ?? document.scrollingElement;
      if (!target) return null;
      window.__coverageTarget = target;
      if (nested) target.scrollIntoView({ block: 'center', behavior: 'instant' });
      target.scrollTop = (target.scrollHeight - target.clientHeight) * position;
      const box = target.getBoundingClientRect();
      return { host: target.tagName, top: target.scrollTop, height: target.scrollHeight, client: target.clientHeight,
        x: nested ? box.left + box.width / 2 : innerWidth - 35, y: nested ? box.top + 100 : innerHeight / 2 };
    }, { position, nested });
    if (!setup) { report.phases.push({ name, skipped: 'no nested host' }); continue; }
    await page.mouse.move(setup.x, setup.y);
    const positions = [];
    const positionNow = () => page.evaluate(() => {
      const table = [...document.querySelectorAll('article div')].find(el => el.clientHeight > 200 && el.scrollHeight > 5000 && /auto|scroll/.test(getComputedStyle(el).overflowY));
      return { top: __coverageTarget.scrollTop, height: __coverageTarget.scrollHeight, client: __coverageTarget.clientHeight,
        body: { top: document.body.scrollTop, height: document.body.scrollHeight, client: document.body.clientHeight },
        table: table ? { top: table.scrollTop, height: table.scrollHeight, client: table.clientHeight } : null };
    });
    for (const direction of [1, -1]) {
      for (let i = 0; i < (targetsOnly ? 3 : 16); i++) { await page.mouse.wheel(0, direction * (nested || targetsOnly ? 120 : 360)); await page.waitForTimeout(35); }
      positions.push({ direction, ...await positionNow() });
    }
    await page.waitForTimeout(1500);
    const position1500 = await positionNow();
    const blocks = await page.evaluate(() => {
      window.__collectCoverageBlocks = () => {
      const intervals = new Map();
      for (const [name, highlight] of CSS.highlights) if (name.startsWith('hnw-reading-')) for (const range of highlight) {
        if (range.startContainer !== range.endContainer) continue;
        const marks = intervals.get(range.startContainer) ?? []; marks.push([range.startOffset, range.endOffset]); intervals.set(range.startContainer, marks);
      }
      for (const [node, marks] of intervals) {
        marks.sort((a, b) => a[0] - b[0]); const merged = [];
        for (const mark of marks) { const last = merged.at(-1); if (last && last[1] >= mark[0]) last[1] = Math.max(last[1], mark[1]); else merged.push([...mark]); }
        intervals.set(node, merged);
      }
      const result = [];
      for (const block of document.querySelectorAll('article p,article li,article td,article th,article h1,article h2,article h3,article h4,article blockquote')) {
        const slices = [], words = [], breaks = []; let text = '';
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode(node) {
          if (node.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
          if (node.matches('hnw-tr,script,style,code,pre,nav,button,[data-hnw-ui],[hidden],[aria-hidden="true"],[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'BR') { breaks.push(text.length); text += '\n'; return NodeFilter.FILTER_REJECT; }
          if (node !== block && node.matches('p,li,td,th,blockquote')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        } });
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeType !== 3) continue;
          const start = text.length;
          slices.push({ start, end: start + node.length, link: !!node.parentElement.closest('a[href]') }); text += node.data;
          for (const match of node.data.matchAll(/\b[A-Za-z]{3,}\b/g)) {
            const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
            const box = range.getBoundingClientRect();
            if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) continue;
            let clipped = false;
            for (let el = node.parentElement; el; el = el.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowY)) {
              const clip = el.getBoundingClientRect(); if (box.bottom <= clip.top || box.top >= clip.bottom) { clipped = true; break; }
            }
            if (clipped) continue;
            words.push({ word: match[0], start: start + match.index, end: start + match.index + match[0].length,
              intervals: (intervals.get(node) ?? []).map(([a, b]) => [start + a, start + b]),
              covered: intervals.get(node)?.some(([a, b]) => a <= match.index && b >= match.index + match[0].length) ?? false });
          }
        }
        if (words.length) result.push({ tag: block.tagName, text, slices, breaks, words });
      }
      return result;
      };
      return window.__collectCoverageBlocks();
    });
    await page.screenshot({ path: path.join(output, `${name}-1500ms.png`) });
    await page.waitForTimeout(1500);
    const laterBlocks = await page.evaluate(() => window.__collectCoverageBlocks());
    const position3000 = await positionNow();
    for (const batch of [{ waitMs: 1500, blocks }, { waitMs: 3000, blocks: laterBlocks }]) {
    const phase = { name, waitMs: batch.waitMs, setup, wheelPositions: positions, finalPosition: batch.waitMs === 1500 ? position1500 : position3000,
      eligible: 0, covered: 0, excluded: {}, missing: [], blocks: [] };
    for (const block of batch.blocks) {
      const response = block.text.length <= 6000 ? await options.evaluate(async text => chrome.runtime.sendMessage({ ns: 'hnw', type: 'analyzeReading', data: { text, withSyntax: true } }), block.text) : undefined;
      const ignored = ignoredReadingRanges(block.text, block.breaks, block.slices, reading.scope);
      const details = [];
      for (const word of block.words) {
        const token = response?.result?.find(token => token.start <= word.start && token.end >= word.end);
        const reason = !response?.ok ? 'analysis-bound' : ignored.some(range => word.start < range.end && word.end > range.start) ? 'scope-filter'
          : !token ? 'not-english-token' : !token.pos && !token.emphasis && !token.properNoun && token.text.length < reading.bionic.minLength ? 'no-enabled-style' : undefined;
        const semantic = token && (token.pos || token.emphasis || token.properNoun);
        const expectedEnd = token && !semantic ? Math.min(word.end, token.start + Math.ceil(token.text.length * reading.bionic.ratio)) : word.end;
        const covered = expectedEnd <= word.start || word.intervals.some(([start, end]) => start <= word.start && end >= expectedEnd);
        if (reason) phase.excluded[reason] = (phase.excluded[reason] ?? 0) + 1;
        else { phase.eligible++; if (covered) phase.covered++; else phase.missing.push({ ...word, expectedEnd, tag: block.tag, paragraph: block.text }); }
        details.push({ ...word, expectedEnd, covered, reason });
      }
      phase.blocks.push({ tag: block.tag, text: block.text, words: details });
    }
    phase.coverage = phase.eligible ? phase.covered / phase.eligible : null;
    report.phases.push(phase); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
    await page.screenshot({ path: path.join(output, `${name}.png`) });
  }
  console.log(JSON.stringify(report.phases.map(({ name, waitMs, setup, wheelPositions, finalPosition, eligible, covered, coverage, excluded, missing, skipped }) => ({ name, waitMs, setup, wheelPositions, finalPosition, eligible, covered, coverage, excluded, missingCount: missing?.length, missingExamples: missing?.slice(0, 2), skipped })), null, 2));
} finally { await context?.close(); fs.rmSync(profile, { recursive: true, force: true }); server.close(); }
