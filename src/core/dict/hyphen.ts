/**
 * 连字符复合词的前半部分（构词前缀）。
 *
 * 页面分词按连字符切开复合词（auto-generated → auto, generated；micro-service → micro, service），
 * 切出的前缀单独查词会得到与复合词无关的释义（auto → 汽车、micro → 微型计算机、vice → 恶习）。
 * 内置词书已去掉纯前缀（re/non/mid/micro…，见 scripts/data/build-data.mjs 的 NOT_WORDS），
 * 这里列出**本身也是独立单词**、只在“后接连字符”时才是前缀的词，供 engine 在 `词-词` 结构中跳过前半部分。
 */
const HYPHEN_PREFIXES: ReadonlySet<string> = new Set([
  'auto', 'vice', 'self', 'post', 'cross', 'counter', 'over', 'under', 'out', 'well', 'ill', 'half', 'full', 'all',
  'cyber', 'tele', 'trans', 'super', 'hyper', 'inter', 'intra', 'extra', 'pro', 'sub', 'mid', 'non', 'anti', 'semi',
  'multi', 'micro', 'macro', 'mini', 'mega', 'co', 're', 'pre', 'de', 'ex', 'bio', 'eco', 'neo', 'geo', 'socio', 'quasi',
  'pseudo', 'ultra', 'infra', 'mono', 'poly', 'uni', 'bi', 'tri', 'dual', 'twin', 'fore', 'after', 'by', 'step',
]);

/** 是否为连字符复合词前缀（大小写不敏感）。engine 在 token 后紧跟 `-字母` 时调用，命中则不高亮该 token */
export function isHyphenPrefix(word: string): boolean {
  return HYPHEN_PREFIXES.has(word.toLowerCase());
}
