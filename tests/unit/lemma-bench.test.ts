/**
 * 对标评测：本项目 DataLemmatizer vs wink-lemmatizer vs compromise（同一金标集）。
 *
 * 标杆库不进项目依赖，单独装在临时目录，运行方式：
 *   mkdir -p /tmp/lemma-bench && cd /tmp/lemma-bench && npm i wink-lemmatizer compromise
 *   # 可选：UD English-EWT 测试集（CC BY-SA 4.0，不入库），抽取为 “词形<TAB>原形<TAB>UPOS”
 *   LEMMA_BENCH_DIR=/tmp/lemma-bench [LEMMA_BENCH_OUT=结果.json] npx vitest run tests/unit/lemma-bench.test.ts
 * 未设置 LEMMA_BENCH_DIR 时整个文件跳过（常规 npm test 不依赖网络与外部包）。
 *
 * 指标口径变化：高频词（COCA 排名 ≤ 5000）只允许透明后缀派生后，原 deriv 中 38 个高频非透明后缀词（development、teacher、
 * national、realize …）改为 deriv-hf（金标为原词），这是有意的产品口径（docs/architecture.md「词形还原」），不是退化。
 * 与口径调整前对比时注意：按旧金标 deriv 83/84 → 45/84；按新金标 deriv 45/46、deriv-hf 38/38、ALL 412/413。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataLemmatizer, type LemmaDataFile } from '@/core/lemma/data-lemmatizer';
import { isDerivCategory, loadGold, packagedWords, pct, score, type GoldItem, type Predictor } from './lemma-eval';

const BENCH_DIR = process.env.LEMMA_BENCH_DIR;

describe.skipIf(!BENCH_DIR)('lemma 对标评测', () => {
  it('金标集 + UD EWT', () => {
    const req = createRequire(path.join(BENCH_DIR!, 'index.js'));
    const wink = req('wink-lemmatizer') as Record<'verb' | 'noun' | 'adjective', (w: string) => string>;
    const nlp = req('compromise') as (t: string) => { compute(k: string): void; text(k: string): string };

    const lem = new DataLemmatizer();
    lem.setData(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile);
    const words = packagedWords();
    const isWord = (w: string) => words.has(w);

    /** wink 需要词性：无词性时依次尝试 动词 -> 名词 -> 形容词，取第一个有变化的结果 */
    const winkAuto = (w: string) => {
      const x = w.toLowerCase();
      for (const f of [wink.verb, wink.noun, wink.adjective]) {
        const r = f(x);
        if (r !== x) return r;
      }
      return x;
    };
    const compromiseRoot = (w: string) => {
      const d = nlp(w);
      d.compute('root');
      return d.text('root').toLowerCase().trim() || w.toLowerCase();
    };

    const systems: Predictor[] = [
      {
        name: 'hnw DataLemmatizer',
        predict: (it) => (isDerivCategory(it.category) ? lem.root(it.word, isWord) : lem.lemma(it.word, isWord)),
        candidates: (it) => lem.candidates(it.word),
      },
      { name: 'wink-lemmatizer(自动词性)', predict: (it) => winkAuto(it.word) },
      { name: 'compromise root', predict: (it) => compromiseRoot(it.word) },
    ];
    const gold = loadGold();
    const results: Record<string, unknown> = {};
    const cats = ['ALL', 'ALL-无派生', 'verb', 'irr-verb', 'plural', 'irr-plural', 'degree', 'possessive', 'deriv', 'deriv-hf', 'keep'];
    const lines = [`| 系统 | ${cats.join(' | ')} |`, `|${' --- |'.repeat(cats.length + 1)}`];
    for (const s of systems) {
      const t0 = performance.now();
      const r = score(gold, s);
      const ms = performance.now() - t0;
      results[s.name] = { gold: r, ms };
      lines.push(`| ${s.name} | ${cats.map((c) => pct(r[c])).join(' | ')} |`);
    }
    console.log(`\n金标集（${gold.length} 词）\n${lines.join('\n')}`);
    for (const s of systems) {
      const r = (results[s.name] as { gold: Record<string, { errors: string[] }> }).gold;
      console.log(`${s.name} 错例: ${r.ALL!.errors.slice(0, 40).join(', ')}`);
    }

    // UD English-EWT：按词形聚合（同一词形不同词性可能有不同金标原形，任一即对）
    const ewtFile = path.join(BENCH_DIR!, 'ewt_pairs.tsv');
    if (fs.existsSync(ewtFile)) {
      const pairs = fs.readFileSync(ewtFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string, string]);
      const byForm = new Map<string, Set<string>>();
      for (const [f, l] of pairs) byForm.set(f, (byForm.get(f) ?? new Set()).add(l));
      const types: GoldItem[] = [...byForm].map(([word, ls]) => ({ word, gold: [...ls], category: 'ewt', forbidden: [] }));
      const changed = types.filter((t) => !t.gold.includes(t.word));
      const ewtLines = ['| 系统 | EWT 全部词形 | EWT 需还原的词形 |', '| --- | --- | --- |'];
      for (const s of systems) {
        // EWT 原形不含派生，统一用屈折原形口径
        const sys: Predictor = { name: s.name, predict: (it) => (s === systems[0] ? lem.lemma(it.word, isWord) : s.predict(it)) };
        const all = score(types, sys).ALL!;
        const ch = score(changed, sys).ALL!;
        results[`${s.name} EWT`] = { all, changed: { ...ch, errors: ch.errors.slice(0, 60) } };
        ewtLines.push(`| ${s.name} | ${pct(all)} | ${pct(ch)} |`);
      }
      // wink 使用金标词性（上限参考，其他系统都不使用词性）
      const posFn = (pos: string) => (pos === 'VERB' || pos === 'AUX' ? wink.verb : pos === 'NOUN' ? wink.noun : pos === 'ADJ' ? wink.adjective : (w: string) => w);
      const winkPos = pairs.filter(([f, l]) => posFn(pairs.find((p) => p[0] === f)![2])(f) === l).length;
      ewtLines.push(`| wink-lemmatizer(金标词性，按词形+词性对) | ${((winkPos / pairs.length) * 100).toFixed(1)}% (${winkPos}/${pairs.length}) | - |`);
      const ourPairs = pairs.filter(([f, l]) => lem.candidates(f).includes(l)).length;
      ewtLines.push(`| hnw 候选召回（金标原形在匹配候选中，按对） | ${((ourPairs / pairs.length) * 100).toFixed(1)}% (${ourPairs}/${pairs.length}) | - |`);
      console.log(`\nUD English-EWT test（${types.length} 个词形，其中需还原 ${changed.length} 个）\n${ewtLines.join('\n')}`);
      console.log(`hnw EWT 需还原错例: ${(results['hnw DataLemmatizer EWT'] as { changed: { errors: string[] } }).changed.errors.join(', ')}`);
    }
    if (process.env.LEMMA_BENCH_OUT) fs.writeFileSync(process.env.LEMMA_BENCH_OUT, JSON.stringify(results, null, 2));
    expect(Object.keys(results).length).toBeGreaterThan(0);
  });
});
