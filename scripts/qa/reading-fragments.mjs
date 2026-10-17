#!/usr/bin/env node
/** 实际 YouTube 展开描述与构造的常见非正文回放；按原文位置验收过滤及关闭过滤后的恢复。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const source = JSON.parse(fs.readFileSync(arg('--source', '/tmp/hnw-youtube-description.json'), 'utf8'));
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const output = path.resolve(arg('--out', '/tmp/hnw-reading-fragments'));
fs.mkdirSync(output, { recursive: true });
const fixture = `<article id="controls"><p id="inline">They read <a href="#reference">the English reference</a> with friends.</p>
<p class="byline">Written by someone yesterday</p><div role="toolbar"><p>Share this article with friends</p></div>
<div role="status"><p>They record music together</p></div><div role="tablist"><p>They record music together</p></div>
<div class="post-taglist"><p>They record music together</p></div><p id="short">Settings</p>
<p id="br">They record music together.<br><span id="br-label">English</span><br><a id="br-link" href="#reference">Read the complete English documentation</a></p>
<ul><li id="prose-list">They record music with friends.</li></ul><p id="date">They arrived at <time>12:30</time> and recorded music.</p>
<table><tr><td id="explanation">They record music with friends.</td></tr></table><p id="vocabulary-short">abandon</p></article>`;
const html = `<!doctype html><meta charset="utf-8"><style>body{font:17px/1.6 Arial;margin:24px auto;padding:0 16px;max-width:760px}ytd-watch-metadata,yt-attributed-string{display:block}.ytAttributedStringWhiteSpacePreWrap{white-space:pre-wrap}a{color:#2563eb}</style>
<ytd-watch-metadata><div id="description"><div id="real">${source.html}</div></div></ytd-watch-metadata>${fixture}`;
const report = { source: source.source, title: source.title, mode: '浏览器实际展开描述DOM回放；通用控件另行构造',
  sourceSha256: createHash('sha256').update(source.html).digest('hex'), contentScriptSha256: createHash('sha256').update(fs.readFileSync(path.join(extension, 'content-scripts/content.js'))).digest('hex'), runs: [] };
const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
function inspect(text) {
  const root = document.querySelector('#real'); const start = root.textContent.indexOf(text);
  if (start < 0) return { text, found: false };
  const offset = start + Math.max(0, text.search(/[A-Za-z]/));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, cursor = 0;
  while ((node = walker.nextNode())) {
    if (cursor + node.length > offset) break; cursor += node.length;
  }
  const mark = node?.parentElement.closest('[data-pos],[data-emphasis],[data-bionic],[data-hnw-reading-word]');
  const style = mark && getComputedStyle(mark);
  return { text, found: !!node, marked: !!mark, styled: !!style && (style.textDecorationLine !== 'none' || style.backgroundImage !== 'none' || mark.hasAttribute('data-prefix')) };
}
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-fragments-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
          const { settings } = await chrome.storage.local.get('settings');
          if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
          settings.reading.enabled = true; settings.reading.syntax.enabled = true; settings.reading.bionic.enabled = true;
          settings.reading.emphasis.numbers = true;
          settings.books.enabled = ['cet4'];
          await chrome.storage.local.set({ settings }); return;
        }
        throw new Error('settings timeout');
      });
      const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
      await page.goto(origin); const original = await page.locator('body').textContent();
      await page.waitForFunction(() => document.querySelector('#real [data-pos]'));
      const prose = await page.evaluate(inspect, 'Making winter'); assert.ok(prose.marked && prose.styled);
      const ignored = [];
      for (const text of ['CHAPTERS', 'This one is different', 'TOOLS', 'Godot · Blender', 'https://sketchfab.com', 'https://creativecommons.org', '#gamedev', '#godot', '#aitools']) {
        const sample = await page.evaluate(inspect, text); assert.ok(sample.found && !sample.marked, `${name}: ${text} 不应标记`); ignored.push(sample);
      }
      for (const selector of ['#inline a', '#prose-list', '#date', '#explanation']) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        await page.waitForFunction(selector => document.querySelector(`${selector} [data-pos]`), selector);
      }
      assert.equal(await page.locator('.byline hnw-read,[role] hnw-read,.post-taglist hnw-read,#short hnw-read,#br-label hnw-read,#br-link hnw-read').count(), 0);
      await page.locator('#inline a').click(); assert.equal(await page.evaluate(() => location.hash), '#reference');
      await page.locator('#vocabulary-short').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#vocabulary-short hnw-mark'));
      assert.equal(await page.locator('#vocabulary-short hnw-read').count(), 0);
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.highlightScope.enabled = true; settings.reading.scope.skipShortBlocks = false; await chrome.storage.local.set({ settings }); });
      await page.waitForFunction(() => !document.querySelector('#vocabulary-short hnw-mark') && document.querySelector('#vocabulary-short [data-pos],#vocabulary-short [data-bionic]'));
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.highlightScope.enabled = false; settings.reading.scope.skipShortBlocks = true; await chrome.storage.local.set({ settings }); });
      await page.waitForFunction(() => document.querySelector('#vocabulary-short hnw-mark') && !document.querySelector('#vocabulary-short [data-pos],#vocabulary-short [data-bionic],#vocabulary-short [data-hnw-reading-word]')).catch(async error => {
        console.error(await page.locator('#vocabulary-short').innerHTML(), errors); throw error;
      });
      await page.locator('#real').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `${name}.png`) });
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); Object.assign(settings.reading.scope, { skipMetadata: false, skipShortBlocks: false, skipStandaloneLinks: false }); await chrome.storage.local.set({ settings }); });
      await page.locator('#real').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('#real hnw-read')].some(el => el.textContent === 'TOOLS'));
      for (const selector of ['.byline', '[role="toolbar"]', '#short', '#br-link']) {
        await page.locator(selector).scrollIntoViewIfNeeded(); await page.waitForFunction(selector => document.querySelector(`${selector} :is([data-pos],[data-bionic])`), selector);
      }
      assert.equal(await page.locator('body').textContent(), original);
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.reading.enabled = false; await chrome.storage.local.set({ settings }); });
      await page.waitForFunction(() => !document.querySelector('hnw-read,[data-hnw-reading-word]'));
      assert.equal(await page.locator('body').textContent(), original); assert.deepEqual(errors, []);
      const options = await context.newPage();
      options.on('pageerror', error => console.error('options error', error.message));
      options.on('console', message => { if (message.type() === 'error') console.error('options console', message.text()); });
      await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#appearance/highlight-scope`);
      const scope = options.locator('#highlight-scope');
      await scope.getByText('过滤非正文', { exact: true }).click();
      await scope.locator('summary').click();
      await scope.getByRole('spinbutton', { name: '最少英文词数' }).fill('5');
      // 从独立后台确认防抖保存已经落库，再刷新页面，避免把未保存状态当作持久化结果。
      let persisted = false;
      for (let i = 0; i < 100; i++) {
        persisted = await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); return settings.highlightScope.enabled && settings.highlightScope.minWords === 5 && settings.reading.scope.minWords === 3; });
        if (persisted) break;
        await options.waitForTimeout(50);
      }
      assert.ok(persisted, '设置必须在独立后台上下文确认落库');
      await options.screenshot({ path: path.join(output, `${name}-vocabulary-options.png`) });
      await options.reload();
      await scope.locator('summary').click();
      assert.equal(await scope.getByRole('spinbutton', { name: '最少英文词数' }).inputValue(), '5');
      report.runs.push({ name, prose, ignored, controls: '正文列表、表格说明、行内链接和时间保留', independentScopes: true, optionsPersisted: true, disabledFilters: true, restored: true, errors });
    } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
  }
} finally { server.close(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ output, runs: report.runs.map(run => ({ name: run.name, ignored: run.ignored.length, disabledFilters: run.disabledFilters, restored: run.restored })) }));
