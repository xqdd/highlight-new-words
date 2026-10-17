#!/usr/bin/env node
/** 用真实扩展验证升级提示、已读记忆及手动重看入口。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve('.output/chrome-mv3');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-release-update-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
context.setDefaultTimeout(10_000);
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#reading`);
  await page.locator('#reading').waitFor();
  // 先完成首次安装初始化，再模拟升级，避免首次引导与升级记录互相覆盖。
  for (const existing of context.pages()) if (existing !== page) await existing.close();
  await worker.evaluate(async version => {
    await chrome.storage.local.set({ uiNotesSeen: '3.0.1', updateNotice: { from: '3.0.1', to: version, at: Date.now() } });
  }, version);
  await page.reload();
  const dialog = page.getByRole('dialog', { name: `${version} 更新说明`, exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByText('新增原文阅读', { exact: true }).isVisible(), true);
  await page.screenshot({ path: '/tmp/hnw-release-update.png' });
  await dialog.getByRole('button', { name: '知道了', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(async version => {
    const stored = await chrome.storage.local.get(['uiNotesSeen', 'updateNotice']);
    return stored.uiNotesSeen === version && !stored.updateNotice;
  }, version);
  await page.reload();
  await page.locator('#reading').waitFor();
  assert.equal(await dialog.count(), 0);
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#more`);
  await page.getByRole('button', { name: '更新说明', exact: true }).click();
  await dialog.waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, version, upgradeNotice: true, readOnce: true, manualEntry: true, errors }));
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
