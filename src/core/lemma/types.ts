/**
 * 词形还原（lemmatization）契约。
 *
 * candidates(surface) 返回页面单词可能对应的原形候选，按优先级排序：
 * - 第一个元素必须是 surface 的小写形式本身（保证“原词在词书中”时优先命中）
 * - 其后为还原出的原形，如 running -> ['running', 'run']、happily -> ['happily', 'happy']
 * - 结果去重，全部小写
 *
 * 实现可以依赖打包数据（不规则变化表等），在 init() 中异步加载；
 * init 完成前 candidates 也必须可用（可退化为规则实现）。
 */
export interface Lemmatizer {
  /** 可选的异步初始化（加载数据表），多次调用应幂等 */
  init?(): Promise<void>;
  candidates(surface: string): string[];
  /**
   * 可选：区分屈折与派生的还原结果，供卡片等展示“过去式 / 派生自 care”这类说明。
   * candidates = [小写原词, base, ...inflections, ...derivations]（去重）。
   */
  analyze?(surface: string): LemmaAnalysis;
}

/** 一个单词的还原结果 */
export interface LemmaAnalysis {
  /** 去掉所有格/缩写后的小写形式（children's -> children） */
  base: string;
  /** 屈折原形候选（went -> go、leaves -> leave, leaf），按可能性排序 */
  inflections: string[];
  /** 派生词根链（carelessly -> careless, care），排在屈折之后 */
  derivations: string[];
  /** 是否来自数据表（false 表示规则兜底，候选可能包含不存在的词） */
  fromTable: boolean;
}
