#!/usr/bin/env node
/** 从固定 ECDICT 版本提取固定表达。只输出原词典释义，不生成或猜测翻译。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const raw = fs.readFileSync(path.join(option('--raw', '.cache/data-raw'), 'ecdict.csv'));
const sha256 = '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf';
if (createHash('sha256').update(raw).digest('hex') !== sha256) throw new Error('ECDICT 原始数据与固定版本不符，请用 fetch-raw.sh 获取');
const rows = parse(raw, { columns: true, skip_empty_lines: true });
const words = new Map(rows.filter(r => /^[a-z]+$/.test(r.word)).map(r => [r.word, r]));
// 部分屈折词（如 words）没有自身词频，沿 ECDICT exchange 的原形取频率，避免误删常用表达。
function wordRank(word, visited = new Set()) {
  if (visited.has(word)) return Infinity;
  visited.add(word);
  const entry = words.get(word);
  const rank = Number(entry?.frq) || Number(entry?.bnc);
  if (rank) return rank;
  const base = entry?.exchange.match(/(?:^|\/)0:([^/]+)/)?.[1];
  return base ? Math.min(...base.split(',').map(value => wordRank(value, new Set(visited)))) : Infinity;
}
// 按结构挑选固定介词/连词及常见动词+小品词。它是源词典子集，不宣称完整习语库。
const particles = new Set('about across after ahead along apart around aside away back behind by down forth forward in into off on out over through together under up upon with without'.split(' '));
const connectors = /^(?:according to|ahead of|along with|apart from|as |at |because of|by |due to|except for|for |in |instead of|on |out of|owing to|rather than|regardless of|so |such as|thanks to|up to|with |without )/;
// 结构筛选不能覆盖所有阅读习语；补充高价值表达索引，释义仍只取源词典存在的原条目。
const readingExpressions = new Set([
  'take into account', 'take account of', 'take advantage of', 'take part in', 'take place',
  'give rise to', 'used to', 'be used to', 'be subject to', 'be likely to', 'be supposed to',
  'be able to', 'be aware of', 'be based on', 'be responsible for', 'be concerned with',
  'make sense', 'make sense of', 'make use of', 'keep in mind', 'have to', 'ought to',
]);
const entries = {};
for (const row of rows) {
  const phrase = row.word;
  if (!/^[a-z]+(?: [a-z]+){1,7}$/.test(phrase)) continue;
  const parts = phrase.split(' ');
  if (parts.some(word => wordRank(word) > 10000)) continue;
  const head = words.get(parts[0]);
  const rank = Number(head?.frq) || Number(head?.bnc) || Infinity;
  const phrasalVerb = parts.length <= 3 && rank <= 3000 && /(?:^|\\n)v(?:t|i|t\.\s*&\s*vi)?\./.test(head?.translation ?? '') && parts.slice(1).every(p => particles.has(p));
  if (!connectors.test(phrase) && !phrasalVerb && !readingExpressions.has(phrase)) continue;
  // 专业术语、姓名、仅网络抓取义以及长句式碎片不适合阅读辅助。
  const lines = row.translation.split('\\n').map(s => s.trim()).filter(s => s && !/^\[/.test(s));
  if (!lines.length || lines.some(s => /人名|地名|姓氏|男子名|女子名/.test(s))) continue;
  const definition = lines.join('；');
  if (!/[\u4e00-\u9fff]/.test(definition) || definition.length > 180) continue;
  entries[phrase] = definition;
}
const source = {
  name: 'ECDICT', commit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b', sha256,
  url: 'https://github.com/skywind3000/ECDICT', license: 'MIT',
  copyright: 'Copyright (c) 2017 Linwei (skywind3000)',
  scope: '固定介词/连词表达、常见动词短语及阅读习语索引子集；屈折词沿源词典原形取词频；原词典释义，非上下文翻译',
};
const out = option('--out', 'public/data');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'reading-phrases.json'), JSON.stringify({ source, entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'en'))) }) + '\n');
fs.writeFileSync(path.join(out, 'reading-phrases-LICENSE.txt'), `${source.copyright}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.\n`);
console.log(`提取 ${Object.keys(entries).length} 条 ECDICT 固定表达`);
