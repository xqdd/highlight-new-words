#!/usr/bin/env node
/** 用户实际 MHTML 的离线扩展验收：标准 MIME 解码，保留完整 HTML/CSS/媒体并拦截所有外网。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const source = path.resolve(arg('--source', '/home/cuishuqiang/medium.mhtml'));
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const output = path.resolve(arg('--out', '/tmp/hnw-reading-medium'));
const onlyTargets = arg('--only', '').split(',').map(name => name.trim()).filter(Boolean);
fs.mkdirSync(output, { recursive: true });
// email 标准库处理 MIME 边界、折行及传输编码；避免用字符串切分误损坏 MHTML 资源。
const mime = JSON.parse(execFileSync('python3', ['-c', `
import base64, email.parser, email.policy, json, sys
with open(sys.argv[1], 'rb') as stream:
    message = email.parser.BytesParser(policy=email.policy.default).parse(stream)
parts = []
for part in message.walk():
    if part.is_multipart():
        continue
    parts.append({'type': part.get_content_type(), 'charset': part.get_content_charset() or 'utf-8', 'location': part.get('Content-Location', ''), 'cid': str(part.get('Content-ID', '')).strip('<>'), 'data': base64.b64encode(part.get_payload(decode=True)).decode('ascii')})
print(json.dumps({'location': message.get('Snapshot-Content-Location', ''), 'parts': parts}))
`, source], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }));
const primary = mime.parts.find(part => part.type === 'text/html');
const url = primary.location || mime.location;
const replayPrefix = 'https://hnw-medium-snapshot.invalid/resource/';
const cidUrls = new Map();
for (const [index, part] of mime.parts.entries()) {
  if (part.cid) cidUrls.set(`cid:${part.cid}`, `${replayPrefix}${index}`);
  if (part.location.startsWith('cid:')) cidUrls.set(part.location, `${replayPrefix}${index}`);
}
const resources = new Map();
for (const part of mime.parts) {
  let body = Buffer.from(part.data, 'base64');
  if (part.type === 'text/html' || part.type === 'text/css') {
    let text = body.toString('utf8');
    for (const [cid, resourceUrl] of cidUrls) text = text.replaceAll(cid, resourceUrl);
    body = Buffer.from(text);
  }
  const resource = { body, contentType: part.type };
  if (part.location) resources.set(new URL(part.location, url).href, resource);
  if (part.cid) resources.set(cidUrls.get(`cid:${part.cid}`), resource);
  if (part.location.startsWith('cid:')) resources.set(cidUrls.get(part.location), resource);
}
const html = resources.get(url).body.toString('utf8');
const document = new JSDOM(html).window.document;
const snapshotDocument = new JSDOM(Buffer.from(primary.data, 'base64').toString('utf8')).window.document;
const attributes = el => Object.fromEntries([...el.attributes].filter(attr => /^(data-test|role$|aria-|id$)/.test(attr.name)).map(attr => [attr.name, attr.value]));
const preElements = [...document.querySelectorAll('pre')];
const report = {
  source, sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  extension, url, mode: '完整用户MHTML标准MIME解析离线回放；全部外网阻断；不是实时Medium访问',
  resources: mime.parts.length, articleParagraphs: document.querySelectorAll('.pw-post-body-paragraph').length,
  snapshotAudit: { oldMarks: snapshotDocument.querySelectorAll('hnw-read,hnw-mark,[data-hnw-reading-word]').length, oldElements: [...snapshotDocument.querySelectorAll('*')].filter(el => el.tagName.startsWith('HNW') || [...el.attributes].some(attr => /hnw/i.test(attr.name))).length, oldStyles: [...snapshotDocument.querySelectorAll('style,link')].filter(el => /hnw/i.test(el.outerHTML)).length, bodyTextSha256: createHash('sha256').update(snapshotDocument.body.textContent).digest('hex') },
  snapshotPre: preElements.map(pre => ({ text: pre.textContent.slice(0, 400), html: pre.outerHTML.slice(0, 1100), ancestors: [...function* (el) { for (let i = 0; el && i < 15; i++, el = el.parentElement) yield { tag: el.tagName, class: el.className, attributes: attributes(el), responseOptions: el.querySelectorAll('button[aria-label="Response options"]').length, responseSidebar: el.querySelectorAll('[data-dd-action-name*="respond_sidebar"]').length }; }(pre)] })),
  embeddedQuotes: [...document.querySelectorAll('[id^="embedded-quote"]')].map(el => ({ text: el.textContent, html: el.parentElement.outerHTML.slice(0, 1500), ancestors: [...function* (node) { for (let i = 0; node && i < 4; i++, node = node.parentElement) yield { tag: node.tagName, attributes: attributes(node) }; }(el)] })),
  quotedParagraphs: [...document.querySelectorAll('.pw-post-body-paragraph')].filter(el => /[“"]\s*[A-Za-z]/.test(el.textContent)).map(el => ({ id: el.id, text: el.textContent.slice(0, 400), html: el.outerHTML.slice(0, 900) })),
  samples: [], errors: [], blockedResources: [],
};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
function inspectParagraph(el) {
  const text = el.textContent;
  const quote = text.match(/[“"]\s*([A-Za-z]+(?:['’][A-Za-z]+)?)/);
  let quotedWord;
  if (quote) {
    const start = quote.index + quote[0].lastIndexOf(quote[1]);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let offset = 0, node;
    while ((node = walker.nextNode())) {
      if (offset + node.length > start) {
        const mark = node.parentElement.closest('hnw-read:not([data-group]),[data-hnw-reading-word]');
        quotedWord = { word: quote[1], annotated: Boolean(mark), pos: mark?.getAttribute('data-pos') ?? null };
        break;
      }
      offset += node.length;
    }
  }
  return { text: text.slice(0, 400), marks: el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length, vocabularyMarks: el.querySelectorAll('hnw-mark').length, quotedWord, bounds: el.getBoundingClientRect().toJSON(), targets: [...el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]')].filter(mark => /^(we(?:['’].*)?|there(?:['’].*)?|what(?:['’].*)?|someone|ai)$/i.test(mark.textContent)).map(mark => ({ text: mark.textContent, pos: mark.getAttribute('data-pos') })) };
}
save();
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ prepared: true, resources: report.resources, paragraphs: report.articleParagraphs, pre: report.snapshotPre.length, output }));
  process.exit(0);
}
report.contentScriptSha256 = createHash('sha256').update(fs.readFileSync(path.join(extension, 'content-scripts/content.js'))).digest('hex');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-medium-profile-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings) {
        settings.enabled = true; settings.books.enabled = ['cet6']; settings.inlineTranslation.mode = 'off';
        const r = settings.reading; r.enabled = true; r.wordStylePriority = 'reading'; r.bionic.enabled = true;
        Object.assign(r.syntax, { enabled: true, verbs: true, nouns: true, adjectives: true, adverbs: true, pronouns: true, determiners: true, prepositions: true, conjunctions: true, numerals: true, interjections: true, particles: true });
        Object.assign(r.emphasis, { negation: true, connectives: true, numbers: true, properNouns: true }); r.phrases.enabled = true;
        await chrome.storage.local.set({ settings }); return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('settings timeout');
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith('chrome-extension:')) return route.continue();
    const resource = resources.get(route.request().url());
    if (resource) return route.fulfill({ body: resource.body, contentType: resource.contentType, headers: { 'content-security-policy': "script-src 'none';connect-src 'none'" } });
    if (!report.blockedResources.includes(route.request().url())) report.blockedResources.push(route.request().url());
    return route.abort();
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  report.layout = await page.evaluate(() => ({ styleSheets: document.styleSheets.length, h1Font: getComputedStyle(document.querySelector('h1')).fontFamily, h1Size: getComputedStyle(document.querySelector('h1')).fontSize, paragraphFont: getComputedStyle(document.querySelector('.pw-post-body-paragraph')).fontFamily, paragraphSize: getComputedStyle(document.querySelector('.pw-post-body-paragraph')).fontSize, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  if (report.layout.styleSheets < 10) throw new Error(`MHTML CSS replay incomplete: ${report.layout.styleSheets} stylesheets`);
  // 与扩展运行前静态解析的原文比对，避免把已经处理过的 DOM 当作恢复基线。
  report.loadedTextMatchesSnapshot = await page.evaluate(original => document.body.textContent === original, document.body.textContent);
  const paragraphSelector = '.pw-post-body-paragraph:not([id^="embedded-quote"])';
  const paragraphs = page.locator(paragraphSelector);
  const count = await paragraphs.count();
  const targets = [
    { name: 'article-start', selector: paragraphSelector, index: 0 },
    { name: 'article-middle', selector: paragraphSelector, index: Math.floor(count / 2) },
    { name: 'article-end', selector: paragraphSelector, index: Math.max(0, count - 1) },
    ...report.quotedParagraphs.map(item => ({ name: `quote-${item.id}`, selector: `[id="${item.id}"]`, index: 0 })),
    ...report.snapshotPre.map((_, index) => ({ name: `response-${index}`, selector: 'pre', index })),
  ];
  const unknownTargets = onlyTargets.filter(name => !targets.some(target => target.name === name));
  if (unknownTargets.length) throw new Error(`Unknown --only targets: ${unknownTargets.join(', ')}`);
  report.selectedTargets = onlyTargets.length ? targets.filter(target => onlyTargets.includes(target.name)).map(target => target.name) : targets.map(target => target.name);
  for (const target of targets.filter(target => report.selectedTargets.includes(target.name))) {
    const locator = page.locator(target.selector).nth(target.index);
    await locator.scrollIntoViewIfNeeded();
    const started = Date.now();
    const timeline = [];
    for (let i = 0; i < 20; i++) {
      const state = await locator.evaluate(inspectParagraph);
      timeline.push({ elapsed: Date.now() - started, ...state });
      if (state.marks > 0 && Date.now() - started >= 1900) break;
      await page.waitForTimeout(100);
    }
    const sample = { ...target, timeline, firstMarkMs: timeline.find(state => state.marks > 0)?.elapsed ?? null };
    if (!timeline.at(-1).marks) {
      await page.waitForTimeout(8000);
      sample.after10s = await locator.evaluate(el => ({ text: el.textContent.slice(0, 400), marks: el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length, vocabularyMarks: el.querySelectorAll('hnw-mark').length, html: el.outerHTML.slice(0, 1800), bounds: el.getBoundingClientRect().toJSON() }));
    }
    report.samples.push(sample); save();
    await page.screenshot({ path: path.join(output, `${target.name}.png`) });
  }
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; await chrome.storage.local.set({ settings }); });
  await page.waitForFunction(() => !document.querySelector('hnw-read'), null, { timeout: 15000 });
  report.restore = await page.evaluate(original => ({ unchanged: document.body.textContent === original, residual: document.querySelectorAll('hnw-read,[data-hnw-reading-word],hnw-mark').length }), document.body.textContent);
} finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); save(); }
console.log(JSON.stringify({ samples: report.samples.map(sample => ({ name: sample.name, firstMarkMs: sample.firstMarkMs, finalMarks: sample.timeline.at(-1).marks, after10s: sample.after10s?.marks })), restore: report.restore, output }));
