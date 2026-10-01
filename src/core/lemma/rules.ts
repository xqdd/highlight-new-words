/**
 * 词形还原的纯规则部分（无依赖、无 TS 专有语法）。
 *
 * 同一份代码被两处使用：
 * - 运行时 DataLemmatizer：数据表未收录的词（长尾词、拼写变体）走这里兜底；
 * - 构建脚本 scripts/lemma/build-lemma-data.mjs（Node 类型剥离直接 import 本文件）：
 *   对词汇表中每个词先跑这里的规则，结果与“真值”不一致的才写入数据表做覆盖。
 *   因此规则改动后必须重新生成 public/data/lemma/lemma.json，否则覆盖表与规则不同步。
 *
 * 规则会过度生成（如 used -> us），匹配阶段只接受出现在启用词书中的候选；
 * 词汇表内的词由覆盖表给出精确结果，规则的误生成只影响词汇表外的罕见词。
 */

/** 缩写后缀：isn't -> is、we've -> we（can't/won't 等特殊形式单独处理） */
const CONTRACTION_SUFFIXES = ["n't", "'re", "'ve", "'ll", "'m", "'d"];
// 用 Map 而不是普通对象：页面单词 constructor/toString/__proto__ 会命中 Object.prototype 上的属性
const SPECIAL_CONTRACTIONS: ReadonlyMap<string, string> = new Map([
  ["can't", 'can'],
  ["won't", 'will'],
  ["shan't", 'shall'],
  ["ain't", 'be'],
  ['cannot', 'can'],
]);

/**
 * 规范化页面单词：小写、统一撇号，去掉所有格（'s、s'）与缩写后缀。
 * 返回用于查表/规则的基础形式（可能与小写原词相同）。
 */
export function normalizeSurface(surface: string): string {
  let w = surface.toLowerCase().replace(/[’‘`]/g, "'");
  const special = SPECIAL_CONTRACTIONS.get(w);
  if (special) return special;
  if (w.endsWith("'s")) return w.slice(0, -2);
  // 复数所有格 students'（分词器通常不会带出结尾撇号，这里兼容直接调用）
  if (w.endsWith("s'")) return w.slice(0, -1);
  for (const suf of CONTRACTION_SUFFIXES) {
    if (w.endsWith(suf) && w.length > suf.length + 1) return w.slice(0, -suf.length);
  }
  return w;
}

const VOWELS = 'aeiou';

/** 结尾是双写辅音（stopp、bigg、runn）时返回去掉一个辅音的形式，否则 undefined */
function undouble(stem: string): string | undefined {
  const n = stem.length;
  if (n < 3) return undefined;
  const c = stem[n - 1]!;
  if (c === stem[n - 2] && !VOWELS.includes(c) && c !== 'l' && c !== 's' && c !== 'z' && c !== 'f') return stem.slice(0, -1);
  // travelled -> travel、cancelled -> cancel（英式双写 l）
  if (c === 'l' && stem[n - 2] === 'l' && n >= 5) return stem.slice(0, -1);
  return undefined;
}

/** 单音节（只有一个元音组）且以“辅音 + 单元音 + 辅音”结尾：hop、us、lik、writ —— 没双写说明原形带不发音的 e */
function isMonosyllableCvc(stem: string): boolean {
  return /(?:^|[^aeiou])[aeiou][^aeiouwxy]$/.test(stem) && (stem.match(/[aeiou]+/g)?.length ?? 0) === 1;
}

/**
 * 去掉 -ed/-ing/-er/-est 后的词干是否大概率需要补回 e（hoped -> hope、citing -> cite、humanizing -> humanize、
 * handled -> handle、argued -> argue），用于决定“补 e”与“不补 e”两个候选的先后。
 * 只影响词汇表外长尾词的首选；词汇表内的词由覆盖表保证正确。
 */
function prefersSilentE(stem: string): boolean {
  if (isMonosyllableCvc(stem)) return true;
  return /(?:e|[^c]c|v|u|[aeiou]z|dg|rg|[bcdfgkptz]l|[rnpl]s|[aeiou]s|[^aeiou]at|[ui]at|[^aeiou](?:ur|ir|id|ib|ud|ut|in|ar|iz|ag|ig|og|ug))$/.test(
    stem,
  );
}

/** 去后缀后的词干候选：双写还原优先，再按 prefersSilentE 决定 词干 / 词干+e 的顺序 */
function stemCandidates(stem: string): (string | undefined)[] {
  const doubled = undouble(stem);
  if (doubled) return [doubled, stem, stem + 'e'];
  return prefersSilentE(stem) ? [stem + 'e', stem] : [stem, stem + 'e'];
}

/**
 * 屈折还原规则：复数、三单、过去式/过去分词、进行时、比较级/最高级。
 * 返回候选原形（按常见程度排序，可能包含不存在的词），不含输入本身。
 */
export function inflectionRuleCandidates(w: string): string[] {
  const out: string[] = [];
  const push = (c: string | undefined) => {
    if (c && c.length >= 2 && c !== w && !out.includes(c)) out.push(c);
  };
  const n = w.length;
  if (n < 3) return out;

  // 复数 / 三单
  if (w.endsWith('s') && !w.endsWith('ss')) {
    if (w.endsWith('ies') && n > 4) push(w.slice(0, -3) + 'y');
    if (w.endsWith('ves') && n > 4) {
      push(w.slice(0, -3) + 'f');
      push(w.slice(0, -3) + 'fe');
    }
    if (/(?:ch|sh|x|z|ss|o)es$/.test(w)) push(w.slice(0, -2));
    push(w.slice(0, -1));
    if (w.endsWith('es')) push(w.slice(0, -2));
    if (w.endsWith('ies')) push(w.slice(0, -1));
  }
  // 不规则复数的规则部分：women -> woman、firemen -> fireman
  if (w.endsWith('men') && n > 4) push(w.slice(0, -3) + 'man');

  // 过去式 / 过去分词
  if (w.endsWith('ed') && n > 3) {
    const stem = w.slice(0, -2);
    if (w.endsWith('ied')) push(w.slice(0, -3) + 'y');
    if (stem.endsWith('ck')) push(stem.slice(0, -1)); // panicked -> panic
    // agreed / freed：词干以 e 结尾时只去 d
    if (stem.endsWith('e')) push(w.slice(0, -1));
    stemCandidates(stem).forEach(push); // stopped -> stop、loved -> love、walked -> walk
  }
  // 进行时
  if (w.endsWith('ing') && n > 4) {
    const stem = w.slice(0, -3);
    if (w.endsWith('ying')) push(w.slice(0, -4) + 'ie'); // lying -> lie
    if (stem.endsWith('ck')) push(stem.slice(0, -1));
    stemCandidates(stem).forEach(push);
  }
  // 比较级 / 最高级
  if (w.endsWith('er') && n > 3) {
    if (w.endsWith('ier')) push(w.slice(0, -3) + 'y');
    stemCandidates(w.slice(0, -2)).forEach(push); // bigger -> big、larger -> large
  }
  if (w.endsWith('est') && n > 4) {
    if (w.endsWith('iest')) push(w.slice(0, -4) + 'y');
    stemCandidates(w.slice(0, -3)).forEach(push);
  }
  return out;
}

/**
 * 派生后缀规则：[后缀, 替换, 运行时是否启用]。
 * - 构建期用全部规则生成候选，再用释义重叠等语义校验筛选写入数据表；
 * - 运行时（词汇表外的词）只启用精度高的少数规则，避免 business -> busy 这类误还原。
 * 顺序即候选优先级。
 */
export const DERIVATION_RULES: ReadonlyArray<readonly [string, string, boolean]> = [
  // 副词 -ly
  ['ically', 'ic', true],
  ['ically', 'ical', true],
  ['ally', 'al', true],
  ['ily', 'y', true],
  ['bly', 'ble', true],
  ['uly', 'ue', true],
  ['lly', 'll', true],
  ['ly', 'le', false],
  ['ly', '', true],
  // 名词 -ness / -ment / -ship / -hood / -dom
  ['iness', 'y', true],
  ['ness', '', true],
  ['ment', '', true],
  ['ument', 'ue', true],
  ['ship', '', false],
  ['hood', '', false],
  ['dom', '', false],
  // 形容词 -ful / -less / -ous / -ish / -y / -al / -ic / -ive / -able
  ['iful', 'y', true],
  ['ful', '', true],
  ['iless', 'y', true],
  ['less', '', true],
  ['ious', 'y', false],
  ['ous', '', false],
  ['ous', 'e', false],
  ['ish', '', false],
  ['ish', 'e', false],
  ['ial', 'y', false],
  ['ical', 'y', false],
  ['al', '', false],
  ['al', 'e', false],
  ['ic', 'y', false],
  ['ic', '', false],
  ['ative', '', false],
  ['ative', 'e', false],
  ['sive', 'd', false],
  ['sive', 'de', false],
  ['ive', '', false],
  ['ive', 'e', false],
  ['iable', 'y', false],
  ['able', '', false],
  ['able', 'e', false],
  ['ible', '', false],
  ['ible', 'e', false],
  ['y', '', false],
  ['y', 'e', false],
  ['en', '', false],
  // 施动者 -er / -or / -ist / -ee / -ant / -ent
  ['ier', 'y', false],
  ['er', '', false],
  ['er', 'e', false],
  ['or', '', false],
  ['or', 'e', false],
  ['ist', '', false],
  ['ist', 'e', false],
  ['ist', 'y', false],
  ['ism', '', false],
  ['ism', 'e', false],
  ['ee', '', false],
  ['ant', '', false],
  ['ant', 'e', false],
  ['ent', '', false],
  // 抽象名词 -ity / -ation / -ion / -ance / -ence / -ure / -th
  ['ability', 'able', false],
  ['ibility', 'ible', false],
  ['ility', 'le', false],
  ['icity', 'ic', false],
  ['ity', '', false],
  ['ity', 'e', false],
  ['ication', 'y', false],
  ['anation', 'ain', false],
  ['ation', '', false],
  ['ation', 'e', false],
  ['ition', '', false],
  ['ition', 'e', false],
  ['ssion', 't', false],
  ['sion', 'd', false],
  ['sion', 'de', false],
  ['ption', 'be', false],
  ['ion', '', false],
  ['ion', 'e', false],
  ['ance', '', false],
  ['ance', 'e', false],
  ['ence', '', false],
  ['ence', 'e', false],
  ['ency', 'ent', false],
  ['ence', 'ent', false],
  ['ancy', 'ant', false],
  ['ance', 'ant', false],
  ['ure', '', false],
  ['ure', 'e', false],
  ['th', '', false],
  // 动词 -ize / -ise / -ify / -en
  ['ize', '', false],
  ['ize', 'y', false],
  ['ise', '', false],
  ['ise', 'y', false],
  ['ify', '', false],
  ['ify', 'e', false],
  ['ify', 'y', false],
];

/** 派生词根的最小长度（太短的词根几乎都是误还原：only -> on、early -> ear） */
export const MIN_ROOT_LENGTH = 3;

/**
 * 按派生后缀规则生成一级词根候选（不含输入本身，可能包含不存在的词）。
 * @param all true 时使用全部规则（构建期），false 时只用运行时高精度规则
 */
export function derivationRuleCandidates(w: string, all: boolean): string[] {
  const out: string[] = [];
  for (const [suffix, replacement, runtime] of DERIVATION_RULES) {
    if (!all && !runtime) continue;
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    for (const root of [stem + replacement, replacement === '' ? undouble(stem) : undefined]) {
      if (root && root.length >= MIN_ROOT_LENGTH && root !== w && !out.includes(root)) out.push(root);
    }
  }
  return out;
}

/**
 * 纯规则候选（数据表未收录时使用）：先屈折，再对“原词 + 屈折候选”做最多两层运行时派生还原。
 * 例：carelessly -> 派生 careless、care；teachers -> 屈折 teacher。
 */
export function ruleCandidates(w: string): { inflections: string[]; derivations: string[] } {
  const inflections = inflectionRuleCandidates(w);
  const derivations: string[] = [];
  let frontier = [w, ...inflections];
  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const x of frontier) {
      for (const root of derivationRuleCandidates(x, false)) {
        if (root !== w && !inflections.includes(root) && !derivations.includes(root)) {
          derivations.push(root);
          next.push(root);
        }
      }
    }
    frontier = next;
  }
  return { inflections, derivations };
}
