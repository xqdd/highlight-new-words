/**
 * 卡片展示用的纯函数：词形关系说明、释义分行解析、音标规范化、外部词典链接。
 * 不依赖 DOM，便于单测；card-view 只负责把结果渲染出来。
 */
import type { DictEntry } from '@/core/dict/types';

/** 释义行：词性/领域标签 + 释义正文 */
export interface DefinitionLine {
  /** 词性（如 `vt.`）或领域标签（如 `[经]`），可能为空 */
  pos: string;
  text: string;
}

/**
 * 常见不规则变化：原形 -> [过去式, 过去分词] 或名词复数等。
 * 只用于给“页面词形与原形的关系”配说明文字，匹配本身由 Lemmatizer 负责；查不到时退化为通用说明。
 */
const IRREGULAR_VERBS: Record<string, [string, string]> = {
  arise: ['arose', 'arisen'], awake: ['awoke', 'awoken'], be: ['was were', 'been'], bear: ['bore', 'borne born'],
  beat: ['beat', 'beaten'], become: ['became', 'become'], begin: ['began', 'begun'], bend: ['bent', 'bent'],
  bind: ['bound', 'bound'], bite: ['bit', 'bitten'], bleed: ['bled', 'bled'], blow: ['blew', 'blown'],
  break: ['broke', 'broken'], breed: ['bred', 'bred'], bring: ['brought', 'brought'], build: ['built', 'built'],
  burst: ['burst', 'burst'], buy: ['bought', 'bought'], catch: ['caught', 'caught'], choose: ['chose', 'chosen'],
  cling: ['clung', 'clung'], come: ['came', 'come'], creep: ['crept', 'crept'], deal: ['dealt', 'dealt'],
  dig: ['dug', 'dug'], do: ['did', 'done'], draw: ['drew', 'drawn'], drink: ['drank', 'drunk'],
  drive: ['drove', 'driven'], eat: ['ate', 'eaten'], fall: ['fell', 'fallen'], feed: ['fed', 'fed'],
  feel: ['felt', 'felt'], fight: ['fought', 'fought'], find: ['found', 'found'], flee: ['fled', 'fled'],
  fly: ['flew', 'flown'], forbid: ['forbade', 'forbidden'], forget: ['forgot', 'forgotten'], forgive: ['forgave', 'forgiven'],
  freeze: ['froze', 'frozen'], get: ['got', 'got gotten'], give: ['gave', 'given'], go: ['went', 'gone'],
  grind: ['ground', 'ground'], grow: ['grew', 'grown'], hang: ['hung', 'hung'], have: ['had', 'had'],
  hear: ['heard', 'heard'], hide: ['hid', 'hidden'], hold: ['held', 'held'], keep: ['kept', 'kept'],
  kneel: ['knelt', 'knelt'], know: ['knew', 'known'], lay: ['laid', 'laid'], lead: ['led', 'led'],
  leave: ['left', 'left'], lend: ['lent', 'lent'], lie: ['lay', 'lain'], lose: ['lost', 'lost'],
  make: ['made', 'made'], mean: ['meant', 'meant'], meet: ['met', 'met'], overcome: ['overcame', 'overcome'],
  pay: ['paid', 'paid'], ride: ['rode', 'ridden'], ring: ['rang', 'rung'], rise: ['rose', 'risen'],
  run: ['ran', 'run'], say: ['said', 'said'], see: ['saw', 'seen'], seek: ['sought', 'sought'],
  sell: ['sold', 'sold'], send: ['sent', 'sent'], shake: ['shook', 'shaken'], shine: ['shone', 'shone'],
  shoot: ['shot', 'shot'], show: ['showed', 'shown'], shrink: ['shrank', 'shrunk'], sing: ['sang', 'sung'],
  sink: ['sank', 'sunk'], sit: ['sat', 'sat'], sleep: ['slept', 'slept'], slide: ['slid', 'slid'],
  speak: ['spoke', 'spoken'], spend: ['spent', 'spent'], spin: ['spun', 'spun'], spring: ['sprang', 'sprung'],
  stand: ['stood', 'stood'], steal: ['stole', 'stolen'], stick: ['stuck', 'stuck'], sting: ['stung', 'stung'],
  stride: ['strode', 'stridden'], strike: ['struck', 'struck'], strive: ['strove', 'striven'], swear: ['swore', 'sworn'],
  sweep: ['swept', 'swept'], swim: ['swam', 'swum'], swing: ['swung', 'swung'], take: ['took', 'taken'],
  teach: ['taught', 'taught'], tear: ['tore', 'torn'], tell: ['told', 'told'], think: ['thought', 'thought'],
  throw: ['threw', 'thrown'], tread: ['trod', 'trodden'], undergo: ['underwent', 'undergone'], understand: ['understood', 'understood'],
  undertake: ['undertook', 'undertaken'], wake: ['woke', 'woken'], wear: ['wore', 'worn'], weave: ['wove', 'woven'],
  weep: ['wept', 'wept'], win: ['won', 'won'], wind: ['wound', 'wound'], withdraw: ['withdrew', 'withdrawn'],
  write: ['wrote', 'written'],
};
const IRREGULAR_PLURALS: Record<string, string> = {
  man: 'men', woman: 'women', child: 'children', person: 'people', foot: 'feet', tooth: 'teeth', goose: 'geese',
  mouse: 'mice', ox: 'oxen', analysis: 'analyses', crisis: 'crises', thesis: 'theses', hypothesis: 'hypotheses',
  phenomenon: 'phenomena', criterion: 'criteria', datum: 'data', medium: 'media', bacterium: 'bacteria',
  curriculum: 'curricula', nucleus: 'nuclei', stimulus: 'stimuli', fungus: 'fungi', cactus: 'cacti',
  appendix: 'appendices', index: 'indices', matrix: 'matrices', vertex: 'vertices', leaf: 'leaves', life: 'lives',
  knife: 'knives', wife: 'wives', half: 'halves', wolf: 'wolves', shelf: 'shelves', thief: 'thieves',
};
const IRREGULAR_DEGREES: Record<string, [string, string]> = {
  good: ['better', 'best'], well: ['better', 'best'], bad: ['worse', 'worst'], ill: ['worse', 'worst'],
  far: ['farther further', 'farthest furthest'], little: ['less', 'least'], many: ['more', 'most'], much: ['more', 'most'],
};

const VOWELS = 'aeiou';

/** 规则变化的词干候选：原形 + 后缀可能的拼写（直接加、去 e、y->i、双写辅音） */
function regularForms(lemma: string, suffix: string): string[] {
  const out = [lemma + suffix];
  const last = lemma.slice(-1);
  if (last === 'e' && VOWELS.includes(suffix[0]!)) out.push(lemma.slice(0, -1) + suffix);
  if (last === 'y' && !VOWELS.includes(lemma.slice(-2, -1)) && suffix !== 'ing') out.push(lemma.slice(0, -1) + 'i' + suffix);
  if (lemma.endsWith('ie') && suffix === 'ing') out.push(lemma.slice(0, -2) + 'ying');
  // 双写末尾辅音（stop -> stopped），粗略规则，只用于配说明文字
  if (!VOWELS.includes(last) && VOWELS.includes(lemma.slice(-2, -1)) && VOWELS.includes(suffix[0]!)) out.push(lemma + last + suffix);
  // -c 结尾加 k（panic -> panicked）
  if (last === 'c' && VOWELS.includes(suffix[0]!)) out.push(lemma + 'k' + suffix);
  return out;
}

/**
 * 页面词形相对原形的关系说明，如 running/run -> “现在分词”；同形或无法判断返回 undefined/通用说明。
 * 结果只用于展示，判断失败不影响匹配。
 */
export function describeForm(surface: string, lemma: string): string | undefined {
  const s = surface.toLowerCase();
  const l = lemma.toLowerCase();
  if (s === l) return undefined;
  if (/[’']s$/.test(s) && s.slice(0, -2) === l) return '所有格';
  // 查表用 Object.hasOwn：lemma 来自页面/用户词书，constructor、toString 等会命中 Object.prototype 上的同名成员
  const verb = Object.hasOwn(IRREGULAR_VERBS, l) ? IRREGULAR_VERBS[l] : undefined;
  if (verb) {
    const [past, pp] = verb.map((v) => v.split(' ')) as [string[], string[]];
    const isPast = past.includes(s);
    const isPp = pp.includes(s);
    if (isPast && isPp) return '过去式，过去分词';
    if (isPast) return '过去式';
    if (isPp) return '过去分词';
  }
  if (Object.hasOwn(IRREGULAR_PLURALS, l) && IRREGULAR_PLURALS[l] === s) return '复数';
  const degree = Object.hasOwn(IRREGULAR_DEGREES, l) ? IRREGULAR_DEGREES[l] : undefined;
  if (degree?.[0].split(' ').includes(s)) return '比较级';
  if (degree?.[1].split(' ').includes(s)) return '最高级';
  if ([l + 's', l + 'es', ...(l.endsWith('y') && !VOWELS.includes(l.slice(-2, -1)) ? [l.slice(0, -1) + 'ies'] : [])].includes(s)) {
    return '复数，第三人称单数';
  }
  if (regularForms(l, 'ing').includes(s)) return '现在分词';
  if (regularForms(l, 'ed').includes(s) || (l.endsWith('e') && s === l + 'd')) return '过去式，过去分词';
  if (regularForms(l, 'er').includes(s) || (l.endsWith('e') && s === l + 'r')) return '比较级';
  if (regularForms(l, 'est').includes(s) || (l.endsWith('e') && s === l + 'st')) return '最高级';
  if (regularForms(l, 'ly').includes(s) || (l.endsWith('le') && s === l.slice(0, -1) + 'y')) return '副词';
  if (regularForms(l, 'ness').includes(s)) return '名词';
  return '变形';
}

/**
 * 解析词典完整释义为行：每行 `vt. 放弃, 抛弃` / `[经] 能力`；没有 full 时退化为 short 单行。
 * 去掉与 short 完全相同的重复行。
 */
export function parseDefinitions(short?: string, full?: string): DefinitionLine[] {
  const raw = (full || short || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const lines: DefinitionLine[] = [];
  for (const line of raw) {
    if (seen.has(line)) continue;
    seen.add(line);
    // 词性：a. / vt. / n. / adj. / prep. 等（可能多个连写，如 "vt.vi."）；领域：[经] [计]
    const m = /^((?:[a-z]{1,5}\.\s*)+|\[[^\]]{1,6}\])\s*(.*)$/i.exec(line);
    lines.push(m && m[2] ? { pos: m[1]!.trim(), text: m[2] } : { pos: '', text: line });
  }
  return lines;
}

/** 页面词形是原形的这些屈折变化时，词形本身可能是独立的常用形容词/名词（advanced、limited、interesting、running） */
const PARTICIPLE_FORMS = new Set(['过去式，过去分词', '过去分词', '过去式', '现在分词']);

/**
 * 页面词形自己的非动词义项（卡片在原形释义之前单独展示）。
 *
 * 匹配命中的是原形词条（advanced -> advance），原形释义只有动词/名词义，而页面上这个分词常作形容词用
 * （an advanced civilization = 先进的）；行内注解取的是页面词形自己的短释义，卡片也要给出同一义项才一致。
 * 只取词典中页面词形自己词条里的非动词行（动词行就是“advance的过去式”，原形释义已覆盖），
 * 只对过去式/过去分词/现在分词生效；词典里没有该词形词条（walked）时返回空数组。
 */
export function surfaceOwnSenses(surface: string, lemma: string, surfaceEntry: DictEntry | undefined): DefinitionLine[] {
  if (!surfaceEntry || surfaceEntry.word.toLowerCase() !== surface.toLowerCase()) return [];
  const form = describeForm(surface, lemma);
  if (!form || !PARTICIPLE_FORMS.has(form)) return [];
  // 词性可能连写（"vt.vi."），以 v/vt/vi 开头即视为动词行
  return parseDefinitions(surfaceEntry.short, surfaceEntry.full).filter((x) => x.pos && !/^v[ti]?\./i.test(x.pos));
}

/** 单个音标去掉两端的 [] 或 //，ECDICT 中的西里尔字母 ә 替换为 IPA ə */
function phoneticCore(p: string): string {
  return p.trim().replace(/^[[/]+|[\]/]+$/g, '').replace(/ә/g, 'ə').trim();
}

/** 音标里可能出现的少量 HTML 实体（欧路接口会转义撇号等） */
function decodeEntities(s: string): string {
  return s.replace(/&(#39|apos|quot|lt|gt|amp);/g, (_, e: string) => ({ '#39': "'", apos: "'", quot: '"', lt: '<', gt: '>', amp: '&' })[e]!);
}

/**
 * 音标规范化，统一输出 `/.../`。
 * 来源生词本的音标原样保存（见 background/sources/eudic.ts#toUserWord），欧路接口返回的是带真人发音链接的 HTML：
 * `<a ...><span class="phontype">英</span><span class="Phonitic">/x/</span></a><br/><a ...>美...</a>`，
 * 这里取出英/美音标纯文本：两者相同只显示一个，不同则显示 `英 /x/ 美 /y/`；认不出结构时退化为去掉标签。
 */
export function formatPhonetic(p?: string): string {
  if (!p) return '';
  if (!p.includes('<')) {
    const core = phoneticCore(p);
    return core ? `/${core}/` : '';
  }
  const parts = [...p.matchAll(/(?:class="phontype">([^<]*)<\/span>\s*)?<span class="Phonitic">([^<]*)</g)]
    .map((m) => ({ label: decodeEntities(m[1] ?? '').trim(), core: phoneticCore(decodeEntities(m[2]!)) }))
    .filter((x) => x.core);
  const cores = [...new Set(parts.map((x) => x.core))];
  if (cores.length > 1) return parts.map((x) => `${x.label} /${x.core}/`.trim()).join(' ');
  if (cores.length === 1) return `/${cores[0]}/`;
  const core = phoneticCore(decodeEntities(p.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' '));
  return core ? `/${core}/` : '';
}

export interface DictLink {
  id: string;
  name: string;
  url: string;
}

/** 外部词典链接（新标签页打开） */
export function dictLinks(word: string): DictLink[] {
  const w = encodeURIComponent(word);
  return [
    { id: 'youdao', name: '有道', url: `https://dict.youdao.com/result?word=${w}&lang=en` },
    { id: 'eudic', name: '欧路', url: `https://dict.eudic.net/dicts/en/${w}` },
    { id: 'cambridge', name: '剑桥', url: `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${w}` },
    { id: 'oxford', name: '牛津', url: `https://www.oxfordlearnersdictionaries.com/search/english/?q=${w}` },
    { id: 'mw', name: '韦氏', url: `https://www.merriam-webster.com/dictionary/${w}` },
  ];
}
