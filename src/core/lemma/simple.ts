import type { Lemmatizer } from './types';

/**
 * 占位实现：只做最基础的规则还原（复数 -s/-es/-ies、过去式 -ed、进行时 -ing、所有格 's）。
 * 会产生不存在的候选（如 “bus” -> “bu”），但匹配阶段只接受词书中存在的候选，所以无害。
 * 已被 DataLemmatizer（data-lemmatizer.ts）取代，createLemmatizer 不再返回它；仅保留给不依赖数据文件的单测使用。
 */
export class SimpleLemmatizer implements Lemmatizer {
  candidates(surface: string): string[] {
    const w = surface.toLowerCase().replace(/[’]/g, "'");
    const out = [w];
    const push = (c: string) => {
      if (c.length >= 2 && !out.includes(c)) out.push(c);
    };
    const base = w.endsWith("'s") ? w.slice(0, -2) : w;
    push(base);
    if (base.endsWith('ies')) push(base.slice(0, -3) + 'y');
    if (base.endsWith('es')) push(base.slice(0, -2));
    if (base.endsWith('s') && !base.endsWith('ss')) push(base.slice(0, -1));
    if (base.endsWith('ied')) push(base.slice(0, -3) + 'y');
    if (base.endsWith('ed')) {
      push(base.slice(0, -2));
      push(base.slice(0, -1));
    }
    if (base.endsWith('ing')) {
      push(base.slice(0, -3));
      push(base.slice(0, -3) + 'e');
    }
    return out;
  }
}
