#!/usr/bin/env node
/** 真实网站采样：保留可访问性、正文结构、阅读标记及实际往返滚动证据。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const output = path.resolve(arg('--out', '/tmp/hnw-reading-sites'));
const extension = path.resolve(arg('--ext', '.output/chrome-mv3'));
const selected = arg('--sites', '').split(',').filter(Boolean);
const reusableProfile = arg('--profile', '');
const bodyAnchors = process.argv.includes('--body-anchors');
const sites = [
  { id: 'chatgpt', url: 'https://learn.chatgpt.com/docs/config-file/config-reference', regions: { article: 'article' } },
  { id: 'youtube-fragments', url: 'https://www.youtube.com/watch?v=mjg_JUMar04', regions: { description: '#description-inline-expander #expanded', comments: '#comments #content-text', title: 'h1' } },
  { id: 'youtube', url: 'https://www.youtube.com/watch?v=XqtnBlPJ6KE', regions: { description: '#description-inline-expander, ytd-text-inline-expander', comments: '#comments #content-text', title: 'h1' } },
  { id: 'medium', url: 'https://medium.com/blog/how-medium-moderates-its-open-platform-in-the-ai-era-6ffb28f38cf8', regions: { article: 'article' } },
  { id: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Barack_Obama', regions: { article: '.mw-parser-output' } },
  { id: 'github', url: 'https://github.com/microsoft/TypeScript', regions: { article: 'article', description: '.BorderGrid-cell' } },
  { id: 'stackoverflow', url: 'https://stackoverflow.com/questions/111102/how-do-javascript-closures-work', regions: { article: '.s-prose', comments: '.comment-copy' } },
  { id: 'reddit', url: 'https://www.reddit.com/r/AskReddit/', regions: { article: 'shreddit-post', comments: 'shreddit-comment' } },
  { id: 'bbc', url: 'https://www.bbc.com/news', regions: { article: 'article,main' } },
  { id: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction', regions: { article: 'main' } },
  { id: 'hackernews', url: 'https://news.ycombinator.com/item?id=8863', regions: { article: '.toptext', comments: '.commtext' } },
].filter(site => !selected.length || selected.includes(site.id));
fs.mkdirSync(output, { recursive: true });
const profile = reusableProfile ? path.resolve(reusableProfile) : fs.mkdtempSync(path.join(os.tmpdir(), 'hnw-sites-profile-'));
fs.mkdirSync(profile, { recursive: true });
const report = { extension, contentScriptSha256: createHash('sha256').update(fs.readFileSync(path.join(extension, 'content-scripts/content.js'))).digest('hex'), startedAt: new Date().toISOString(), positioning: bodyAnchors ? 'actual-body-block-index' : 'document-height-ratio', sites: [] };
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
// 直接检查当前可见正文块，避免巨大的 article 容器有标记就掩盖局部段落漏标。
function inspectBodyBlocks() {
  return (window.__siteBodyBlocks ?? []).filter(el => {
    const box = el.getBoundingClientRect();
    return el.isConnected && box.bottom > 0 && box.top < innerHeight && box.width > 0;
  }).map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 300), marks: el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length, bounds: el.getBoundingClientRect().toJSON() }));
}
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
  for (const site of sites) {
    const result = { id: site.id, url: site.url, samples: [], errors: [] }; report.sites.push(result); save();
    const page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    try {
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = true; await chrome.storage.local.set({ settings }); });
      const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      result.status = response?.status(); await page.waitForTimeout(2500);
      result.title = await page.title();
      result.bodyStart = (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 600);
      // 验证页即使 HTTP 200 也不是目标内容，不能把其标记数记为站点覆盖通过。
      if (result.status >= 400 || /captcha|access denied|verify you are human|prove your humanity|blocked|just a moment|attention required/i.test(`${result.title}\n${result.bodyStart}`)) {
        result.outcome = 'blocked-or-error';
        await page.screenshot({ path: path.join(output, `${site.id}.png`) });
        fs.writeFileSync(path.join(output, `${site.id}.html`), await page.content());
        continue;
      }
      if (site.id.startsWith('youtube')) {
        const expand = page.locator('#description-inline-expander #expand, ytd-text-inline-expander #expand').first();
        if (await expand.isVisible()) await expand.click({ timeout: 3000 });
      }
      if (bodyAnchors) {
        const selector = site.id === 'hackernews' ? site.regions.comments : site.regions.article;
        result.bodyAnchors = await page.evaluate(selector => {
          const roots = [...document.querySelectorAll(selector)];
          const candidates = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('p,li,blockquote,figcaption,dd,dt,h1,h2,h3,td,th')]))];
          window.__siteBodyBlocks = candidates.filter(el => {
            if (el.closest('nav,header,footer,aside,pre,code,button,[role="navigation"],[hidden],[aria-hidden="true"]')) return false;
            if (!el.matches('p,li,blockquote,figcaption,dd,dt,h1,h2,h3,td,th,.commtext')) return false;
            if (el.matches('li,blockquote,td,th') && el.querySelector('p,li,blockquote')) return false;
            const text = el.textContent.trim();
            if ((text.match(/[A-Za-z]{2,}/g) ?? []).length < 3 || text.length > 6000 || /^https?:\/\/\S+$/.test(text)) return false;
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          });
          if (!window.__siteBodyBlocks.length) throw new Error(`No real body anchors found: ${selector}`);
          return { selector, count: window.__siteBodyBlocks.length, first: window.__siteBodyBlocks[0].textContent.slice(0, 160), last: window.__siteBodyBlocks.at(-1).textContent.slice(0, 160) };
        }, selector);
      }
      for (const position of [0, 0.5, 0.95, 0]) {
        const anchor = await page.evaluate(({ position, bodyAnchors }) => {
          if (!bodyAnchors) { scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * position); return null; }
          const index = Math.floor((window.__siteBodyBlocks.length - 1) * position);
          const el = window.__siteBodyBlocks[index];
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          return { index, tag: el.tagName, text: el.textContent.slice(0, 180) };
        }, { position, bodyAnchors });
        await page.waitForTimeout(1100);
        // wheel 触发真实滚动，记录页面自身和扩展共同造成的帧停顿。
        await page.evaluate(() => { window.__siteFrames = []; window.__siteMeasure = true; let previous; const frame = now => { if (!window.__siteMeasure) return; if (previous) window.__siteFrames.push(now - previous); previous = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
        const started = Date.now();
        for (const direction of [1, -1]) for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, direction * 360); await page.waitForTimeout(40); }
        // 页面边界会截断一侧wheel行程，重新定位原段落后再计停稳时间，确保仍在验正文。
        if (bodyAnchors) await page.evaluate(index => window.__siteBodyBlocks[index].scrollIntoView({ block: 'center', behavior: 'instant' }), anchor.index);
        await page.waitForTimeout(400);
        const elapsed = Date.now() - started;
        await page.evaluate(() => { window.__siteMeasure = false; });
        // 动态评论可能在 wheel 后才到达；额外等待补标，不将等待帧混入滚动流畅度样本。
        await page.waitForTimeout(1500);
        result.samples.push(await page.evaluate(({ regions, position, elapsed }) => {
          window.__siteMeasure = false;
          const frames = window.__siteFrames.sort((a, b) => a - b);
          const visible = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; };
          const sample = { position, elapsed, scrollY, height: document.documentElement.scrollHeight, frames: { p95: frames[Math.floor(frames.length * .95)] ?? null, max: frames.at(-1) ?? null, over50: frames.filter(x => x > 50).length }, marks: document.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length, excludedReadingMarks: document.querySelectorAll('nav hnw-read[data-pos],aside hnw-read[data-pos],ytd-compact-video-renderer hnw-read[data-pos],yt-lockup-view-model hnw-read[data-pos],ytd-rich-item-renderer hnw-read[data-pos]').length, regions: {} };
          for (const [name, selector] of Object.entries(regions)) {
            const roots = [...document.querySelectorAll(selector)];
            const blocks = roots.flatMap(root => [root, ...root.querySelectorAll('p,li,blockquote,yt-formatted-string,yt-attributed-string,[id="content-text"]')]).filter(el => visible(el) && el.textContent.trim().length > 20);
            const targets = [];
            const seen = new Set();
            for (const root of roots) {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
              let text;
              while ((text = walker.nextNode())) {
                if (seen.has(text) || !visible(text.parentElement)) continue;
                seen.add(text);
                for (const match of text.data.matchAll(/\b(we|there|what|someone)\b/gi)) {
                  const mark = text.parentElement.closest('hnw-read:not([data-group]),[data-hnw-reading-word]');
                  targets.push({ word: match[0], context: text.parentElement.closest('p,li,yt-attributed-string,yt-formatted-string')?.textContent.slice(0, 240) ?? text.data.slice(0, 240), annotated: Boolean(mark), pos: mark?.getAttribute('data-pos') ?? null });
                }
              }
            }
            sample.regions[name] = { count: roots.length, targets: targets.slice(0, 40), visible: blocks.slice(0, 12).map(el => ({ tag: el.tagName, id: el.id, class: el.className, text: el.textContent.trim().slice(0, 260), marks: el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length })) };
          }
          return sample;
        }, { regions: site.regions, position, elapsed }));
        const sample = result.samples.at(-1);
        if (bodyAnchors) {
          sample.anchor = anchor;
          sample.bodyAfter1900ms = await page.evaluate(inspectBodyBlocks);
          if (!sample.bodyAfter1900ms.length) throw new Error(`No visible body block at anchor ${anchor.index}`);
          sample.bodyMissingAfter1900ms = sample.bodyAfter1900ms.filter(block => block.marks === 0);
          if (sample.bodyMissingAfter1900ms.length) {
            await page.waitForTimeout(10000);
            sample.bodyAfterAdditional10s = await page.evaluate(inspectBodyBlocks);
            sample.bodyMissingAfterAdditional10s = sample.bodyAfterAdditional10s.filter(block => block.marks === 0);
          }
        }
        if (!bodyAnchors && sample.regions.comments?.visible.some(block => block.marks === 0)) {
          // 排除仅仅排队较慢：延长观察后保留真实节点结构和位置，用于复现持续漏标。
          await page.waitForTimeout(10000);
          sample.commentsAfter10s = await page.evaluate(selector => [...document.querySelectorAll(selector)].filter(el => {
            const box = el.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.width > 0;
          }).slice(0, 12).map(el => ({
            text: el.textContent.slice(0, 300), marks: el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length,
            targets: [...el.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]')].filter(mark => /^(we(?:['’].*)?|there(?:['’].*)?|what(?:['’].*)?|someone)$/i.test(mark.textContent)).map(mark => ({ text: mark.textContent, pos: mark.getAttribute('data-pos') })),
            bounds: el.getBoundingClientRect().toJSON(), html: el.outerHTML.slice(0, 1800),
            paragraphs: [...el.querySelectorAll('p')].slice(0, 8).map(p => ({ text: p.textContent.slice(0, 180), bounds: p.getBoundingClientRect().toJSON(), marks: p.querySelectorAll('hnw-read:not([data-group]),[data-hnw-reading-word]').length, html: p.outerHTML.slice(0, 800) })),
          })), site.regions.comments);
        }
        save();
      }
      await page.screenshot({ path: path.join(output, `${site.id}.png`) });
      fs.writeFileSync(path.join(output, `${site.id}.html`), await page.content());
      // 保存网站持有的实际元素引用，关闭后检查同一段原文，不把动态新增评论算成正文变化。
      const restoreSelectors = Object.values(site.regions).join(',');
      await page.evaluate(selector => {
        const roots = [...document.querySelectorAll(selector)];
        const elements = new Set(roots.flatMap(root => [root, ...root.querySelectorAll('p,li,h1,h2,h3,blockquote,#content-text')]));
        window.__siteRestoreSamples = [...elements].filter(el => el.textContent.trim().length > 20).map(el => ({ el, text: el.textContent }));
      }, restoreSelectors);
      await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.enabled = false; await chrome.storage.local.set({ settings }); });
      await page.waitForFunction(() => !document.querySelector('hnw-read'), null, { timeout: 10000 });
      result.restore = await page.evaluate(() => {
        const connected = window.__siteRestoreSamples.filter(sample => sample.el.isConnected);
        return { sampled: window.__siteRestoreSamples.length, connected: connected.length, changed: connected.filter(sample => sample.el.textContent !== sample.text).map(sample => ({ tag: sample.el.tagName, before: sample.text.slice(0, 160), after: sample.el.textContent.slice(0, 160) })).slice(0, 10), residualMarks: document.querySelectorAll('hnw-read,[data-hnw-reading-word]').length };
      });
      result.outcome = result.status >= 400 || /captcha|access denied|verify you are human|prove your humanity|blocked|just a moment|attention required/i.test(`${result.title}\n${result.bodyStart}`) ? 'blocked-or-error' : 'sampled';
    } catch (error) { result.outcome = 'failed'; result.error = error.message; }
    finally { await page.close(); save(); console.log(JSON.stringify({ id: result.id, status: result.status, title: result.title, outcome: result.outcome, marks: result.samples.map(sample => sample.marks), error: result.error })); }
  }
} finally { await context.close(); if (!reusableProfile) fs.rmSync(profile, { recursive: true, force: true }); save(); }
