#!/usr/bin/env node
/**
 * 生成离线词形还原数据 public/data/lemma/lemma.json（lemma 分片）。
 *
 * 用法：node scripts/lemma/build-lemma-data.mjs <ecdict.csv> <lemma.en.txt> [输出文件=public/data/lemma/lemma.json] [--report]
 * 依赖 Node ≥ 22.18 / 24（原生类型剥离，直接 import src/core/lemma/rules.ts，保证构建期与运行时规则同一份代码）。
 *
 * 数据来源（均 MIT）：
 * - ECDICT ecdict.csv：exchange 字段（p 过去式 / d 过去分词 / i 现在分词 / 3 三单 / r 比较级 / t 最高级 / s 复数 / 0 原形）、
 *   词频（frq=COCA、bnc）、考试 tag、中英文释义（派生词的语义校验）
 * - ECDICT lemma.en.txt：BNC 词形表，补 exchange 缺失的屈折映射
 *
 * 思路（“规则 + 覆盖表”）：
 * 1. 词汇表 V = 有词频或考试标签的 ECDICT 词 ∪ 屈折表中出现的词；
 * 2. 真值 T(w) = 屈折原形（按词频排序）+ 派生词根链（后缀规则生成、语义校验通过，最多 3 层）；
 * 3. 运行时规则 R(w)（rules.ts#ruleCandidates）过滤到 V 后若与 T(w) 完全一致则不写表，否则写入覆盖。
 * 这样 V 内的词在运行时得到精确结果（匹配只发生在词书词上，而词书 ⊆ V），表只存规则处理不了的部分。
 *
 * 输出格式 LemmaDataFile：{ v: 1, e: { 词: "屈折1,屈折2|派生1,派生2" } }，空串表示“不做任何还原”（news、business）。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { derivationRuleCandidates, inflectionRuleCandidates, ruleCandidates } from '../../src/core/lemma/rules.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const REPORT = process.argv.includes('--report');
const [csvPath, lemmaEnPath, outFile = 'public/data/lemma/lemma.json'] = args;
if (!csvPath || !lemmaEnPath) {
  console.error('用法: node scripts/lemma/build-lemma-data.mjs <ecdict.csv> <lemma.en.txt> [out.json] [--report]');
  process.exit(1);
}

const ALPHA = /^[a-z]+$/;

/** 解析一行 CSV（支持双引号转义；ECDICT 中换行以字面量 \n 存储，一行一条） */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// 1. 读取 ECDICT
// ---------------------------------------------------------------------------
/** word -> { trans, def, rank, exch } */
const info = new Map();
/** 屈折真值：变形 -> Set(原形) */
const infl = new Map();
const addInfl = (form, lemma) => {
  if (form === lemma || !ALPHA.test(form) || !ALPHA.test(lemma)) return;
  let s = infl.get(form);
  if (!s) infl.set(form, (s = new Set()));
  s.add(lemma);
};
/** ECDICT exchange 中确认过的 (变形, 原形) 对，用于校验 lemma.en.txt */
const ecdictPairs = new Set();

const rl = readline.createInterface({ input: fs.createReadStream(csvPath, 'utf8'), crlfDelay: Infinity });
let header = true;
for await (const line of rl) {
  if (header) { header = false; continue; }
  const [word, , definition, translation, , , , tag, bnc, frq, exchange] = parseCsvLine(line);
  if (!word || !ALPHA.test(word)) continue; // 只要全小写纯字母词（专有名词首字母大写，排除）
  const rank = Number(frq) || Number(bnc) || 0;
  info.set(word, { trans: translation ?? '', def: definition ?? '', rank, tag: tag ?? '', exch: exchange ?? '' });
  for (const part of (exchange ?? '').split('/')) {
    const [k, v] = part.split(':');
    if (!v) continue;
    if (k === '0') { addInfl(word, v); ecdictPairs.add(`${word}>${v}`); }
    else if ('pdi3rts'.includes(k) && k.length === 1) { addInfl(v, word); ecdictPairs.add(`${v}>${word}`); }
  }
}

// ---------------------------------------------------------------------------
// 2. 读取 lemma.en.txt：只接受 ECDICT 确认过、或词形相近（共同前缀）的映射，
//    过滤 we -> our/us、will -> wo、can -> could 这类代词格/情态拆分噪声
// ---------------------------------------------------------------------------
const PRONOUN_BASES = new Set(['i', 'we', 'you', 'he', 'she', 'it', 'they', 'will', 'would', 'shall', 'can', 'do', 'be', 'have', 'not']);
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
for (const line of fs.readFileSync(lemmaEnPath, 'utf8').split('\n')) {
  if (!line || line.startsWith(';')) continue;
  const m = line.match(/^([^/\s]+)\/\d+\s*->\s*(.+)$/);
  if (!m) continue;
  const base = m[1].toLowerCase();
  if (!ALPHA.test(base)) continue;
  for (const raw of m[2].split(',')) {
    const form = raw.trim().toLowerCase();
    if (!ALPHA.test(form) || form === base) continue;
    const confirmed = ecdictPairs.has(`${form}>${base}`);
    const plausible = !PRONOUN_BASES.has(base) && commonPrefix(base, form) >= Math.min(3, base.length - 1);
    if (confirmed || plausible) addInfl(form, base);
  }
}

// 数据源遗漏的高频异干形式（be/have/do 的屈折被代词过滤挡掉，形容词异干比较级 ECDICT 未标）
const MANUAL_INFLECTIONS = {
  am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
  has: 'have', had: 'have', having: 'have', does: 'do', did: 'do', done: 'do', doing: 'do', gotten: 'get',
  more: 'many,much', most: 'many,much', less: 'little', least: 'little',
  elder: 'old', eldest: 'old', further: 'far', furthest: 'far', farther: 'far', farthest: 'far',
};
for (const [form, lemmas] of Object.entries(MANUAL_INFLECTIONS)) for (const l of lemmas.split(',')) addInfl(form, l);

// ---------------------------------------------------------------------------
// 3. 词汇表 V
// ---------------------------------------------------------------------------
// 核心词：有考试标签或词频排名在 CORE_RANK 以内（词书只会收录这类词；更罕见的词走运行时规则即可）
const CORE_RANK = 30000;
const V = new Set();
for (const [w, e] of info) if (e.tag || (e.rank > 0 && e.rank <= CORE_RANK)) V.add(w);
// 核心词的屈折变形也进入 V（went、leaves），否则覆盖表无法纠正它们
for (const [form, lemmas] of infl) if ([...lemmas].some((l) => V.has(l))) V.add(form);
/**
 * 比较规则输出时用的扩展词表：ECDICT 全部纯字母词（含 V 外的罕见词与缩写，如 specie、ceil、app、com）。
 * V 内单词的规则候选只要命中扩展词表且不是真值，就写覆盖表，避免用户词书收录罕见词时误匹配。
 */
const VX = new Set(V);
for (const w of info.keys()) VX.add(w);
/** 是否为某些变形的原形（found 既是 find 的过去式也是 founded 的原形） */
const isBase = new Set([...infl.values()].flatMap((s) => [...s]));
const rankOf = (w) => info.get(w)?.rank || 1e7;

/**
 * 屈折原形列表，按词频排序（leaves -> leave, leaf）。
 * 1. 表内映射：已词汇化为名词的常用 -ing 形式（首个义项为 n.）且与原形语义无关的丢弃（evening ↛ even）；
 *    其他变形即使有独立义项也保留（spoke 辐条 / speak 仍是 speak 的过去式）。
 * 2. 表内没有时用规则补齐（traveling -> travel，ECDICT 只收英式 travelling），只补 -s/-ed/-ing，
 *    不补 -er/-est（teacher、speaker 会被当成比较级）与名词化的 -ing（morning ↛ morn、earring ↛ ear），且要求严格语义证据（共享双字词或释义提到原形），避免 news -> new。
 */
const inflMemo = new Map();
const droppedInfl = [];
function inflOf(w) {
  let r = inflMemo.get(w);
  if (r) return r;
  const own = info.get(w)?.trans;
  // 只对常用词判定（ECDICT 给罕见 -ing 形式也配了零散名词释义：occurring 事件、ranging 距离修正）
  const nounIng = !!own && /ings?$/.test(w) && own.startsWith('n.') && rankOf(w) <= 10000;
  // 变形本身比原形还常用且语义无关时，多半是同形异义词：number ↛ numb、feed ↛ fee、species ↛ specie
  // 但 -ed/-ing 形容词（polished、thrilling）比原形常用很正常，只有它自己也有变形（feed -> fed）时才算同形异义
  const homograph = (l) =>
    !!own && !MANUAL_INFLECTIONS[w] && rankOf(w) < rankOf(l) && (isBase.has(w) || !/(?:ed|ing)$/.test(w));
  r = [...(infl.get(w) ?? [])].filter(
    (l) =>
      V.has(l) &&
      (!!MANUAL_INFLECTIONS[w] ||
        mentionsWord(own, l) ||
        // 名词化 -ing 只需弱证据（following 追随者 / follow）；同形常用词要求正常语义证据（feed 用餐 / fee 费用 只共享“用”）
        ((!nounIng || weaklyRelated(w, l)) && (!homograph(l) || semanticallyRelated(w, l, true)))),
  );
  if (infl.has(w) && r.length < infl.get(w).size) droppedInfl.push(`${w}>${[...infl.get(w)].filter((l) => !r.includes(l)).join('/')}`);
  if (r.length === 0 && !infl.has(w) && !nounIng && /(?:s|ed|ing)$/.test(w)) {
    r = inflectionRuleCandidates(w).filter(
      (c) => V.has(c) && (!infl.has(c) || isBase.has(c)) && (!own || semanticallyRelated(w, c, true)),
    );
    if (r.length) ruleInfl.push(`${w}>${r.join('/')}`);
  }
  r.sort((a, b) => rankOf(a) - rankOf(b));
  inflMemo.set(w, r);
  return r;
}
const ruleInfl = [];
/** 文本中是否作为英文单词出现（ECDICT 变形词条的中文释义常写“find的过去式”） */
const mentionsWord = (text, word) => !!text && new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text.replaceAll('\\n', ' '));

// ---------------------------------------------------------------------------
// 4. 派生词根：后缀规则候选 + 语义校验
// ---------------------------------------------------------------------------
/** 中文释义里不表达词义的字（词性/语法标记、派生常见字） */
const STOP_CHARS = new Set([...'成的地得了着者性化使之等一所为而于与及或被是有可其此某种做作者人物状态程度方式行为东西事情等']);
/**
 * 解析中文释义：去掉 [网络]/[计] 等学科行与括号内容，取前 3 个词性行，返回实义字（去 STOP_CHARS）组成的
 * - all：全部义项的二元组（bigram）；allChars：全部义项的单字
 * - head：每个词性行前两个义项（主义项）的单字
 */
function cjkProfile(trans) {
  const all = new Set();
  const head = new Set();
  const allChars = new Set();
  let lines = 0;
  for (const ln of trans.split('\\n')) {
    if (ln.startsWith('[') || lines >= 3) continue;
    lines++;
    const items = ln.replace(/^[a-z]+\.\s*/, '').replace(/[（(][^）)]*[）)]/g, '').split(/[,，;；、]/);
    items.forEach((item, idx) => {
      const chars = [...item].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
      for (const ch of chars) if (!STOP_CHARS.has(ch)) allChars.add(ch);
      for (let i = 0; i + 1 < chars.length; i++) {
        if (STOP_CHARS.has(chars[i]) || STOP_CHARS.has(chars[i + 1])) continue;
        all.add(chars[i] + chars[i + 1]);
      }
      if (idx < 2) for (const ch of chars) if (!STOP_CHARS.has(ch)) head.add(ch);
    });
  }
  return { all, head, allChars };
}
const profileMemo = new Map();
function profileOf(w) {
  let p = profileMemo.get(w);
  if (!p) profileMemo.set(w, (p = cjkProfile(info.get(w)?.trans ?? '')));
  return p;
}
/**
 * 英文释义是否提到词根或其屈折变形（teacher: "a person whose occupation is teaching"、writer: "able to write"）。
 * 只认词根本身或屈折表中指向词根的词，避免 writer 释义中的 written 被当成提到 writ。
 */
function defMentions(def, root) {
  for (const word of def.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (word === root || infl.get(word)?.has(root)) return true;
  }
  return false;
}
/**
 * 派生/屈折关系的语义证据（任一成立即可）：
 * 1. 派生词英文释义首行提到词根或其屈折变形（teacher: "a person whose occupation is teaching"）
 * 2. 两者义项共享一个双字词，且派生词的主义项与词根释义有共同字（happiness 快乐 / happy 快乐的）。
 *    第二个条件排除“只在次要义项上相关”：letter 出租人 / let 出租、shower 显示者 / show 显示
 * 3. 非 strict 时：两者主义项共享一个实义字（quickly 很快地 / quick 快的）
 */
function semanticallyRelated(w, root, strict = false) {
  const a = info.get(w);
  const b = info.get(root);
  if (!a || !b) return false;
  if (defMentions(a.def.split('\\n')[0], root)) return true;
  const pa = profileOf(w);
  const pb = profileOf(root);
  if ([...pa.head].some((ch) => pb.allChars.has(ch)) && [...pb.all].some((bg) => pa.all.has(bg))) return true;
  if (strict) return false;
  for (const ch of pb.head) if (pa.head.has(ch)) return true;
  return false;
}

/** 屈折关系只需弱证据：释义有任何共同实义字（following 追随者 / follow 追随）；evening 晚上 / even 甚至 没有 */
function weaklyRelated(w, lemma) {
  if (semanticallyRelated(w, lemma)) return true;
  const b = profileOf(lemma).allChars;
  for (const ch of profileOf(w).allChars) if (b.has(ch)) return true;
  return false;
}

/** 一级派生词根（已校验） */
const derivMemo = new Map();
const derivStats = new Map();
function derivOf(w) {
  let r = derivMemo.get(w);
  if (r) return r;
  r = [];
  // 屈折变形不直接派生（teachers 通过 teacher 再派生）
  if (!infl.has(w) || isBase.has(w)) {
    for (const root of derivationRuleCandidates(w, true)) {
      if (r.length >= 2) break;
      // 缩写不作词根：apply ↛ app、comment ↛ com
      if (!V.has(root) || (infl.has(root) && !isBase.has(root)) || info.get(root)?.trans.startsWith('abbr')) continue;
      if (semanticallyRelated(w, root)) {
        r.push(root);
        const suf = w.slice(commonPrefix(w, root));
        derivStats.set(suf, (derivStats.get(suf) ?? 0) + 1);
      }
    }
  }
  derivMemo.set(w, r);
  return r;
}

/** 真值：屈折原形 + 派生词根链（最多 3 层），不含 w 本身 */
function truthOf(w) {
  const inflections = inflOf(w);
  const derivs = [];
  let frontier = [w, ...inflections];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next = [];
    for (const x of frontier) {
      for (const root of derivOf(x)) {
        if (root !== w && !inflections.includes(root) && !derivs.includes(root)) { derivs.push(root); next.push(root); }
      }
    }
    frontier = next;
  }
  return { inflections, derivs };
}

// ---------------------------------------------------------------------------
// 5. 与运行时规则比较，生成覆盖表
// ---------------------------------------------------------------------------
const entries = {};
let same = 0;
for (const w of [...V].sort()) {
  const { inflections, derivs } = truthOf(w);
  const r = ruleCandidates(w);
  // 屈折与派生分别比较：运行时 lemma() 只取屈折候选（teacher 的规则候选 teach 来自 -er 比较级规则，归类不对也要写表）
  const eq = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
  if (eq(inflections, r.inflections.filter((c) => VX.has(c))) && eq(derivs, r.derivations.filter((c) => VX.has(c)))) { same++; continue; }
  entries[w] = derivs.length ? `${inflections.join(',')}|${derivs.join(',')}` : inflections.join(',');
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const json = JSON.stringify({ v: 1, e: entries });
fs.writeFileSync(outFile, json);
console.log(`V=${V.size} infl=${infl.size} 规则一致=${same} 覆盖=${Object.keys(entries).length} 输出=${outFile} ${(json.length / 1024).toFixed(0)}KB`);
if (REPORT) {
  const accepted = [...derivMemo].filter(([, r]) => r.length).map(([w, r]) => `${w}>${r.join('/')}`);
  const pick = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  console.log('派生样本:', pick(accepted, 80).join(' '));
  const rejected = [];
  for (const [w, r] of derivMemo) {
    if (r.length || rejected.length > 4000) continue;
    const cands = derivationRuleCandidates(w, true).filter((c) => V.has(c) && !infl.has(c));
    if (cands.length && (info.get(w)?.tag)) rejected.push(`${w}>${cands[0]}`);
  }
  console.log('拒绝样本:', pick(rejected, 80).join(' '));
  console.log(`屈折丢弃 ${droppedInfl.length}:`, pick(droppedInfl, 60).join(' '));
  console.log(`规则补屈折 ${ruleInfl.length}:`, pick(ruleInfl, 60).join(' '));
  console.log('派生后缀命中:', [...derivStats].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}:${v}`).join(' '));
  for (const w of process.env.WORDS?.split(',') ?? ['business', 'news', 'hardly', 'lately', 'happiness', 'quickly', 'teacher', 'writer', 'beautifully', 'carelessly',
    'development', 'decision', 'national', 'ability', 'better', 'went', 'leaves', 'used', 'data', 'children', 'corner', 'department',
    'apartment', 'witness', 'early', 'only', 'pressure', 'series', 'species', 'always', 'during', 'hopeful', 'thinking', 'building']) {
    console.log(w, '=>', JSON.stringify(entries[w] ?? `(rule) ${Object.values(ruleCandidates(w)).flat().filter((c) => V.has(c)).join(',')}`), 'truth', JSON.stringify(truthOf(w)));
  }
}
