#!/usr/bin/env node
/** 真实设置页验证统一标记主题、自定义记忆、自动保存回流与窄屏布局。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const extension = path.resolve(process.argv[2] ?? '.output/chrome-mv3');
const out = '/tmp/hnw-presets-qa';
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-presets-profile-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
context.setDefaultTimeout(10_000);
const errors = [];
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  // Chrome 计时器可能被节流，验证实际落库而不是用固定等待时间假定防抖保存已完成。
  async function saved(check) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
      if (check(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('设置未在期限内保存');
  }
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#reading`);
  await page.locator('#reading').waitFor();
  const global = page.getByRole('radiogroup', { name: '阅读预设', exact: true });
  const themes = page.getByRole('radiogroup', { name: '标记预设', exact: true });
  const filter = page.getByRole('combobox', { name: '标记预设样式类型', exact: true });
  assert.equal(await page.getByRole('radio', { name: '全开', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-mark]').count(), 15);
  assert.equal(await page.locator('.mark-details').getAttribute('open'), null);
  assert.equal(await page.getByRole('switch', { name: '动词', exact: true }).isVisible(), false);
  await global.getByRole('radio', { name: '视觉锚点', exact: true }).click();
  await saved(s => s.reading.bionic.enabled);
  await page.getByRole('slider', { name: '加粗比例', exact: true }).fill('0.65');
  await saved(s => s.readingPresets.features.bionic.custom.ratio === 0.65);
  await global.getByRole('radio', { name: '清爽', exact: true }).click();
  await global.getByRole('radio', { name: '自定义', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: '加粗比例', exact: true }).inputValue(), '0.65');
  const modes = ['color', 'underline', 'dotted', 'wavy', 'background', 'marker', 'bold', 'mixed'];
  for (const mode of modes) {
    await filter.selectOption(mode);
    assert.ok(await themes.locator('.style-preview').count() >= 9, `${mode}需要九套配色`);
    assert.equal(await themes.locator('[tabindex="0"]').count(), 1);
    await themes.locator('[role="radio"]:has(.style-preview)').first().click();
    assert.equal(await page.locator('[data-mark] input:checked').count(), 15);
    assert.equal(await page.locator('.mark-details').getAttribute('open'), null);
  }
  await filter.selectOption('all');
  const totalThemes = await themes.locator('.style-preview').count();
  await themes.getByRole('radio', { name: '宝石绛红 · 文字颜色', exact: true }).click();
  await saved(s => s.readingPresets.marking.selected === 'color-ruby');
  const beforeFilter = (await saved(s => s.readingPresets.marking.selected === 'color-ruby')).reading;
  await filter.selectOption('marker');
  const afterFilter = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.reading);
  assert.deepEqual(afterFilter, beforeFilter, '浏览分类不应修改配置');
  await page.locator('.mark-details > summary').click();
  assert.equal(await page.locator('[data-mark] details').count(), 0);
  for (const row of await page.locator('[data-mark]').all()) {
    assert.equal(await row.getByRole('switch').isVisible(), true);
    assert.equal(await row.getByRole('combobox').isVisible(), true);
    assert.equal(await row.getByRole('radio', { name: '红', exact: true }).isVisible(), true);
  }
  await page.getByRole('combobox', { name: '代词标记样式', exact: true }).selectOption('marker');
  await page.locator('[data-mark="pronoun"]').getByRole('radio', { name: '红', exact: true }).click();
  await page.getByRole('switch', { name: '逻辑连接词', exact: true }).uncheck();
  const customSaved = await saved(s => s.reading.syntax.modes.pronoun === 'marker' && s.reading.syntax.colors.pronoun === '#ef4444' && !s.reading.emphasis.connectives);
  const custom = customSaved.readingPresets.marking.custom;
  assert.equal(await themes.getByRole('radio', { name: '自定义', exact: true }).getAttribute('aria-checked'), 'true');
  await filter.selectOption('all');
  await themes.getByRole('radio', { name: '海洋波浪', exact: true }).click();
  await themes.getByRole('radio', { name: '全关', exact: true }).click();
  assert.equal(await page.locator('[data-mark] input:checked').count(), 0);
  assert.equal(await themes.getByRole('radio', { name: '全关', exact: true }).locator('.swatches, .style-preview').count(), 0);
  await saved(s => s.readingPresets.marking.selected === 'off');
  await page.reload();
  await themes.getByRole('radio', { name: '自定义', exact: true }).click();
  const restored = await saved(s => s.reading.syntax.colors.pronoun === '#ef4444' && !s.reading.emphasis.connectives);
  assert.deepEqual({ syntax: restored.reading.syntax, emphasis: restored.reading.emphasis }, custom);
  await global.getByRole('radio', { name: '清爽', exact: true }).click();
  await themes.getByRole('radio', { name: '自定义', exact: true }).click();
  await saved(s => s.reading.syntax.colors.pronoun === '#ef4444');
  await page.getByRole('combobox', { name: '生词与阅读样式优先级', exact: true }).selectOption('vocabulary');
  await saved(s => s.reading.wordStylePriority === 'vocabulary');
  await page.reload();
  assert.equal(await page.getByRole('combobox', { name: '生词与阅读样式优先级', exact: true }).inputValue(), 'vocabulary');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#reading-bionic').scrollIntoViewIfNeeded();
    const preview = await page.locator('.reading-preview').boundingBox();
    assert.ok(preview.y >= 0 && preview.y + preview.height < 500);
    await page.screenshot({ path: `${out}/unified-${width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, totalThemes, categories: 15, palettesPerStyle: '>=9', noAllPreset: true, unifiedCustomRestored: true, priorityPersisted: true, widths: [1440, 390, 320], errors, out }, null, 2));
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
