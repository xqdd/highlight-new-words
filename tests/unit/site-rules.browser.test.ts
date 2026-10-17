import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** 必须使用真实 Chrome URL：Node/jsdom 对 hostname 星号的序列化行为与 Chrome 不同。 */
it('Chromium 原生 URL 下域名通配、IDN、路径及默认端口均匹配且不扩大百分号星号规则', async () => {
  const source = readFileSync(resolve('src/core/sites/rules.ts'), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(code => {
      const exported: Record<string, (a: string, b?: string) => unknown> = {};
      new Function('exports', code)(exported);
      const match = exported.matchesSiteRule!;
      const validate = exported.validateSiteRule!;
      return {
        matches: [
          match('glob:https://*.example.org/news/**', 'https://en.example.org/news/nested/article'),
          match('glob:https://api*.example.org/**', 'https://api2.example.org/a'),
          match('glob:*.例子.测试', 'https://新闻.例子.测试/文章'),
          match('glob:https://*.例子.测试/文章/**', 'https://新闻.例子.测试/文章/一'),
          match('glob:*://example.org:443/**', 'http://example.org:443/a'),
          match('glob:*://example.org:443/**', 'https://example.org/a'),
          match('glob:*://example.org:443/**', 'http://example.org/a'),
          match('glob:https://*.example.org/news/*', 'https://en.example.org/news/nested/article'),
        ],
        rejected: ['glob:https://%2A.example.org/**', 'glob:%2A.example.org', 'glob:新*闻.测试'].map(rule => !!validate(rule)),
      };
    }, javascript);
    expect(result.matches).toEqual([true, true, true, true, true, true, false, false]);
    expect(result.rejected).toEqual([true, true, true]);
  } finally { await browser.close(); }
}, 20000);
