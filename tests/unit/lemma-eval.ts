/**
 * 词形还原金标评测工具（lemma 分片单测与对标评测共用）。
 *
 * 金标见 tests/fixtures/lemma-gold.tsv。评分口径：
 * - 屈折类（verb/irr-verb/plural/irr-plural/degree/possessive）：预测的原形 ∈ 可接受原形
 * - deriv：预测的词根 ∈ 可接受词根（本项目额外统计“可接受词根出现在匹配候选中”）
 * - deriv-hf：高频独立词条，产品口径不做派生还原，预测的词根应为原词（同样走 root() 口径）
 * - keep：预测 ∈ 可接受（通常为原词）
 * - 任意类别：预测（本项目为全部匹配候选）中出现“禁止误还原”即判错
 */
import fs from 'node:fs';
import path from 'node:path';

export interface GoldItem {
  word: string;
  gold: string[];
  category: string;
  forbidden: string[];
}

export const GOLD_PATH = path.resolve(__dirname, '../fixtures/lemma-gold.tsv');

export function loadGold(file = GOLD_PATH): GoldItem[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [word = '', gold = '', category = '', forbidden = ''] = l.split('\t');
      return { word, gold: gold.split('|'), category, forbidden: forbidden ? forbidden.split('|') : [] };
    });
}

/** 一个被评测系统：给出预测原形，以及（可选）它会用于匹配的全部候选（用于禁止项检查） */
export interface Predictor {
  name: string;
  predict(item: GoldItem): string;
  candidates?(item: GoldItem): string[];
}

export interface CategoryScore {
  total: number;
  correct: number;
  errors: string[];
}

/** 派生类类别（deriv / deriv-hf）：评测时用 root() 而不是 lemma() 取预测 */
export const isDerivCategory = (category: string) => category === 'deriv' || category === 'deriv-hf';

export function score(items: GoldItem[], p: Predictor): Record<string, CategoryScore> {
  const out: Record<string, CategoryScore> = {};
  const add = (cat: string, ok: boolean, err: string) => {
    const s = (out[cat] ??= { total: 0, correct: 0, errors: [] });
    s.total++;
    if (ok) s.correct++;
    else s.errors.push(err);
  };
  for (const item of items) {
    const pred = p.predict(item).toLowerCase();
    const cands = p.candidates?.(item) ?? [pred];
    const bad = item.forbidden.filter((f) => cands.includes(f));
    const ok = item.gold.includes(pred) && bad.length === 0;
    const err = `${item.word}->${pred}${bad.length ? ` (误:${bad.join('/')})` : ''}`;
    add(item.category, ok, err);
    add('ALL', ok, err);
    // deriv-hf 也不计入：保持 ALL-无派生 只统计屈折与 keep，口径调整前后可直接对比
    if (!isDerivCategory(item.category)) add('ALL-无派生', ok, err);
  }
  return out;
}

export const pct = (s?: CategoryScore) => (s ? `${((s.correct / s.total) * 100).toFixed(1)}% (${s.correct}/${s.total})` : '-');

/**
 * 运行时“真实词”判定：扩展打包词典 data/dict/<分片>.json 的词条（data 分片维护，格式变化时只取顶层 JSON 对象的键）。
 * 只用于规则兜底候选的过滤；查表命中的词不依赖它。
 */
export function packagedWords(): Set<string> {
  const dir = path.resolve(__dirname, '../../public/data/dict');
  const words = new Set<string>();
  if (!fs.existsSync(dir)) return words;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || !fs.statSync(path.join(dir, f)).isFile()) continue;
    try {
      for (const w of Object.keys(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as object)) words.add(w);
    } catch {
      // 分片正在被 data 分片重写时可能是半成品，忽略
    }
  }
  return words;
}
