#!/usr/bin/env node
/** 实际扩展验证配置归属、锚点跳转与窄屏全部分组菜单。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve('.output/chrome-mv3');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-options-navigation-'));
const output = '/tmp/hnw-options-navigation';
fs.mkdirSync(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium', viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
context.setDefaultTimeout(10_000);
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const base = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  await page.goto(`${base}#books`);
  await page.locator('.side details').waitFor();
  assert.equal(await page.locator('.side details').getAttribute('open'), null);
  assert.equal(await page.locator('.side a[href="#youtube"]').isVisible(), false);
  for (const group of ['sources', 'known']) assert.equal(await page.locator(`.side a[href="#${group}"]`).isVisible(), true);
  await page.locator('.side summary').click();
  assert.equal(await page.locator('.side a[href="#youtube"]').isVisible(), true);
  await page.locator('.side summary').click();
  await page.screenshot({ path: `${output}/desktop-menu-collapsed.png` });
  const sections = {
    lookup: ['tts', 'floatball'], sites: ['sites'],
    reading: ['reading', 'reading-syntax', 'reading-bionic', 'reading-phrases'], youtube: ['youtube'], more: ['code', 'ui', 'about'],
  };
  for (const [group, ids] of Object.entries(sections)) {
    await page.goto(`${base}#${group}`);
    for (const id of ids) await page.locator(`#${id}`).waitFor();
    assert.deepEqual(await page.locator('main .section[id]').evaluateAll(nodes => nodes.map(node => node.id)), ids);
    assert.equal(await page.locator(`.side a[href="#${group}"]`).getAttribute('aria-current'), 'page');
    await page.screenshot({ path: `${output}/desktop-${group}.png`, fullPage: true });
  }
  // 原有深链接直接打开并定位到迁移后的分组，阅读页异步挂载也应完成定位。
  for (const [anchor, group] of Object.entries({ tts: 'lookup', floatball: 'lookup', sites: 'sites', youtube: 'youtube', sync: 'sync' })) {
    await page.goto(`${base}#more/${anchor}`);
    await page.locator(`#${anchor}`).waitFor();
    assert.equal(await page.locator(`.side a[href="#${group}"]`).getAttribute('aria-current'), 'page');
    await page.waitForFunction(id => {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      return rect && rect.top >= -1 && rect.top < innerHeight;
    }, anchor);
  }
  await page.goto(`${base}#reading/youtube`);
  await page.locator('#youtube').waitFor();
  assert.equal(await page.locator('.side a[href="#youtube"]').getAttribute('aria-current'), 'page');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${base}#books`);
    await page.locator('.tabbar').waitFor();
    assert.equal(await page.locator('.tabbar a').count(), 4);
    for (const group of ['sites', 'lookup', 'reading', 'youtube', 'sources', 'known', 'sync', 'more']) {
      await page.getByRole('button', { name: '全部设置分组', exact: true }).click();
      const menu = page.getByRole('dialog', { name: '设置分组', exact: true });
      await menu.waitFor();
      assert.equal(await menu.locator('nav a').count(), 10);
      const link = menu.locator(`a[href="#${group}"]`);
      if (!await link.isVisible()) await menu.locator('summary').click();
      await link.click();
      await menu.waitFor({ state: 'hidden' });
      await page.waitForFunction(group => location.hash === `#${group}`, group);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px ${group} 横向溢出`);
    }
    await page.screenshot({ path: `${output}/mobile-${width}-more.png`, fullPage: true });
    await page.getByRole('button', { name: '全部设置分组', exact: true }).click();
    await page.getByRole('dialog', { name: '设置分组', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/mobile-${width}-groups.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '设置分组', exact: true }).waitFor({ state: 'hidden' });
    await page.goto(`${base}#reading/reading-bionic`);
    await page.locator('#reading-bionic').waitFor();
    await page.locator('#reading-bionic').scrollIntoViewIfNeeded();
    const preview = await page.locator('.reading-preview').boundingBox();
    assert.ok(preview.y >= 56 && preview.y + preview.height < 500, '窄屏阅读预览保持吸顶且高度受限');
    await page.screenshot({ path: `${output}/mobile-${width}-sticky-preview.png` });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, groups: sections, anchors: true, mobileWidths: [390, 320], errors, output }, null, 2));
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
