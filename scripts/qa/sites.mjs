#!/usr/bin/env node
/** 真实扩展网站规则QA：界面增删/预览/校验，以及生词与阅读规则独立生效。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const out = path.resolve(arg('--out', '/tmp/hnw-sites-qa'));
fs.mkdirSync(out, { recursive: true });
const fixture = fs.readFileSync(new URL('../../tests/fixtures/reading.html', import.meta.url));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-sites-'));
let context;
const report = { cases: [], errors: [] };
const all = { mode: 'all', disabled: [], allowed: [] };
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('settings unavailable');
  });
  const patch = async (sites, readingSites) => {
    await worker.evaluate(async ({ sites, readingSites }) => {
      const { settings } = await chrome.storage.local.get('settings');
      settings.enabled = true; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'off';
      settings.sites = sites;
      if (readingSites === null) delete settings.readingSites; else settings.readingSites = readingSites;
      settings.reading.enabled = true; settings.reading.bionic.enabled = true;
      settings.reading.syntax.enabled = true; settings.reading.phrases.enabled = true;
      await chrome.storage.local.set({ settings });
    }, { sites, readingSites: readingSites ?? null });
  };
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  async function check(name, sites, readingSites, urlPath, highlight, reading) {
    await patch(sites, readingSites);
    await page.goto(`${base}${urlPath}`);
    await page.waitForTimeout(1200);
    await page.waitForFunction(({ highlight, reading }) => (document.querySelectorAll('hnw-mark').length > 0) === highlight && (document.querySelectorAll('hnw-read').length > 0) === reading, { highlight, reading });
    const marks = await page.evaluate(() => ({ highlight: document.querySelectorAll('hnw-mark').length, reading: document.querySelectorAll('hnw-read').length }));
    report.cases.push({ name, ...marks });
  }
  await check('全局禁用、阅读独立放行', { ...all, disabled: ['127.0.0.1'] }, all, '/allowed/article', false, true);
  await check('全局放行、阅读独立禁用', all, { ...all, disabled: ['127.0.0.1'] }, '/allowed/article', true, false);
  await check('未配置阅读规则继承禁用', { ...all, disabled: ['127.0.0.1'] }, undefined, '/allowed/article', false, false);
  await check('未配置阅读规则继承放行', all, undefined, '/allowed/article', true, true);
  const pathRule = { ...all, mode: 'allowlist', allowed: [`glob:${base}/allowed/**`] };
  await check('路径白名单命中', pathRule, undefined, '/allowed/article', true, true);
  await check('路径白名单未命中', pathRule, undefined, '/other/article', false, false);
  await check('阅读独立路径规则', all, pathRule, '/other/article', true, false);
  await patch(all, all);
  await page.goto(`${base}/allowed/article`);
  await page.waitForFunction(() => document.querySelector('hnw-read') && document.querySelector('hnw-mark'));
  await patch({ ...all, disabled: ['127.0.0.1'] }, all);
  await page.waitForFunction(() => !document.querySelector('hnw-mark') && document.querySelector('hnw-read'));
  await patch(all, all);
  await page.waitForFunction(() => document.querySelector('hnw-mark') && document.querySelector('hnw-read'));
  report.cases.push({ name: '设置变更停启高亮不误停独立阅读', passed: true });
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; await chrome.storage.local.set({ settings }); });
  await page.waitForFunction(() => !document.querySelector('hnw-read,hnw-mark'));
  report.cases.push({ name: '总开关关闭两者均清理', passed: true });

  await patch(all, undefined);
  const options = await context.newPage(); options.on('pageerror', error => report.errors.push(error.message));
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#sites`);
  const section = options.locator('#sites'); await section.waitFor();
  const global = section.getByRole('group', { name: '生词高亮', exact: true });
  await global.getByLabel('生词高亮匹配规则', { exact: true }).fill('https://Example.com/news/article');
  await global.getByRole('button', { name: '添加', exact: true }).click();
  await global.getByRole('button', { name: '生词高亮移除 domain:example.com', exact: true }).waitFor();
  await global.getByLabel('生词高亮匹配预览', { exact: true }).fill('https://sub.example.com/anything');
  await global.locator('[data-site-result="blocked"]').waitFor();
  await global.getByRole('button', { name: '生词高亮移除 domain:example.com', exact: true }).click();
  await options.getByRole('button', { name: '撤销', exact: true }).click();
  await global.getByRole('button', { name: '生词高亮移除 domain:example.com', exact: true }).waitFor();
  await global.getByRole('radio', { name: '仅白名单', exact: true }).check();
  await global.getByLabel('生词高亮名单', { exact: true }).selectOption('allowed');
  await global.getByLabel('生词高亮规则类型', { exact: true }).selectOption('glob');
  await global.getByLabel('生词高亮匹配规则', { exact: true }).fill('https://*.example.org/news/**');
  await global.getByRole('button', { name: '添加', exact: true }).click();
  await global.getByLabel('生词高亮匹配预览', { exact: true }).fill('https://sub.example.org/news/latest/one');
  await global.locator('[data-site-result="allowed"]').waitFor();
  await global.getByLabel('生词高亮匹配预览', { exact: true }).fill('https://sub.example.org/about');
  await global.locator('[data-site-result="blocked"]').waitFor();
  await global.getByLabel('生词高亮规则类型', { exact: true }).selectOption('regex');
  await global.getByLabel('生词高亮匹配规则', { exact: true }).fill('/(a+)+$/');
  await global.getByRole('button', { name: '添加', exact: true }).click();
  await global.getByRole('alert').waitFor();
  await global.getByLabel('生词高亮匹配规则', { exact: true }).fill('/^https:\/\/docs\.example\.net\//i');
  await global.getByRole('button', { name: '添加', exact: true }).click();
  await global.getByLabel('生词高亮匹配预览', { exact: true }).fill('https://docs.example.net/guide');
  await global.locator('[data-site-result="allowed"]').waitFor();
  assert.match(await section.textContent(), /继承生词高亮的网站规则/);
  await section.getByRole('checkbox', { name: '独立设置网站规则', exact: true }).check();
  const reading = section.getByRole('group', { name: '原文阅读', exact: true });
  await reading.getByLabel('原文阅读匹配预览', { exact: true }).fill('https://example.com');
  await reading.locator('[data-site-result="allowed"]').waitFor();
  await options.waitForTimeout(400);
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(saved.sites.mode, 'allowlist');
  assert.deepEqual(saved.readingSites, all);
  await section.scrollIntoViewIfNeeded();
  await options.screenshot({ path: path.join(out, 'sites-desktop.png') });
  await options.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '网站设置出现横向溢出');
  await options.screenshot({ path: path.join(out, 'sites-mobile.png') });
  await section.getByRole('checkbox', { name: '独立设置网站规则', exact: true }).uncheck();
  await options.waitForTimeout(400);
  assert.equal(await worker.evaluate(async () => Object.hasOwn((await chrome.storage.local.get('settings')).settings, 'readingSites')), false);
  report.cases.push({ name: '真实UI增删撤销、三类规则、校验、预览、独立继承与存储、桌面移动端无溢出', passed: true });
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
  const last = context?.pages().at(-1);
  if (last && !last.isClosed()) {
    await last.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    report.failureUi = await last.locator('#sites').textContent().catch(() => undefined);
    report.failureState = await last.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      const preview = document.querySelector('[aria-label="生词高亮匹配预览"]').value;
      return { sites: settings.sites, preview };
    }).catch(error => ({ diagnosticError: error.message }));
  }
}
finally { await context?.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
