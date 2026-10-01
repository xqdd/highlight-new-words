import { fetchPackagedJson } from '../dict/packaged';
import { DataLemmatizer, type LemmaDataFile } from './data-lemmatizer';
import type { Lemmatizer } from './types';

export type { LemmaAnalysis, Lemmatizer } from './types';

/** 打包的词形还原数据路径（lemma 分片维护，scripts/lemma/build-lemma-data.mjs 生成） */
export const LEMMA_DATA_PATH = 'data/lemma/lemma.json';

/**
 * 词形还原器工厂：全项目通过它获取实例。
 * 返回数据驱动的 DataLemmatizer，调用方需 await init() 加载覆盖表（未加载时退化为规则还原）。
 */
export function createLemmatizer(): Lemmatizer {
  return new DataLemmatizer(() => fetchPackagedJson<LemmaDataFile>(LEMMA_DATA_PATH));
}
