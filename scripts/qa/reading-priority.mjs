#!/usr/bin/env node
/** 真实扩展验证所有词类、生词样式优先级、仅译文模式与可撤销性。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const text = 'He was the first to travel from London to Paris, and she chose to abolish absurd rules because they agreed.';
const output = '/tmp/hnw-reading-priority';
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((_req, response) => response.end(`<!doctype html><meta charset="utf-8"><style>body{font:18px/1.8 Arial;color:#222;margin:24px}p{max-width:700px}</style><p id="sample">${text}</p>`));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-priority-'));
const extension = path.resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
context.setDefaultTimeout(10_000);
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#reading`);
  await options.locator('#reading').waitFor();
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.enabled = true; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'after';
    settings.style.themeId = 'gloss-only'; settings.style.perBook = {};
    settings.reading.enabled = true; settings.reading.syntax.enabled = true;
    settings.reading.syntax.mode = 'color'; settings.reading.bionic.enabled = true;
    settings.reading.syntax.colors.verb = '#123456'; settings.reading.syntax.colors.adjective = '#654321';
    await chrome.storage.local.set({ settings });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const markedWord = page.locator('hnw-mark[data-lemma="abolish"] hnw-w');
  await page.waitForFunction(() => document.querySelector('hnw-mark[data-lemma="abolish"] hnw-w[data-hnw-reading-word]'));
  assert.equal(await markedWord.evaluate(node => getComputedStyle(node).color), 'rgb(18, 52, 86)');
  assert.equal(await page.locator('hnw-mark hnw-read').count(), 0);
  for (const pos of ['pronoun', 'determiner', 'numeral', 'preposition', 'conjunction']) assert.ok(await page.locator(`[data-pos="${pos}"]`).count() > 0, pos);
  await page.waitForFunction(() => document.querySelector('hnw-mark[data-lemma="abolish"] hnw-tr[data-tr]'));
  assert.equal(await page.locator('#sample').textContent(), text);
  await page.screenshot({ path: `${output}/translation-only-reading.png` });
  // 七种通道均要覆盖生词，不能只让颜色恰好从祖先继承。
  for (const mode of ['underline', 'dotted', 'wavy', 'background', 'marker', 'bold', 'color']) {
    await worker.evaluate(async mode => {
      const { settings } = await chrome.storage.local.get('settings');
      settings.reading.syntax.mode = mode;
      await chrome.storage.local.set({ settings });
    }, mode);
    await page.waitForFunction(mode => {
      const word = document.querySelector('hnw-mark[data-lemma="abolish"] hnw-w[data-hnw-reading-word]');
      if (!word) return false;
      const css = getComputedStyle(word);
      return mode === 'color' ? css.color === 'rgb(18, 52, 86)'
        : mode === 'background' ? css.backgroundColor !== 'rgba(0, 0, 0, 0)'
          : mode === 'marker' ? css.backgroundImage.includes('linear-gradient')
            : mode === 'bold' ? css.webkitTextStrokeWidth === '0.35px'
              : css.textDecorationStyle === (mode === 'underline' ? 'solid' : mode) && css.textDecorationLine === 'underline';
    }, mode);
    assert.equal(await page.locator('#sample').textContent(), text);
  }
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.style.themeId = 'orange-text'; settings.reading.wordStylePriority = 'vocabulary';
    await chrome.storage.local.set({ settings });
  });
  await page.waitForFunction(() => {
    const word = document.querySelector('hnw-mark[data-lemma="abolish"] hnw-w');
    return word && !word.hasAttribute('data-hnw-reading-word') && getComputedStyle(word).color !== 'rgb(18, 52, 86)';
  });
  await page.locator('hnw-read[data-pos="pronoun"]').first().waitFor();
  await page.screenshot({ path: `${output}/vocabulary-priority.png` });
  // 在相同页面重载，覆盖生词引擎先于阅读引擎启动的实际路径。
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.reading.wordStylePriority = 'reading';
    await chrome.storage.local.set({ settings });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('hnw-w[data-hnw-reading-word]'));
  assert.equal(await markedWord.evaluate(node => getComputedStyle(node).color), 'rgb(18, 52, 86)');
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.reading.enabled = false; await chrome.storage.local.set({ settings });
  });
  await page.waitForFunction(() => !document.querySelector('hnw-read,[data-hnw-reading-word]'));
  assert.equal(await page.locator('#sample').textContent(), text);
  assert.ok(await page.locator('hnw-mark').count() >= 2);
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.enabled = false; await chrome.storage.local.set({ settings });
  });
  await page.waitForFunction(() => !document.querySelector('hnw-mark'));
  assert.equal(await page.locator('#sample').textContent(), text);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, translationOnly: true, markStyles: 7, prioritySwitch: true, reload: true, reversible: true, errors, output }));
} finally {
  await context.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true });
}
