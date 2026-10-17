#!/usr/bin/env node
/** 使用真实扩展验证各种阅读样式不会改变小屏超长词的断行与滚动宽度。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-reading-layout-'));
const output = '/tmp/hnw-reading-layout';
fs.mkdirSync(output, { recursive: true });
const samples = [12, 18, 32].flatMap(size => [1.2, 1.8, 2.6].map(height =>
  `<p style="font-size:${size}px;line-height:${height}">electroencephalography helps scientists understand scientific research.</p>`));
const server = http.createServer((_req, response) => response.end(`<!DOCTYPE html><meta charset="utf-8"><style>body{font-family:Arial;margin:8px}p{width:min(300px,100%);overflow-wrap:anywhere}</style><article>${samples.join('')}</article>`));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  const extension = path.resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: { width: 390, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings) {
        settings.enabled = true; settings.books.enabled = []; settings.reading.enabled = false;
        await chrome.storage.local.set({ settings }); return;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Settings initialization timed out');
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForTimeout(400);
  const measure = () => page.locator('p').evaluateAll(paragraphs => paragraphs.map(p => ({ width: p.clientWidth, scrollWidth: p.scrollWidth, height: p.clientHeight, text: p.textContent })));
  const before = await measure();
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.reading.enabled = true; settings.reading.bionic.enabled = true; settings.reading.syntax.enabled = true; settings.reading.syntax.nouns = true;
    await chrome.storage.local.set({ settings });
  });
  await page.waitForFunction(() => document.querySelector('hnw-read[data-prefix]'));
  await page.waitForTimeout(300);
  assert.deepEqual(await measure(), before, 'Reading decorations changed the original mobile line wrapping');
  const wrappedLongPrefixes = (await page.locator('p[style*="32px"] hnw-read[data-prefix]').allTextContents())
    .filter(text => text === 'electroencephalography').length;
  assert.equal(wrappedLongPrefixes, 0, 'Wrapped long words must keep their original line wrapping');
  const modes = ['color', 'underline', 'dotted', 'wavy', 'background', 'marker', 'bold'];
  for (const mode of modes) {
    await worker.evaluate(async mode => {
      const { settings } = await chrome.storage.local.get('settings');
      settings.reading.syntax.mode = mode;
      settings.reading.syntax.verbs = true;
      settings.reading.syntax.nouns = true;
      settings.reading.syntax.adjectives = true;
      settings.reading.syntax.adverbs = true;
      for (const key of ['negation', 'connectives', 'numbers', 'properNouns']) {
        settings.reading.emphasis[key] = true;
        settings.reading.emphasis.styles[key].mode = mode;
      }
      await chrome.storage.local.set({ settings });
    }, mode);
    // 等待存储通知触发分批重绘，再比较真实排版尺寸和完整正文。
    await page.waitForTimeout(350);
    assert.deepEqual(await measure(), before, `${mode} changed original line wrapping`);
  }
  await page.screenshot({ path: path.join(output, 'mobile-390.png'), fullPage: true });
  await page.setViewportSize({ width: 280, height: 1100 });
  await page.waitForTimeout(100);
  const resized = await measure();
  assert.ok(resized.every(p => p.scrollWidth <= p.width), 'Resizing introduced horizontal overflow');
  await page.screenshot({ path: path.join(output, 'mobile-280.png'), fullPage: true });
  console.log(JSON.stringify({ combinations: before.length, modes, originalWrappingPreserved: true, resizeOverflow: false, output }));
} finally {
  await context?.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
