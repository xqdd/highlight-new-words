#!/usr/bin/env node
/** 构建产物的真实扩展验证：默认行为对照、动态正文、关闭恢复、短语与设置页。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const baseline = arg('--baseline', '/tmp/hnw-reading-baseline/.output/chrome-mv3');
const output = path.resolve(arg('--out', '/tmp/hnw-reading-qa'));
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') return void res.writeHead(204).end();
  const base = pathname.startsWith('/icons/') ? path.join(root, 'public') : path.join(root, 'tests/fixtures');
  const file = path.resolve(base, '.' + pathname);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'image/png' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/reading.html`;
const report = [];

async function openExtension(directory, viewport) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-reading-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport,
    hasTouch: viewport.width < 500, isMobile: viewport.width < 500,
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
  });
  await context.addInitScript(() => {
    // 同时检查旧扩展的 DOM 词标和新扩展的原生绘制；不把空 layer 或失效 StaticRange 算作标记。
    window.__hnwReadingCount = (selector = 'body') => {
      const roots = [...document.querySelectorAll(selector)];
      const words = new Set(roots.flatMap(root => [...root.querySelectorAll('hnw-read:not([data-group]),hnw-w[data-hnw-reading-word]')]));
      let count = words.size;
      for (const [name, layer] of CSS.highlights ?? []) {
        if (!name.startsWith('hnw-reading-')) continue;
        for (const range of layer) {
          const start = range.startContainer;
          const end = range.endContainer;
          if (!start.isConnected || !end.isConnected || start.nodeType !== Node.TEXT_NODE || end.nodeType !== Node.TEXT_NODE) continue;
          if (range.startOffset < 0 || range.startOffset >= start.length || range.endOffset > end.length) continue;
          if (start === end && range.endOffset <= range.startOffset) continue;
          if (roots.some(root => root.contains(start))) count++;
        }
      }
      return count;
    };
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if ((await chrome.storage.local.get('settings')).settings) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Settings initialization timed out');
  });
  const patch = async (reading, enabled = true) => worker.evaluate(async ({ reading, enabled }) => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.enabled = enabled;
    settings.books.enabled = ['cet6'];
    settings.inlineTranslation.mode = 'off';
    if (reading) {
      const merge = (a, b) => {
        for (const [key, value] of Object.entries(b)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) a[key] = merge(a[key] ?? {}, value);
          else a[key] = value;
        }
        return a;
      };
      settings.reading = merge(settings.reading ?? {}, reading);
    }
    await chrome.storage.local.set({ settings });
  }, { reading, enabled });
  return { context, worker, patch, async close() { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

async function snapshot(page) {
  return page.evaluate(() => ({
    paragraphs: [...document.querySelectorAll('article p')].map(p => p.textContent),
    code: document.querySelector('pre').textContent,
    links: [...document.querySelectorAll('article a')].map(a => ({ href: a.getAttribute('href'), text: a.textContent })),
    editor: document.getElementById('editor').innerHTML,
    input: document.querySelector('input').value,
  }));
}

try {
  for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    let reference;
    if (fs.existsSync(baseline)) {
      const old = await openExtension(path.resolve(baseline), viewport);
      try {
        await old.patch();
        const page = await old.context.newPage();
        await page.goto(url);
        await page.waitForTimeout(1200);
        reference = await snapshot(page);
        await page.screenshot({ path: path.join(output, `${name}-before.png`) });
      } finally { await old.close(); }
    }
    const extensionContext = await openExtension(extension, viewport);
    try {
      const { context, patch, worker } = extensionContext;
      await patch();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForTimeout(1200);
      const original = await snapshot(page);
      if (reference) assert.deepEqual(original, reference, `${name}: default reading must preserve previous content`);
      assert.equal(await page.evaluate(() => window.__hnwReadingCount()), 0);
      await page.screenshot({ path: path.join(output, `${name}-default.png`) });
      await patch({ enabled: true, bionic: { enabled: true }, syntax: { enabled: true, nouns: true, adjectives: true, adverbs: true }, emphasis: { negation: true, connectives: true, numbers: true, properNouns: true }, phrases: { enabled: true } });
      await page.waitForFunction(() => window.__hnwReadingCount() > 10);
      await page.waitForTimeout(1000);
      assert.deepEqual(await snapshot(page), original, `${name}: annotations changed content`);
      assert.equal(await page.evaluate(() => window.__hnwReadingCount('#editor, pre, aside, header')), 0);
      await page.screenshot({ path: path.join(output, `${name}-reading.png`) });
      const words = await page.evaluate(() => window.__hnwReadingCount());
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__hnwReadingCount()), words, 'observers should settle');
      for (const books of [[], ['cet6']]) {
        await worker.evaluate(async books => {
          const { settings } = await chrome.storage.local.get('settings');
          settings.books.enabled = books;
          await chrome.storage.local.set({ settings });
        }, books);
        await page.waitForTimeout(700);
        assert.deepEqual(await snapshot(page), original, `${name}: book rebuild changed original content`);
      }
      for (const mode of ['after', 'off']) {
        await worker.evaluate(async mode => {
          const { settings } = await chrome.storage.local.get('settings');
          settings.inlineTranslation.mode = mode;
          await chrome.storage.local.set({ settings });
        }, mode);
        await page.waitForTimeout(500);
        assert.deepEqual(await snapshot(page), original, `${name}: inline gloss switch changed original content`);
      }

      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'inserted';
        p.textContent = 'However, they never record fewer than 25 observations.';
        document.querySelector('article').append(p);
      });
      // 正文按视口懒处理：先滚到新增段，再验证标注和框架更新。
      await page.locator('#inserted').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.__hnwReadingCount('#inserted') > 0);
      await page.evaluate(() => { document.getElementById('inserted').textContent = 'They do not give up. Therefore, 42 results remain.'; });
      await page.waitForFunction(() => window.__hnwReadingCount('#inserted') > 0);
      assert.equal(await page.locator('#inserted').textContent(), 'They do not give up. Therefore, 42 results remain.');

      // Text 节点引用由页面框架持有：标注后改写或删除也不能残留旧片段。
      await page.evaluate(() => {
        const p = document.createElement('p'); p.id = 'framework';
        const text = document.createTextNode('Researchers record detailed observations.');
        p.append(text); document.querySelector('article').append(p);
        window.__readingText = text;
      });
      await page.locator('#framework').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.__hnwReadingCount('#framework') > 0);
      await page.evaluate(() => { window.__readingText.data = 'The updated text must not be duplicated.'; });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#framework').textContent(), 'The updated text must not be duplicated.');
      await page.evaluate(() => { window.__readingText.remove(); });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#framework').textContent(), '');

      // 选区跨越阅读包装，查词只读选区，不改变正文。
      await page.locator('#phrase').scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        const p = document.getElementById('phrase');
        const texts = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let t, start, end, offset = 0;
        while ((t = texts.nextNode())) {
          if (t.length && !start) start = t;
          if (offset + t.length >= 11) { end = t; range.setEnd(t, 11 - offset); break; }
          offset += t.length;
        }
        range.setStart(start, 0);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => getSelection().toString().toLowerCase()), 'as a result');
      await page.locator('[data-hnw-ui="reading-phrase"]').waitFor();
      await page.screenshot({ path: path.join(output, `${name}-phrase.png`) });
      await page.keyboard.press('Escape');
      await patch({ enabled: false });
      await page.waitForFunction(() => window.__hnwReadingCount() === 0);
      await page.waitForTimeout(300);
      await page.evaluate(() => { document.getElementById('inserted').remove(); document.getElementById('framework').remove(); });
      assert.deepEqual(await snapshot(page), original, `${name}: disabling did not restore content`);
      for (let i = 0; i < 2; i++) {
        await patch({ enabled: true });
        await page.waitForFunction(() => window.__hnwReadingCount() > 0);
        await patch({ enabled: false });
        await page.waitForFunction(() => window.__hnwReadingCount() === 0);
        await page.waitForTimeout(200);
        assert.deepEqual(await snapshot(page), original, `${name}: repeated toggle changed original content`);
      }
      await patch({ enabled: true });
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'longword';
        p.style.cssText = 'font-size:32px;width:300px;max-width:100%;overflow-wrap:anywhere';
        p.textContent = 'electroencephalography helps scientists.';
        document.querySelector('article').append(p);
      });
      await page.locator('#longword').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.__hnwReadingCount('#longword') > 0);
      await page.waitForTimeout(700);
      assert.equal(await page.locator('#longword').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${name}: a long word overflowed at 32px`);
      await page.evaluate(() => document.getElementById('longword').remove());
      await worker.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        settings.sites.disabled = ['127.0.0.1'];
        await chrome.storage.local.set({ settings });
      });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__hnwReadingCount()), 0, 'site disable should clean up all reading marks');
      assert.equal(await page.locator('hnw-reading-tools, [data-hnw-ui="reading-phrase"]').count(), 0, 'site disable should clean up all reading tools');
      assert.deepEqual(await snapshot(page), original);
      await patch({ enabled: true }, false);
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__hnwReadingCount()), 0);

      const options = await context.newPage();
      options.on('pageerror', error => errors.push(error.message));
      await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#reading`);
      await options.getByRole('heading', { name: '仿生阅读', exact: true }).waitFor();
      await options.getByRole('radio', { name: '动词线索', exact: true }).click();
      await options.waitForTimeout(800);
      assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: options horizontal overflow`);
      await options.screenshot({ path: path.join(output, `${name}-options.png`), fullPage: true });
      assert.deepEqual(errors, [], `${name}: browser errors`);
      report.push({ viewport: name, readingMarks: words, defaultMatchesBaseline: !!reference, contentPreserved: true, dynamicUpdates: true, frameworkUpdates: true, disableRestores: true, browserErrors: errors });
    } finally { await extensionContext.close(); }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, report }, null, 2));
} finally {
  server.close();
}
