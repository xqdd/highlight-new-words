#!/usr/bin/env node
/** 用 GitHub issue 实际 HTML 和构造控件验收范围过滤、复合词与设置持久化。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const output = path.resolve(arg('--out', '/tmp/hnw-reading-scope'));
fs.mkdirSync(output, { recursive: true });
const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint, '-H', 'Accept: application/vnd.github.html+json'], { encoding: 'utf8' }));
const issue = api('repos/kodustech/kodus-ai/issues/1154');
const comments = api('repos/kodustech/kodus-ai/issues/1154/comments');
const fixture = `<article><p id="isolated">Settings</p><p id="standalone"><a href="/documentation">Read the complete documentation here</a></p>
<p id="inline">Use a <a id="inline-link" href="#target">pre-review</a> hook with MCP/HTTP/CLI contributors.</p>
<h2 id="heading">They record music together.</h2><table><tbody><tr><td id="cell">They record music with friends.</td></tr></tbody></table>
<button id="button">Read this document</button><nav><p id="navigation">Read the complete documentation here</p></nav></article>`;
const html = `<!doctype html><meta charset="utf-8"><style>body{font:17px/1.8 Arial;margin:20px auto;padding:0 16px;max-width:900px}table{border-collapse:collapse}td{padding:8px;border:1px solid #aaa}pre{overflow:auto}a{color:#2563eb}</style>${fixture}<main class="markdown-body"><section id="issue">${issue.body_html}</section>${comments.map((comment, index) => `<section id="comment-${index}">${comment.body_html}</section>`).join('')}</main>`;
const report = { source: issue.html_url, sourceHtmlSha256: createHash('sha256').update(html).digest('hex'),
  contentScriptSha256: createHash('sha256').update(fs.readFileSync(path.join(extension, 'content-scripts/content.js'))).digest('hex'),
  mode: 'GitHub API 实际渲染 HTML 离线回放；控件样本另行构造', runs: [] };
function inspectCompound(el, text) {
  let start = el.textContent.indexOf(text);
  return text.split(/[-/]/).map(word => {
    const offset = start; start += word.length + 1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, cursor = 0;
    while ((node = walker.nextNode())) { if (cursor + node.length > offset) break; cursor += node.length; }
    const mark = node?.parentElement.closest('[data-pos]');
    return { word, offset, textMatches: !!node && node.data.slice(offset - cursor, offset - cursor + word.length) === word,
      marked: mark?.textContent === word, pos: mark?.getAttribute('data-pos'), line: mark && getComputedStyle(mark).textDecorationLine };
  });
}
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-reading-scope-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
          const { settings } = await chrome.storage.local.get('settings');
          if (!settings) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
          settings.reading.enabled = true; settings.reading.syntax.enabled = true; settings.reading.bionic.enabled = true;
          settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'off';
          await chrome.storage.local.set({ settings }); return;
        }
        throw new Error('Settings initialization timeout');
      });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('chrome-extension:') ? route.continue() : route.abort());
      await page.goto(origin);
      const original = await page.locator('body').textContent();
      await page.waitForFunction(() => document.querySelector('#inline [data-pos]'));
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#isolated hnw-read,#standalone hnw-read,#button hnw-read,#navigation hnw-read').count(), 0);
      const inlineWords = await page.locator('#inline [data-pos]').allTextContents();
      for (const word of ['pre', 'review', 'MCP', 'HTTP', 'CLI']) assert.ok(inlineWords.includes(word), `${name}: ${word} missing`);
      await page.locator('#inline-link').click();
      assert.equal(await page.evaluate(() => location.hash), '#target');
      const compounds = [];
      // 每个实际目标滚入可见区后核对连接符两侧原词、词性及非空计算样式。
      for (const text of ['Self-hosted', 'pre-review', 'CI/CD', 'sandbox/checkout', 'MCP/HTTP/CLI']) {
        const block = page.locator('.markdown-body p,.markdown-body li,.markdown-body td').filter({ hasText: text }).first();
        await block.scrollIntoViewIfNeeded();
        let parts;
        for (let attempt = 0; attempt < 100; attempt++) {
          parts = await block.evaluate(inspectCompound, text);
          if (parts.every(part => part.textMatches && part.marked && part.pos && part.line.includes('underline'))) break;
          await page.waitForTimeout(50);
        }
        assert.ok(parts.every(part => part.textMatches && part.marked && part.pos && part.line.includes('underline')), `${name}: exact ${text} occurrence missing`);
        compounds.push({ text, parts });
      }
      if (name === 'desktop' && process.argv.includes('--live')) {
        const live = await context.newPage();
        try {
          const response = await live.goto(issue.html_url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          report.live = { status: response?.status(), mode: '实际 GitHub 页面' };
          await live.getByText('Self-hosted Kodus installations often need code review context', { exact: false }).first().waitFor({ timeout: 10000 });
          const block = live.locator('.markdown-body p').filter({ hasText: 'Self-hosted Kodus installations' }).first();
          await block.scrollIntoViewIfNeeded();
          await block.locator('[data-pos]').filter({ hasText: /^hosted$/ }).first().waitFor({ timeout: 10000 });
          report.live.hostedMarked = true;
          await live.screenshot({ path: path.join(output, 'github-live.png') });
        } catch (error) { report.live = { ...report.live, error: error.message }; }
        finally { await live.close(); }
      }
      await page.locator('#heading').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#heading [data-pos]') && document.querySelector('#cell [data-pos]'));
      const options = await context.newPage();
      await worker.evaluate(async () => { await chrome.storage.local.set({ uiNotesSeen: chrome.runtime.getManifest().version }); });
      await options.goto(`chrome-extension://${worker.url().split('/')[2]}/options.html#reading`);
      await options.getByLabel('跳过标题', { exact: true }).check();
      await options.getByLabel('跳过表格', { exact: true }).check();
      await page.locator('#heading').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => !document.querySelector('#heading hnw-read,#cell hnw-read'));
      assert.equal(await page.locator('#heading hnw-read,#cell hnw-read').count(), 0);
      await options.locator('#reading-scope').scrollIntoViewIfNeeded();
      await options.screenshot({ path: path.join(output, `${name}-scope-default.png`) });
      await options.getByLabel('跳过短文本', { exact: true }).uncheck();
      await options.getByLabel('跳过独立链接', { exact: true }).uncheck();
      await options.getByLabel('跳过按钮', { exact: true }).uncheck();
      await page.locator('#button').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#button [data-pos]'));
      assert.equal(await page.locator('#navigation [data-pos]').count(), 0);
      await options.getByLabel('跳过导航区域', { exact: true }).uncheck();
      await page.waitForFunction(() => document.querySelector('#navigation [data-pos]'));
      await page.locator('#isolated').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#isolated [data-pos]') && document.querySelector('#standalone [data-pos]'));
      await options.reload();
      assert.equal(await options.getByLabel('跳过短文本', { exact: true }).isChecked(), false);
      assert.equal(await options.getByLabel('跳过独立链接', { exact: true }).isChecked(), false);
      assert.equal(await options.getByLabel('跳过标题', { exact: true }).isChecked(), true);
      assert.equal(await options.getByLabel('跳过按钮', { exact: true }).isChecked(), false);
      assert.equal(await options.getByLabel('跳过导航区域', { exact: true }).isChecked(), false);
      await options.getByLabel('跳过按钮', { exact: true }).check();
      await page.waitForFunction(() => !document.querySelector('#button hnw-read'));
      await page.waitForFunction(() => document.querySelector('#navigation [data-pos]'));
      await options.getByLabel('跳过导航区域', { exact: true }).check();
      await page.waitForFunction(() => !document.querySelector('#navigation hnw-read'));
      await options.locator('#reading-scope').scrollIntoViewIfNeeded();
      assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await options.screenshot({ path: path.join(output, `${name}-scope.png`) });
      assert.equal(await page.locator('body').textContent(), original);
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.reading.enabled = false; await chrome.storage.local.set({ settings }); });
      await page.waitForFunction(() => !document.querySelector('hnw-read,[data-hnw-reading-word]'));
      assert.equal(await page.locator('body').textContent(), original);
      assert.deepEqual(errors, []);
      report.runs.push({ name, compounds, scopePersistence: true, originalTextRestored: true, errors });
    } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
  }
} finally { server.close(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ output, runs: report.runs.map(run => ({ name: run.name, compounds: run.compounds.length, scopePersistence: run.scopePersistence, originalTextRestored: run.originalTextRestored })) }));
