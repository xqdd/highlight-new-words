#!/usr/bin/env node
/** 真实扩展的原生绘制正确性验证；结果及截图写入临时目录，不触碰用户浏览器。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const output = path.resolve(arg('--out', '/tmp/hnw-native-correctness'));
const viewports = arg('--viewports', 'desktop,mobile').split(',');
const styles = ['color', 'underline', 'dotted', 'wavy', 'background', 'marker', 'bold'];
const syntaxKinds = ['verb', 'noun', 'adjective', 'adverb', 'pronoun', 'determiner', 'preposition', 'conjunction', 'numeral', 'interjection', 'particle'];
const syntaxProbe = 'Wow! The clever researchers quickly record the first observations. They want to travel from London to Paris and she followed because they agreed.';
const report = { extension, cases: [], matrix: [], failures: [] };
fs.mkdirSync(output, { recursive: true });
const write = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Native reading correctness</title>
<style>body{font:20px/1.8 Georgia,serif;color:#263238;background:white;margin:24px}article{max-width:680px}a{color:#005577}p{margin:0 0 18px}#longword{font-size:32px;width:220px;overflow-wrap:anywhere}#vocabulary hnw-w,#contents hnw-w{color:#aa2266;background-color:#fedcba;background-image:linear-gradient(#ffeeaa,#ffeeaa);box-shadow:0 0 0 3px #fedcba;outline:1px solid #112233;text-decoration:underline wavy #aa2266;font-weight:700;font-style:italic}::highlight(site-search){background-color:#ffee99}</style>
<article><p id="plain">However, clever researchers never abandon 42 detailed observations.</p>
<p id="syntax">${syntaxProbe}</p>
<p id="linked">They <a id="link" href="#clicked">visit London</a> and enjoy reading books.</p>
<p id="vocabulary">They record music and never forget 42 observations.</p>
<p id="contents">They <span style="display:contents">record <span style="display:contents">music</span></span> and examine detailed observations.</p>
<p id="dynamic">Researchers examine detailed observations every morning.</p>
<p id="longword">electroencephalography helps curious scientists understand human experiences.</p>
<p id="hidden" hidden>Hidden researchers never abandon 42 observations.</p>
<p id="editor" contenteditable="true">Editable researchers never abandon 42 observations.</p></article>
<script>window.refs={};for(const id of ['plain','linked','dynamic','longword','hidden','editor']){const el=document.getElementById(id);window.refs[id]={el,text:el.firstChild,value:el.textContent}}window.clicks=0;document.getElementById('link').addEventListener('click',e=>{e.preventDefault();window.clicks++});const range=new StaticRange({startContainer:refs.plain.text,startOffset:0,endContainer:refs.plain.text,endOffset:7});window.siteHighlight=new Highlight(range);CSS.highlights.set('site-search',siteHighlight);</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') return void res.writeHead(204).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

async function configure(worker, scenario, style, enabled = true) {
  await worker.evaluate(async ({ scenario, style, enabled }) => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.enabled = true;
    settings.sites = { mode: 'all', disabled: scenario === 'reading' ? ['127.0.0.1'] : [], allowed: [] };
    settings.readingSites = { mode: 'all', disabled: [], allowed: [] };
    settings.books.enabled = ['local:native-qa'];
    settings.inlineTranslation.mode = 'off';
    const reading = settings.reading;
    reading.enabled = enabled;
    reading.wordStylePriority = scenario === 'vocabulary-priority' ? 'vocabulary' : 'reading';
    Object.assign(reading.bionic, { enabled: true, minLength: 3, ratio: 0.5, interval: 1 });
    reading.syntax.enabled = true; reading.syntax.mode = style; reading.syntax.modes = {};
    for (const key of Object.keys(reading.syntax.colors)) reading.syntax.colors[key] = '#257539';
    for (const key of ['negation', 'connectives', 'numbers', 'properNouns']) {
      reading.emphasis[key] = true;
      reading.emphasis.styles[key] = { mode: style, color: '#b91645' };
    }
    reading.phrases.enabled = false;
    await chrome.storage.local.set({ settings });
  }, { scenario, style, enabled });
}

async function inspect(page) {
  return page.evaluate(() => {
    const layers = [];
    const nodeIds = new Map();
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith('hnw-reading-')) continue;
      const computed = getComputedStyle(document.getElementById('plain'), `::highlight(${name})`);
      layers.push({ name, priority: highlight.priority, color: computed.color, background: computed.backgroundColor,
        decoration: computed.textDecorationLine, shadow: computed.textShadow,
        ranges: [...highlight].map(range => {
          if (!nodeIds.has(range.startContainer)) nodeIds.set(range.startContainer, nodeIds.size);
          const actual = document.createRange(); actual.setStart(range.startContainer, range.startOffset); actual.setEnd(range.endContainer, range.endOffset);
          return { text: actual.toString(), start: range.startOffset, end: range.endOffset,
            node: nodeIds.get(range.startContainer),
            static: range instanceof StaticRange, connected: range.startContainer.isConnected,
            block: range.startContainer.parentElement.closest('p')?.id,
            protected: !!range.startContainer.parentElement.closest('hnw-mark'), rects: actual.getClientRects().length,
            valid: range.startOffset >= 0 && range.endOffset <= range.endContainer.length };
        }) });
    }
    return { layers, wrappers: document.querySelectorAll('hnw-read').length,
      textIdentity: ['plain', 'linked', 'dynamic', 'longword'].every(id => refs[id].el.firstChild === refs[id].text),
      content: Object.fromEntries([...document.querySelectorAll('article p')].map(el => [el.id, el.textContent])),
      sitePreserved: CSS.highlights.get('site-search') === siteHighlight,
      legacyReadingStyles: [...document.head.querySelectorAll('style')].some(style => style.textContent.includes('hnw-read[data-prefix]:has')),
      vocabulary: [...document.querySelectorAll('#vocabulary hnw-w')].map(el => ({ text: el.textContent, reading: el.hasAttribute('data-hnw-reading-word'), color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor, backgroundImage: getComputedStyle(el).backgroundImage, shadow: getComputedStyle(el).boxShadow,
        outline: getComputedStyle(el).outlineStyle, fontWeight: getComputedStyle(el).fontWeight, fontStyle: getComputedStyle(el).fontStyle,
        decoration: getComputedStyle(el).textDecorationLine,
        covered: [...CSS.highlights].some(([name, highlight]) => name.startsWith('hnw-reading-') && [...highlight].some(range => el.contains(range.startContainer))) })),
      contentsWords: [...document.querySelectorAll('#contents hnw-w')].map(el => el.textContent) };
  });
}

async function waitPaint(page, block = 'plain') {
  await page.locator(`#${block}`).scrollIntoViewIfNeeded();
  await page.waitForFunction(id => [...CSS.highlights].some(([name, highlight]) => name.startsWith('hnw-reading-') && [...highlight].some(range => range.startContainer.parentElement.closest('p')?.id === id)), block);
}

async function dynamicChecks(page, worker, scenario, style) {
  await page.evaluate(() => { refs.dynamic.text.data = 'New researchers never forget 25 important discoveries.'; });
  await waitPaint(page, 'dynamic');
  await page.waitForFunction(() => {
    const marks = [...CSS.highlights].filter(([name]) => name.startsWith('hnw-reading-')).flatMap(([, highlight]) => [...highlight])
      .filter(range => range.startContainer === refs.dynamic.text && range.startOffset < 3).sort((a, b) => a.startOffset - b.startOffset);
    return marks.length && marks[0].startOffset === 0 && marks.at(-1).endOffset === 3;
  });
  assert.equal(await page.locator('#dynamic').textContent(), 'New researchers never forget 25 important discoveries.');
  await page.evaluate(() => { refs.dynamic.el.hidden = true; });
  await page.waitForFunction(() => ![...CSS.highlights].some(([name, highlight]) => name.startsWith('hnw-reading-') && [...highlight].some(range => refs.dynamic.el.contains(range.startContainer))));
  await page.evaluate(() => { refs.dynamic.el.hidden = false; }); await waitPaint(page, 'dynamic');
  await page.evaluate(() => { refs.dynamic.el.remove(); });
  await page.waitForFunction(() => ![...CSS.highlights].some(([name, highlight]) => name.startsWith('hnw-reading-') && [...highlight].some(range => refs.dynamic.el.contains(range.startContainer))));
  await page.evaluate(() => { document.querySelector('article').append(refs.dynamic.el); }); await waitPaint(page, 'dynamic');
  if (scenario !== 'reading') {
    await page.evaluate(() => { window.detachedInline = document.querySelector('#contents > span'); detachedInline.remove(); });
    await page.waitForFunction(() => !detachedInline.querySelector('[data-hnw-reading-word]') && ![...CSS.highlights].some(([name, highlight]) => name.startsWith('hnw-reading-') && [...highlight].some(range => detachedInline.contains(range.startContainer))));
    await page.evaluate(() => { const parent = document.getElementById('contents'); parent.insertBefore(detachedInline, parent.lastChild); });
    await waitPaint(page, 'contents');
    await page.waitForFunction(() => document.querySelectorAll('#contents hnw-mark').length >= 2);
    if (scenario === 'all') await page.waitForFunction(() => [...document.querySelectorAll('#contents hnw-w')].every(word => [...CSS.highlights].some(([name, highlight]) => name.startsWith('hnw-reading-') && [...highlight].some(range => word.contains(range.startContainer)))));
    assert.equal(await page.locator('#contents').textContent(), 'They record music and examine detailed observations.');
  }
  await page.locator('#linked').scrollIntoViewIfNeeded();
  const selection = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.getElementById('linked'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    return { selected: getSelection().toString(), original: refs.linked.value };
  });
  assert.equal(selection.selected, selection.original, 'selection/copy source changed');
  await page.keyboard.press('ControlOrMeta+C');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selection.original, 'copied plain text changed');
  await page.evaluate(() => { getSelection().removeAllRanges(); });
  await page.locator('#link').click(); assert.equal(await page.evaluate(() => clicks), 1);
  await configure(worker, scenario, style, false);
  await page.waitForFunction(() => ![...CSS.highlights.keys()].some(name => name.startsWith('hnw-reading-')));
  assert.equal(await page.evaluate(() => CSS.highlights.get('site-search') === siteHighlight), true);
  assert.equal(await page.locator('hnw-read,[data-hnw-reading-word]').count(), 0);
  if (scenario !== 'reading') assert.ok(await page.locator('#vocabulary hnw-mark').count() > 0, 'disabling reading removed vocabulary');
  return { originalTextUpdates: true, hideShow: true, detachReattach: true, detachedInline: scenario !== 'reading', selectionCopySource: true, linkClick: true, disableOwnRegistryOnly: true };
}

try {
  for (const [viewportName, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    if (!viewports.includes(viewportName)) continue;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-native-qa-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport,
      hasTouch: viewportName === 'mobile', isMobile: viewportName === 'mobile',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
          if ((await chrome.storage.local.get('settings')).settings) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const id = 'local:native-qa', now = Date.now();
        await chrome.storage.local.set({ localBooks: { books: { [id]: { id, name: 'QA', format: 'txt', wordCount: 2, createdAt: now, updatedAt: now } }, removed: {} },
          [`localBook:${id}`]: { id, words: { record: { word: 'record', translation: '记录' }, music: { word: 'music', translation: '音乐' } } } });
      });
      // 从实际扩展页面经 runtime 消息调用真实后台；此检查会直接暴露 SW 模块加载失败。
      const probe = await context.newPage();
      await probe.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
      const response = await probe.evaluate(async text => chrome.runtime.sendMessage({ ns: 'hnw', type: 'analyzeReading', data: { text, withSyntax: true } }), syntaxProbe);
      report[`background-${viewportName}`] = response; write();
      assert.equal(response?.ok, true, JSON.stringify(response));
      for (const pos of syntaxKinds) assert.ok(response.result.some(token => token.pos === pos), `real background missing POS ${pos}`);
      await probe.close();
      for (const scenario of ['reading', 'all', 'vocabulary-priority']) for (const style of styles) {
        const result = { viewport: viewportName, scenario, style, status: 'running', errors: [] };
        report.cases.push(result); write();
        const page = await context.newPage();
        page.on('pageerror', error => result.errors.push(error.message));
        try {
          await configure(worker, scenario, style);
          await page.goto(url); await waitPaint(page);
          if (scenario !== 'reading') await page.waitForFunction(() => document.querySelectorAll('#vocabulary hnw-mark').length >= 2 && document.querySelectorAll('#contents hnw-mark').length >= 2);
          await waitPaint(page, 'syntax');
          await waitPaint(page, 'longword');
          await page.locator('#plain').scrollIntoViewIfNeeded();
          result.paint = await inspect(page);
          const painted = result.paint.layers.flatMap(layer => layer.ranges);
          assert.equal(result.paint.wrappers, 0); assert.equal(result.paint.textIdentity, true);
          assert.equal(result.paint.legacyReadingStyles, false);
          assert.equal(result.paint.sitePreserved, true);
          assert.ok(painted.length > 10); assert.ok(painted.every(range => range.valid && range.static && range.connected && (!range.protected || scenario === 'all')));
          for (const pos of syntaxKinds) assert.ok(result.paint.layers.some(layer => layer.name.includes(`-${pos}-`) && layer.ranges.length), `paint missing POS ${pos}`);
          assert.ok(painted.every(range => !['hidden', 'editor'].includes(range.block)));
          assert.ok(painted.some(range => range.block === 'longword' && range.rects > 1), 'long word must actually wrap');
          const prefixes = result.paint.layers.filter(layer => layer.name.endsWith('-prefix') && layer.ranges.length);
          assert.ok(prefixes.length > 0);
          for (const prefix of prefixes) {
            const suffix = result.paint.layers.find(layer => layer.name === prefix.name.slice(0, -7));
            if (!suffix) continue;
            assert.equal(prefix.color, suffix.color, 'prefix changed semantic text color');
            assert.equal(prefix.background, suffix.background, 'prefix changed semantic background');
            assert.equal(prefix.priority, suffix.priority);
            for (const leading of prefix.ranges) assert.ok(!suffix.ranges.some(trailing => trailing.node === leading.node && trailing.start < leading.end && trailing.end > leading.start), 'prefix overlaps suffix');
          }
          assert.ok(result.paint.layers.some(layer => layer.ranges.length && (layer.decoration !== 'none' || layer.shadow !== 'none' || layer.background !== 'rgba(0, 0, 0, 0)' || layer.color !== 'rgb(38, 50, 56)')));
          if (scenario !== 'reading') assert.ok(result.paint.vocabulary.filter(word => /record|music/.test(word.text)).every(word => word.reading === (scenario === 'all') && word.covered === (scenario === 'all')));
          if (scenario === 'all') for (const word of result.paint.vocabulary) {
            assert.equal(word.background, 'rgba(0, 0, 0, 0)'); assert.equal(word.backgroundImage, 'none');
            assert.equal(word.shadow, 'none'); assert.equal(word.outline, 'none');
            assert.equal(word.fontWeight, '400'); assert.equal(word.fontStyle, 'normal');
            assert.equal(word.decoration, 'none');
          }
          if (scenario === 'vocabulary-priority') for (const word of result.paint.vocabulary) {
            assert.equal(word.background, 'rgb(254, 220, 186)'); assert.notEqual(word.shadow, 'none');
            assert.equal(word.fontWeight, '700'); assert.equal(word.fontStyle, 'italic');
          }
          if (scenario !== 'reading') assert.deepEqual(result.paint.contentsWords, ['record', 'music'], 'display:contents lost vocabulary matching');
          const file = `${viewportName}-${scenario}-${style}`;
          const paintedPng = await page.screenshot({ path: path.join(output, `${file}.png`) });
          await page.evaluate(() => { window.savedReading = [...CSS.highlights].filter(([name]) => name.startsWith('hnw-reading-')); for (const [name] of savedReading) CSS.highlights.delete(name); });
          const originalPng = await page.screenshot({ path: path.join(output, `${file}-native.png`) });
          assert.equal(paintedPng.equals(originalPng), false, 'native highlights produce no visible pixels');
          await page.evaluate(() => { for (const [name, highlight] of savedReading) CSS.highlights.set(name, highlight); });
          result.visiblePixelsDiffer = true;
          result.dynamic = await dynamicChecks(page, worker, scenario, style);
          assert.deepEqual(result.errors, []);
          result.status = 'passed';
        } catch (error) {
          result.status = 'failed'; result.error = error.stack; report.failures.push({ viewport: viewportName, scenario, style, error: error.message });
          await page.screenshot({ path: path.join(output, `${viewportName}-${scenario}-${style}-failure.png`) }).catch(() => {});
        } finally { write(); await page.close(); }
      }
      const matrix = { viewport: viewportName, scenario: 'bionic-only-origin-style-reset', status: 'running' };
      report.matrix.push(matrix); write();
      const page = await context.newPage();
      try {
        await configure(worker, 'all', 'color');
        await worker.evaluate(async () => {
          const { settings } = await chrome.storage.local.get('settings');
          settings.reading.syntax.enabled = false;
          for (const key of ['negation', 'connectives', 'numbers', 'properNouns']) settings.reading.emphasis[key] = false;
          await chrome.storage.local.set({ settings });
        });
        await page.goto(url); await waitPaint(page, 'vocabulary');
        await page.waitForFunction(() => document.querySelectorAll('#vocabulary hnw-w[data-hnw-reading-word]').length === 2);
        matrix.active = await inspect(page);
        for (const word of matrix.active.vocabulary) {
          assert.equal(word.color, 'rgb(38, 50, 56)', 'bionic-only must inherit article text color');
          assert.equal(word.background, 'rgba(0, 0, 0, 0)'); assert.equal(word.backgroundImage, 'none');
          assert.equal(word.shadow, 'none'); assert.equal(word.outline, 'none'); assert.equal(word.decoration, 'none');
          assert.equal(word.fontWeight, '400'); assert.equal(word.fontStyle, 'normal');
        }
        await page.screenshot({ path: path.join(output, `${viewportName}-bionic-only-reset.png`) });
        await configure(worker, 'all', 'color', false);
        await page.waitForFunction(() => !document.querySelector('[data-hnw-reading-word]'));
        // 生词自带背景色过渡，等待其实际恢复完成后比较，避免把动画中间帧误判成残留复位样式。
        await page.waitForFunction(() => [...document.querySelectorAll('#vocabulary hnw-w')].every(word => getComputedStyle(word).backgroundColor === 'rgb(254, 220, 186)'));
        matrix.restored = await inspect(page);
        for (const word of matrix.restored.vocabulary) {
          assert.equal(word.color, 'rgb(170, 34, 102)'); assert.equal(word.background, 'rgb(254, 220, 186)');
          assert.notEqual(word.backgroundImage, 'none'); assert.notEqual(word.shadow, 'none');
          assert.equal(word.outline, 'solid'); assert.equal(word.decoration, 'underline');
          assert.equal(word.fontWeight, '700'); assert.equal(word.fontStyle, 'italic');
        }
        assert.equal(matrix.restored.sitePreserved, true);
        await page.screenshot({ path: path.join(output, `${viewportName}-bionic-only-restored.png`) });
        matrix.status = 'passed';
      } catch (error) {
        matrix.status = 'failed'; matrix.error = error.stack; report.failures.push({ viewport: viewportName, scenario: matrix.scenario, error: error.message });
      } finally { write(); await page.close(); }
    } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
  }
} finally { server.close(); write(); }
console.log(JSON.stringify({ output, passed: report.cases.filter(item => item.status === 'passed').length, matrixPassed: report.matrix.filter(item => item.status === 'passed').length, failures: report.failures }, null, 2));
if (report.failures.length) process.exitCode = 1;
