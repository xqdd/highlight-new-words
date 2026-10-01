#!/usr/bin/env node
/**
 * 内置词书与词典数据构建脚本（可复现：输入固定 commit 的原始数据，输出确定性排序的 JSON）。
 *
 * 用法：
 *   scripts/data/fetch-raw.sh .cache/data-raw [--with-ultimate]
 *   node scripts/data/build-data.mjs --raw .cache/data-raw [--out public/data] [--report report.json] [--audit audit.tsv]
 *     --audit 输出短释义审计表（可疑选义打标，供人工复核后补进 short-overrides.tsv，见 auditFlags）
 *
 * 输入（--raw 目录）：
 *   ecdict.csv                         ECDICT（MIT）：音标/释义/考试标签/COCA(frq)/BNC 排名/词形变化(exchange)
 *   lemma.en.txt                       ECDICT 附带 BNC 词形表（MIT）：补充屈折词形 -> 原形
 *   cefrj/cefrj-vocabulary-profile-1.5.csv  CEFR-J Wordlist 1.5（免费商用，需署名）：A1–B2 分级
 *   kyle/7 SAT-乱序.txt、kyle/tsv_专四.txt、kyle/tsv_专八.txt  KyleBing/english-vocabulary（BSD-3）：只取词表
 *   ultimate/ultimate.csv              可选（仓库产物带它生成），ECDICT-ultimate（MIT）：pos 词性占比与更规整的释义行（短释义打分、完整释义 f）
 *   short-overrides.tsv（脚本同目录）   行内短释义人工覆盖表
 *   verb-overrides.tsv（脚本同目录）    动词短释义 v 人工覆盖/置空表（格式约束与解析见 verb-short.mjs）
 *
 * 输出（--out 目录，默认 public/data，结构见 src/core/wordbook/types.ts、src/core/dict/types.ts）：
 *   books/index.json        BookCatalog：词书目录（词数/描述/分类/级别/增量关系）
 *   books/<id>.json         BookDataFile：小写原形，已排序
 *   dict/<a-z>.json         DictShardFile 短表：p 音标、s 行内短释义、v 动词短释义（可选）、g 考试标签、l 级别、r 词频排名（高亮/行内翻译热路径）
 *   dict/full/<a-z>.json    DictShardFile 全表：f 完整释义、x 词形变化（卡片展开时才加载）
 *   NOTICE.txt              数据来源与许可声明
 *
 * 词书体系（详见 docs/architecture.md「4.2 词书与词典」）：
 *   - 级别（level，包含体系）：CEFR A2–C2，选某级 = 高亮该级及以上；A1–B2 取 CEFR-J，C1/C2 由考试标签 + 词频推导
 *   - 考试（exam）：中考/高考/四级/六级/考研/雅思/托福/GRE/SAT/专四/专八，按书去掉“基础词”（低于该考试起点的 CEFR 级别）
 *   - 增量（exam + delta）：如“六级新增”= 六级 − 四级 − 高考 − 中考
 *   - 词频（frequency）：COCA 前 N 之外
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { isCleanVerbShort, parseVerbOverrides } from './verb-short.mjs';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const RAW = arg('--raw', '.cache/data-raw');
const OUT = arg('--out', 'public/data');
const REPORT = arg('--report');
const AUDIT = arg('--audit');
if (!fs.existsSync(path.join(RAW, 'ecdict.csv'))) {
  console.error(`缺少 ${RAW}/ecdict.csv，先运行 scripts/data/fetch-raw.sh ${RAW}`);
  process.exit(1);
}

/** 只有纯字母才视为可高亮单词；短语、连字符词、缩写不进词书 */
const WORD_RE = /^[a-z]+$/;
/**
 * 不进任何词书的“伪单词”：
 * - 连字符前缀：页面分词按连字符切开（re-run、non-profit、mid-century、co-founder），切出的前缀单独高亮只会误标
 * - 缩写/单位/罗马数字：vs、etc、km、ph、iii…（多数已被 isBncOnly 挡住，这里兜底有 COCA 排名的）
 * - 常见人名同形词：lee、tony（ECDICT 小写词条有“保护”“时髦的”等冷僻义，页面上几乎总是人名）
 */
const NOT_WORDS = new Set([
  're', 'non', 'de', 'co', 'mid', 'pre', 'anti', 'semi', 'multi', 'inter', 'eco', 'bio', 'sub', 'ex', 'neo', 'para', 'pseudo', 'quasi', 'ultra',
  'micro', 'macro', 'mini', 'mega', 'anglo', 'amino', 'turbo', 'alpha', 'beta', 'gamma', 'fore',
  'vs', 'etc', 'ie', 'eg', 'km', 'kg', 'ft', 'lb', 'mm', 'cm', 'ph', 'bp', 'cv', 'hiv', 'pc', 'tv', 'cd', 'dvd', 'vcd', 'ok', 'id',
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii', 'xiv', 'xv',
  'lee', 'tony',
]);
/** 词典收录的词频上限（COCA/BNC 排名）：超出且无考试标签/CEFR 级别的生僻词不收 */
const DICT_RANK_MAX = 30000;
/** 级别/词频词书的总词表（inventory）词频上限 */
const INVENTORY_RANK_MAX = 20000;
/** 中文字符（判断释义/义项是否含中文） */
const CJK_RE = /[\u4e00-\u9fff]/;
/** 行内短释义最大字数 */
const SHORT_MAX = 8;
/** 完整释义最多保留的行数（每行一个词性） */
const FULL_MAX_LINES = 5;

// CEFR 级别数值：1..6 = A1..C2
const CEFR_NAMES = ['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// ---------------------------------------------------------------------------
// 1. 读取 ECDICT
// ---------------------------------------------------------------------------
/** RFC4180 CSV 解析（ECDICT 字段内换行以字面量 "\n" 存储，一条记录一行） */
function parseCsv(text, onRow) {
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      onRow(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); onRow(row); }
}

/** ECDICT 音标混用了西里尔字母 ә/є，统一成 IPA ə/ɛ */
function normalizePhonetic(p) {
  return (p || '').replace(/ә/g, 'ə').replace(/є/g, 'ɛ').trim();
}

/** 释义拆行，去掉 [网络] 行与“n. (Kind)人名”行 */
function translationLines(t) {
  return (t || '').split('\\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('[网络]') && !/^n\. \([A-Z][^)]*\)人名/.test(s));
}

/** 释义全是人名/地名（ECDICT 中小写的人名词条，如 margaret） */
function isNameOnly(lines) {
  return lines.length > 0 && lines.every((l) => /人名|女子名|男子名|姓氏|地名|^n\. \(/.test(l));
}

console.time('ecdict');
/** @type {Map<string, {word:string, phonetic:string, lines:string[], tags:string[], bnc:number, frq:number, exchange:string}>} */
const ecdict = new Map();
{
  let header = true;
  parseCsv(fs.readFileSync(path.join(RAW, 'ecdict.csv'), 'utf8'), (r) => {
    if (header) { header = false; return; }
    const [word, phonetic, , translation, , , , tag, bnc, frq, exchange] = r;
    if (!word) return;
    const key = word.toLowerCase();
    if (!WORD_RE.test(key)) return;
    const tags = tag ? tag.split(' ').filter(Boolean) : [];
    const entry = {
      word,
      phonetic: normalizePhonetic(phonetic),
      lines: translationLines(translation),
      tags,
      bnc: Number(bnc) || 0,
      frq: Number(frq) || 0,
      exchange: exchange || '',
    };
    const prev = ecdict.get(key);
    // 大小写重复（China/china）：优先有考试标签的，其次全小写的
    if (!prev || (!prev.tags.length && tags.length) || (prev.tags.length === tags.length && word === key && prev.word !== key)) {
      ecdict.set(key, entry);
    }
  });
}
console.timeEnd('ecdict');

/** 词频排名：COCA 优先，缺失时用 BNC；都没有为 Infinity */
function rankOf(w) {
  const e = ecdict.get(w);
  return (e && (e.frq || e.bnc)) || Infinity;
}
/** 首字母大写的 ECDICT 词条是专有名词（Bingley）；小写但释义只有人名的也算 */
function isProperNoun(w) {
  const e = ecdict.get(w);
  return !e || e.word[0] !== w[0] || isNameOnly(e.lines);
}

// ---------------------------------------------------------------------------
// 2. 屈折词形 -> 原形（ECDICT exchange + lemma.en.txt）
//    exchange：p 过去式 d 过去分词 i 现在分词 3 三单 r 比较级 t 最高级 s 复数；0:原形 1:变形类型
// ---------------------------------------------------------------------------
const INFLECT_TYPES = new Set(['p', 'd', 'i', '3', 'r', 't', 's']);
/** @type {Map<string, string>} form -> lemma */
const lemmaOf = new Map();
function addLemma(form, lemma) {
  if (!WORD_RE.test(form) || !WORD_RE.test(lemma) || form === lemma || !ecdict.has(lemma)) return;
  const prev = lemmaOf.get(form);
  // 一个词形多个原形（leaves -> leave/leaf）：取词频高的原形
  if (!prev || rankOf(lemma) < rankOf(prev)) lemmaOf.set(form, lemma);
}
for (const [key, e] of ecdict) {
  for (const part of e.exchange.split('/')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const type = part.slice(0, idx);
    const val = part.slice(idx + 1).toLowerCase();
    if (INFLECT_TYPES.has(type)) for (const f of val.split(',')) addLemma(f.trim(), key);
    else if (type === '0') addLemma(key, val);
  }
}
for (const line of fs.readFileSync(path.join(RAW, 'lemma.en.txt'), 'utf8').split('\n')) {
  if (!line || line.startsWith(';')) continue;
  const m = line.match(/^([^/]+)\/\d+\s*->\s*(.*)$/);
  if (!m) continue;
  const lemma = m[1].trim().toLowerCase();
  for (const f of m[2].split(',')) {
    const form = f.trim().toLowerCase();
    if (!lemmaOf.has(form)) addLemma(form, lemma);
  }
}

// ---------------------------------------------------------------------------
// 3. CEFR-J 分级（A1–B2）；同一词多个词性取最低级别，并记录该级别的词性用于短释义排序
// ---------------------------------------------------------------------------
/** @type {Map<string, {level:number, pos:Set<string>}>} */
const cefr = new Map();
{
  const LV = { A1: 1, A2: 2, B1: 3, B2: 4 };
  const lines = fs.readFileSync(path.join(RAW, 'cefrj', 'cefrj-vocabulary-profile-1.5.csv'), 'utf8').split('\n').slice(1);
  for (const line of lines) {
    const [hw, pos, lv] = line.split(',');
    const level = LV[lv?.trim()];
    if (!hw || !level) continue;
    // 表头词形如 "a.m./A.M./am/AM"、"colour/color"
    for (const v of hw.split('/')) {
      const k = v.trim().toLowerCase();
      if (!WORD_RE.test(k)) continue;
      const prev = cefr.get(k);
      if (!prev || level < prev.level) cefr.set(k, { level, pos: new Set([pos]) });
      else if (level === prev.level) prev.pos.add(pos);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 词形归一：词书中的变形词（ECDICT ielts 标签含 cities/levels）归到原形；
//    CEFR-J 单独收录的形容词化词形（abandoned、growing）保留自身
// ---------------------------------------------------------------------------
function normalizeWord(w) {
  if (cefr.has(w)) return w;
  const l = lemmaOf.get(w);
  return l && ecdict.has(l) ? l : w;
}

// ---------------------------------------------------------------------------
// 5. 考试词书原始集合（归一后）
// ---------------------------------------------------------------------------
/** ECDICT tag -> 词书 id */
const ECDICT_TAGS = { zk: 'zk', gk: 'gk', cet4: 'cet4', cet6: 'cet6', ky: 'kaoyan', ielts: 'ielts', toefl: 'toefl', gre: 'gre' };
/** KyleBing 词表文件（只取单词，不用其释义：数据出处未声明） */
const KYLE_FILES = { sat: '7 SAT-乱序.txt', tem4: 'tsv_专四.txt', tem8: 'tsv_专八.txt' };

/** @type {Map<string, Set<string>>} 考试 id -> 归一后的词集合（未去基础词） */
const examRaw = new Map();
function addExam(id, w) {
  if (!WORD_RE.test(w) || !ecdict.has(w)) return;
  const n = normalizeWord(w);
  // 词表中的叹词/缩写/无中文释义/专有名词（ah、hallo、rve）不进词书
  if (!cefr.has(n) && !isLemmaCandidate(n)) return;
  if (!examRaw.has(id)) examRaw.set(id, new Set());
  examRaw.get(id).add(n);
}
for (const [key, e] of ecdict) for (const t of e.tags) if (ECDICT_TAGS[t]) addExam(ECDICT_TAGS[t], key);
for (const [id, file] of Object.entries(KYLE_FILES)) {
  const p = path.join(RAW, 'kyle', file);
  if (!fs.existsSync(p)) { console.warn('跳过（缺文件）', p); continue; }
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const w = line.split('\t')[0]?.trim().toLowerCase();
    if (w) addExam(id, w);
  }
}
/** word -> 所属考试 id 列表（词典 g 字段，卡片显示考试徽标） */
const examTagsOf = new Map();
for (const [id, set] of examRaw) for (const w of set) examTagsOf.set(w, [...(examTagsOf.get(w) ?? []), id]);

// ---------------------------------------------------------------------------
// 6. 总词表（inventory）与级别
//    inventory = CEFR-J ∪ 考试词 ∪ COCA/BNC 前 INVENTORY_RANK_MAX 的原形词（排除专有名词、变形词、叹词、无中文释义）
//    级别：CEFR-J 词用其级别；其余按词频：前 1500 视为 B1（新闻高频词，如 congress），
//          前 8000 或带中考~雅思标签为 C1，否则 C2
// ---------------------------------------------------------------------------
/** 可作为原形收录的词：非专有名词、非变形词、有中文释义、不是叹词/缩写 */
function isLemmaCandidate(w) {
  const e = ecdict.get(w);
  if (!e || w.length < 2 || NOT_WORDS.has(w) || isProperNoun(w)) return false;
  if (lemmaOf.has(w) && !cefr.has(w)) return false;
  if (!e.lines.some((l) => CJK_RE.test(l))) return false;
  // 叹词（oh/wow/huh）与缩写（vs/etc）不做生词
  if (e.lines.every((l) => /^(int|interj|abbr)\./.test(l) || /缩写/.test(l))) return false;
  return true;
}
const BASIC_EXAMS = new Set(['zk', 'gk', 'cet4', 'cet6', 'kaoyan', 'ielts', 'toefl']);
/** @type {Map<string, number>} word -> 级别 1..6 */
const levelOf = new Map();
for (const [w, c] of cefr) if (ecdict.has(w) && !isProperNoun(w)) levelOf.set(w, c.level);
// 面向中文学习者校准：中考词至多 A2（选 B1 及以上不再高亮 energy 这类初中课本词）。
// 实测（对照 Relingo B2 在同一文章上的判定）：高考词/高频词再降级会漏掉 barrier、community、federal 等 Relingo 会标的词，故不做
for (const [w, l] of levelOf) if (l > 2 && examTagsOf.get(w)?.includes('zk')) levelOf.set(w, 2);
const extraWords = new Set([...examTagsOf.keys()]);
/**
 * 只有 BNC 排名、没有 COCA 排名（frq=0）的词多是人名/地名/缩写（chelsea、oliver、marx、hong、kong、km、vs）：
 * COCA 词频表按词元统计、不收专有名词，BNC 排名却按字形统计。这类词不按词频进入级别/词频词书（考试词与 CEFR-J 词不受影响）
 */
const isBncOnly = (w) => !cefr.has(w) && !ecdict.get(w).frq && !americanSpellings(w).some((a) => ecdict.get(a)?.frq);
/** 英式拼写对应的美式拼写候选（emphasise → emphasize、watercolour → watercolor、foetal → fetal），英式词在 COCA 中没有排名 */
function americanSpellings(w) {
  return [
    w.replace(/is(e|es|ed|ing|er|ers|ation|ations)$/, 'iz$1'),
    w.replace(/isation$/, 'ization'),
    w.replace(/our/, 'or'),
    w.replace(/tre$/, 'ter'),
    w.replace(/ence$/, 'ense'),
    w.replace(/oe/, 'e').replace(/ae/, 'e'),
    w.replace(/ll(ed|ing|er|ist)$/, 'l$1'),
    w.replace(/logue$/, 'log'),
    w.replace(/yse$/, 'yze'),
  ].filter((a) => a !== w);
}
const bncOnlyDropped = [];
for (const [w] of ecdict) {
  if (rankOf(w) > INVENTORY_RANK_MAX || !isLemmaCandidate(w)) continue;
  if (isBncOnly(w) && !examTagsOf.has(w)) { bncOnlyDropped.push(w); continue; }
  extraWords.add(w);
}
if (process.env.DEBUG_DROPPED) console.log('bnc-only dropped', bncOnlyDropped.length, bncOnlyDropped.join(' '));
for (const w of extraWords) {
  if (levelOf.has(w) || !isLemmaCandidate(w)) continue;
  const r = rankOf(w);
  const tags = examTagsOf.get(w) ?? [];
  if (tags.includes('zk')) levelOf.set(w, 2);
  else if (r <= 1500) levelOf.set(w, 3);
  else if (r <= 8000 || tags.some((t) => BASIC_EXAMS.has(t))) levelOf.set(w, 5);
  else levelOf.set(w, 6);
}

// ---------------------------------------------------------------------------
// 7. 词书定义
// ---------------------------------------------------------------------------
const SRC_ECDICT = 'ECDICT (MIT)';
const SRC_CEFRJ = 'CEFR-J Wordlist 1.5 + ECDICT 词频';
const SRC_KYLE = 'KyleBing/english-vocabulary (BSD-3) 词表';
/** below(level)：CEFR 级别低于 level 的词（基础词） */
const isBelow = (w, level) => (levelOf.get(w) ?? 7) < level;
const catalog = [];
const bookWords = new Map();
/** 嵌套词书（级别、词频是包含关系）：数据文件只存本书比 extendsId 多出的词，加载时由 registry 合并，体积减少约 70% */
const bookExtends = new Map();
/**
 * 词汇化的屈折形式与同形异义词：页面上多为独立义，即使原形更常见也保留
 * （goods 货物、customs 海关、shorts 短裤、stranger 陌生人 ≠ 更奇怪、wound 伤口 ≠ wind 的过去式）。
 * 原形比自身罕见的（media、data）或没有原形的（statistics、headquarters）不需要列在这里
 */
const LEXICALIZED_FORMS = new Set(['goods', 'customs', 'shorts', 'tights', 'stranger', 'wound']);
/**
 * 高频词的屈折形式（found←find、means←mean、times←time、known←know）：CEFR-J/考试词表把它们当独立词条收录，
 * 但页面上多数只是原形的屈折用法，单独高亮会按罕见义误译（found=创立、times=乘以）。
 * 规则：原形比它更常见（COCA 排名更靠前）时，只有原形也在同一本书里才收录它——原形低于本书起点（级别书/考试书）
 * 或在词频书阈值内，就视为“已会”，不单独高亮。包含关系（B2 ⊇ C1、5k ⊇ 8k）在过滤后仍成立：
 * 原形不在大书里，必然也不在小书里
 */
function isCommonInflectionOutside(w, bookSet) {
  const base = lemmaOf.get(w);
  if (!base || LEXICALIZED_FORMS.has(w) || bookSet.has(base)) return false;
  return rankOf(base) < rankOf(w);
}
/** 每本书去掉的屈折形式（--report 输出，便于复核） */
const droppedInflections = new Map();
function addBook(meta, words, extendsId) {
  const candidates = [...new Set(words)].filter((w) => WORD_RE.test(w) && !NOT_WORDS.has(w));
  const candidateSet = new Set(candidates);
  const dropped = candidates.filter((w) => isCommonInflectionOutside(w, candidateSet));
  const droppedSet = new Set(dropped);
  const list = candidates.filter((w) => !droppedSet.has(w)).sort();
  droppedInflections.set(meta.id, dropped.sort());
  bookWords.set(meta.id, list);
  if (extendsId) {
    const parent = new Set(bookWords.get(extendsId));
    if (!parent.size || list.filter((w) => parent.has(w)).length !== parent.size) throw new Error(`${meta.id} 不包含 ${extendsId}`);
    bookExtends.set(meta.id, extendsId);
  }
  catalog.push({ ...meta, size: list.length });
}

// 7.1 级别（包含体系）：选 B2 = B2 + C1 + C2；低于所选级别的词视为已会
const LEVEL_BOOKS = [
  { lv: 2, name: 'A2 初级', desc: '已掌握 A1 入门词，能应对熟悉话题的简单交流' },
  { lv: 3, name: 'B1 中级', desc: '已掌握 A1–A2，能理解熟悉主题的要点（约初中毕业）' },
  { lv: 4, name: 'B2 中高级', desc: '已掌握 A1–B1，能就多种话题流利交流（约高考/四级）' },
  { lv: 5, name: 'C1 高级', desc: '已掌握 A1–B2，能读懂复杂长文（约六级/考研）' },
  { lv: 6, name: 'C2 精通', desc: '已掌握 C1 及以下，只标出低频、专业或文学词（约 GRE）' },
];
for (const b of [...LEVEL_BOOKS].reverse()) {
  const name = CEFR_NAMES[b.lv];
  const harder = CEFR_NAMES[b.lv + 1];
  addBook({
    id: `cefr-${name.toLowerCase()}`, name: b.name, nameEn: `CEFR ${name}+`, short: `${name}+`, category: 'level', level: b.lv,
    source: SRC_CEFRJ,
    description: `高亮 ${name} 及以上的词。${b.desc}`,
  }, [...levelOf].filter(([, l]) => l >= b.lv).map(([w]) => w), harder ? `cefr-${harder.toLowerCase()}` : undefined);
}

// 7.2 考试（去基础词）：base = 该考试默认已会的 CEFR 级别上限（低于 base+1 的词去掉）
const EXAM_BOOKS = [
  { id: 'zk', name: '中考', nameEn: 'Zhongkao', short: '中考', level: 1, base: 0, src: SRC_ECDICT },
  { id: 'gk', name: '高考', nameEn: 'Gaokao', short: '高考', level: 2, base: 1, src: SRC_ECDICT },
  { id: 'cet4', name: '大学英语四级', nameEn: 'CET-4', short: '四级', level: 3, base: 2, src: SRC_ECDICT },
  { id: 'cet6', name: '大学英语六级', nameEn: 'CET-6', short: '六级', level: 4, base: 3, src: SRC_ECDICT },
  { id: 'kaoyan', name: '考研', nameEn: 'Postgraduate Exam', short: '考研', level: 5, base: 3, src: SRC_ECDICT },
  { id: 'tem4', name: '英语专业四级', nameEn: 'TEM-4', short: '专四', level: 5, base: 3, src: SRC_KYLE },
  { id: 'ielts', name: '雅思', nameEn: 'IELTS', short: '雅思', level: 6, base: 3, src: SRC_ECDICT },
  { id: 'toefl', name: '托福', nameEn: 'TOEFL', short: '托福', level: 7, base: 3, src: SRC_ECDICT },
  { id: 'sat', name: 'SAT', nameEn: 'SAT', short: 'SAT', level: 8, base: 4, src: SRC_KYLE },
  { id: 'tem8', name: '英语专业八级', nameEn: 'TEM-8', short: '专八', level: 8, base: 4, src: SRC_KYLE },
  { id: 'gre', name: 'GRE', nameEn: 'GRE', short: 'GRE', level: 9, base: 4, src: SRC_ECDICT },
];
const examFinal = new Map();
for (const b of EXAM_BOOKS) {
  const raw = examRaw.get(b.id);
  if (!raw) continue;
  const words = [...raw].filter((w) => !isBelow(w, b.base + 1));
  examFinal.set(b.id, new Set(words));
  const removed = raw.size - words.length;
  addBook({
    id: b.id, name: b.name, nameEn: b.nameEn, short: b.short, category: 'exam', level: b.level, source: b.src,
    description: b.base > 0
      ? `${b.name}词汇，已去掉 ${removed} 个 ${CEFR_NAMES[b.base]} 及以下的基础词`
      : `${b.name}词汇`,
  }, words);
}

// 7.3 增量：本书 − 前置考试（原始集合，含基础词）
const DELTA_BOOKS = [
  { id: 'gk-new', of: 'gk', minus: ['zk'], name: '高考新增', short: '高考+', level: 2 },
  { id: 'cet4-new', of: 'cet4', minus: ['zk', 'gk'], name: '四级新增', short: '四级+', level: 3 },
  { id: 'cet6-new', of: 'cet6', minus: ['zk', 'gk', 'cet4'], name: '六级新增', short: '六级+', level: 4 },
  { id: 'kaoyan-new', of: 'kaoyan', minus: ['zk', 'gk', 'cet4', 'cet6'], name: '考研新增', short: '考研+', level: 5 },
  { id: 'ielts-new', of: 'ielts', minus: ['zk', 'gk', 'cet4', 'cet6'], name: '雅思新增', short: '雅思+', level: 6 },
  { id: 'toefl-new', of: 'toefl', minus: ['zk', 'gk', 'cet4', 'cet6'], name: '托福新增', short: '托福+', level: 7 },
  { id: 'gre-new', of: 'gre', minus: ['zk', 'gk', 'cet4', 'cet6', 'kaoyan', 'ielts', 'toefl'], name: 'GRE 新增', short: 'GRE+', level: 9 },
];
const examName = Object.fromEntries(EXAM_BOOKS.map((b) => [b.id, b.short]));
for (const d of DELTA_BOOKS) {
  const base = examFinal.get(d.of);
  if (!base) continue;
  const minus = new Set(d.minus.flatMap((id) => [...(examRaw.get(id) ?? [])]));
  const of = EXAM_BOOKS.find((b) => b.id === d.of);
  addBook({
    id: d.id, name: d.name, nameEn: `${of.nameEn} only`, short: d.short, category: 'exam', level: d.level, source: of.src,
    delta: { of: d.of, minus: d.minus },
    description: `${of.name}中不属于${d.minus.map((id) => examName[id]).join('/')}的词，适合已过${examName[d.minus.at(-1)]}的读者`,
  }, [...base].filter((w) => !minus.has(w)));
}

// 7.4 词频：COCA 前 N 之外（在 inventory 内，无排名的考试词视为低频）
const FREQ_BOOKS = [3000, 5000, 8000, 12000];
for (const [i, n] of [...FREQ_BOOKS.entries()].reverse()) {
  const next = FREQ_BOOKS[i + 1];
  const k = `${n / 1000}k`;
  addBook({
    id: `coca-${k}`, name: `常用 ${n} 词之外`, nameEn: `Beyond COCA top ${n}`, short: `${k}+`, category: 'frequency', level: n / 1000,
    source: 'ECDICT COCA/BNC 词频排名',
    description: `高亮词频排名 ${n} 之后的词（视前 ${n} 个常用词为已会）`,
  }, [...levelOf.keys()].filter((w) => rankOf(w) > n && levelOf.get(w) >= 3), next ? `coca-${next / 1000}k` : undefined);
}

// ---------------------------------------------------------------------------
// 8. 词典
// ---------------------------------------------------------------------------
// ECDICT-ultimate（可选）：pos 词性占比 + 更现代的释义行（如 scenario：方案；情节），两者都只在构建时使用
/** @type {Map<string, {pos:string, lines:string[]}>} */
const ultimate = new Map();
const ULT = path.join(RAW, 'ultimate', 'ultimate.csv');
const dictWords = new Set(levelOf.keys());
for (const [w] of ecdict) if (rankOf(w) <= DICT_RANK_MAX && isLemmaCandidate(w)) dictWords.add(w);
// 词书中的每个词都必须有词典条目（CEFR-J 收录的 april 等首字母大写词）
for (const list of bookWords.values()) for (const w of list) dictWords.add(w);
if (fs.existsSync(ULT)) {
  console.time('ultimate');
  const rl = readline.createInterface({ input: fs.createReadStream(ULT, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const key = line.slice(0, line.indexOf(',')).toLowerCase();
    if (!dictWords.has(key)) continue;
    parseCsv(line, (r) => {
      const [word, , , translation, pos] = r;
      // 大小写重复时优先全小写词条
      if (ultimate.has(key) && word !== key) return;
      ultimate.set(key, { pos: pos || '', lines: translationLines(translation) });
    });
  }
  console.timeEnd('ultimate');
} else console.warn('未找到 ultimate.csv，短释义只用 ECDICT 基础版 + 词表释义投票');

/**
 * KyleBing 各词表自带的教材式释义（常用义在前）：只作为“哪个义项最常用”的投票信号，不输出其文本。
 * 每个词收集所有词表中**不同**的释义文本（多个词表照抄同一份有道释义时只算一票）；
 * 四级/六级/托福/雅思等精选表只列 1–3 个考点义项，是“最常用义项”的强信号。
 * 格式："v. 使固定；修理 n. 困境"、"v::离弃；放弃¦n::…"、"vi&n::拖欠"
 * @type {Map<string, string[]>}
 */
const kyleGloss = new Map();
for (const f of fs.existsSync(path.join(RAW, 'kyle')) ? fs.readdirSync(path.join(RAW, 'kyle')).sort() : []) {
  if (!f.endsWith('.txt')) continue;
  for (const line of fs.readFileSync(path.join(RAW, 'kyle', f), 'utf8').split('\n')) {
    const [w, gloss] = line.split('\t');
    const key = w?.trim().toLowerCase();
    if (!key || !gloss || !dictWords.has(key)) continue;
    const text = gloss.replace(/\s*::\s*/g, '. ').replace(/(^|¦)\s*([a-z]+)&[a-z&]+\./g, '$1$2.').trim();
    const list = kyleGloss.get(key) ?? [];
    if (!list.includes(text)) list.push(text);
    kyleGloss.set(key, list);
  }
}
/** 教材释义拆成“词性段”：按 ¦ 或下一个词性前缀切分 */
function kyleSegments(text) {
  return text.split(/\s*¦\s*|\s+(?=(?:vt|vi|v|n|adj|adv|a|ad|prep|conj|pron|int|num|art)\.)/).filter(Boolean);
}

const POS_PREFIX = {
  n: ['n.'], v: ['v.', 'vt.', 'vi.', 'aux.', 'modal.'], j: ['adj.', 'a.', 's.'], r: ['adv.', 'ad.'], i: ['prep.'],
  c: ['conj.'], p: ['pron.'], u: ['int.', 'interj.'], m: ['num.'], d: ['det.', 'art.'],
};
const PREFIX_POS = Object.fromEntries(Object.entries(POS_PREFIX).flatMap(([code, list]) => list.map((pre) => [pre, code])));
const CEFR_POS = { noun: 'n', verb: 'v', adjective: 'j', adverb: 'r', preposition: 'i', conjunction: 'c', pronoun: 'p', interjection: 'u', number: 'm', determiner: 'd' };
/** 释义行的词性代码（n/v/j/r…），无前缀为 '' */
function posOfLine(line) {
  return PREFIX_POS[(line.match(/^[a-z]+\./i) || [''])[0].toLowerCase()] ?? '';
}
/**
 * 词性权重：CEFR-J 标注的词性（该词最低级别）最优先，其次 ultimate 词性占比
 */
function posWeights(w) {
  const weight = new Map();
  for (const part of (ultimate.get(w)?.pos ?? '').split('/')) {
    const [code, pct] = part.split(':');
    if (code) weight.set(code, Math.max(weight.get(code) || 0, Number(pct) || 0));
  }
  // CEFR-J 词性：无 ultimate 词性占比时决定首选词性，有占比时只作小幅加权（fix 的 CEFR-J 最低级别是名词，但动词更常用）
  for (const pos of cefr.get(w)?.pos ?? []) {
    const code = CEFR_POS[pos];
    if (code) weight.set(code, (weight.get(code) || 0) + 30);
  }
  return weight;
}
/** 释义行按词性权重排序，同权重保持原顺序 */
function sortLines(lines, weight) {
  const wOf = (line) => weight.get(posOfLine(line)) || 0;
  return lines.map((l, i) => [l, i]).sort((a, b) => wOf(b[0]) - wOf(a[0]) || a[1] - b[1]).map((x) => x[0]);
}

/**
 * 专业/学科/语体标注：[医]、[计]、(商)、<计>、〔尤指…〕、【体育】、(美)(俚) 等。
 * 带这类标注的义项是专业义或冷僻义，短释义降权（不是排除：interface 的“<计>接口”仍可能胜出）
 */
const DOMAIN_MARK_RE = /^\s*(?:\[[^\]]{1,6}\]|［[^］]{1,6}］|\([^)]{1,4}\)|（[^）]{1,4}）|<[^>]{1,6}>|〈[^〉]{1,6}〉|【[^】]{1,8}】)/;
/** 冷僻/古旧/口语/贬义的语体词（出现在义项括注里）：降权 */
const RARE_MARK_RE = /古|旧|废|俚|方言|诗|罕|蔑|粗|俗|苏格兰|美俚|英俚|口语/;

/** 按 , ; ， ； 、 切分义项，括号内的分隔符不切（"(日, 月)落下" 是一个义项） */
function splitTopLevel(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if ('[［(（<〈【〔《'.includes(ch)) depth++;
    else if (depth > 0 && ']］)）>〉】〕》'.includes(ch)) depth--;
    if (depth === 0 && ',;，；、'.includes(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 一行释义拆成义项：去掉词性前缀、学科标注、括注。
 * 返回 {text, marked}：marked 为该义项带专业/语体标注（降权用）
 */
function senseItems(line) {
  // 有的释义用空格分隔义项（"山药 甘薯 白薯"）：汉字之间的空白视为分隔符
  return splitTopLevel(line.replace(/^(?:[a-z]+\.\s*(?:&\s*)?)+/i, '').replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1；'))
    .map((raw) => {
      const marked = DOMAIN_MARK_RE.test(raw) || (/[[［(（<〈【〔]/.test(raw) && RARE_MARK_RE.test(raw.match(/[[［(（<〈【〔][^\]］)）>〉】〕]*/g)?.join('') ?? ''));
      // 计算机领域标注（[计]、<计>）：现代网页上计算机义往往已是最常用义，打分时有单独的例外规则
      const computing = /^\s*[[［(（<〈【]计算?机?[\]］)）>〉】]/.test(raw);
      const text = raw
        .replace(/\[[^\]]*\]|［[^］]*］|〔[^〕]*〕|【[^】]*】/g, '')
        .replace(/\([^)]*\)|（[^）]*）|<[^>]*>|〈[^〉]*〉|《[^》]*》/g, '')
        .trim()
        // “在……之后”“使...加快”统一为单个省略号，行内更紧凑
        .replace(/…+$|\.+$/g, '').replace(/…+|\.{2,}/g, '…')
        // 残留的数字编号（"1. 具体的"）与空白
        .replace(/^[\d.\s·&]+/, '').replace(/[()（）[\]［］<>〈〉【】〔〕《》]/g, '').replace(/\s+/g, '');
      return { text, marked, computing };
    })
    .filter((x) => CJK_RE.test(x.text) && !/[a-z]{3}/.test(x.text));
}
/** 兼容旧调用：只要文本 */
function senses(line) {
  return senseItems(line).map((x) => x.text);
}
/** 义项比较时忽略“使/的/地”等虚词，让“使固定”与“固定”、“过时的”与“过时”视为同一义项 */
const senseKey = (s) => s.replace(/^使/, '').replace(/[的地]$/, '');
/** 按词性归一：只有动词去“使”（使用者 ≠ 用者），只有形容词/副词去“的/地”（目的 ≠ 目） */
const senseKeyOf = (s, pos) => (pos === 'v' ? s.replace(/^使(?=..)/, '') : (pos === 'j' || pos === 'r') ? s.replace(/(?<=..)[的地]$/, '') : s);

/**
 * 行内短释义：跨词性给每个候选义项打分，取最高分。
 *
 * - 词性分：ultimate 词性占比 + CEFR-J 词性加成（常用词性的义项优先：present 取动词/形容词，不取“瞄准”）
 * - 位次票：ECDICT 基础版、ultimate、各 KyleBing 词表各是一个投票来源；义项在**本词性内**排第 i 位得 max(10-3i, 1) 分，
 *   多个来源都把它排在前面说明它最常用（scenario → 方案，convert → 转换）。精选词表（义项 ≤ 4 个的）只列考点义，权重更高
 * - 降权：专业/语体标注（[医]保险费、(商)溢价、〔尤指〕）、1 个字（线：歧义大）、超过 6 个字（不精炼）
 * - 同一义项的多个写法（“使合并/合并”“具体/具体的”）取最自然的：动词去掉“使”，形容词保留“的”
 * - 人工覆盖表 SHORT_OVERRIDES：自动打分仍明显不合常用义的高频多义词（见文件内说明）
 */
/**
 * 中文义项的“常用度”：该中文词在全部词条（ECDICT + ultimate，词频前 3 万）的释义中出现的次数。
 * 区域/损失/观察/当前 这类常用中文词是很多英文词的译文，流通/遗失/主管人员 则少，用来在位次票接近时打破平局
 * @type {Map<string, number>}
 */
const zhFreq = new Map();
for (const [w, e] of ecdict) {
  if (rankOf(w) > DICT_RANK_MAX) continue;
  for (const lines of [e.lines, ultimate.get(w)?.lines ?? []]) {
    for (const line of lines) for (const { text } of senseItems(line)) {
      const k = senseKeyOf(text, posOfLine(line));
      zhFreq.set(k, (zhFreq.get(k) ?? 0) + 1);
    }
  }
}

/** 打分权重（调参时可用环境变量 SHORT_W='{"ult":2}' 覆盖，正式构建用默认值） */
const W = { ec: 0.8, ult: 3, kc: 0.7, kf: 0.4, pos: 25, zh: 2, mark: 5, long: 12, ...JSON.parse(process.env.SHORT_W || '{}') };
function shortOf(w, baseLines) {
  // 人工覆盖的词只给 s；动词释义只取 verb-overrides.tsv 明确给出的（覆盖值已按常见用法选定词性，自动 v 多与之不配）
  if (SHORT_OVERRIDES.has(w)) {
    const short = SHORT_OVERRIDES.get(w);
    const verb = VERB_OVERRIDES.get(w);
    return { short, verb: verb && verb !== short ? verb : undefined };
  }
  const weight = posWeights(w);
  const maxW = Math.max(1, ...weight.values());
  /** @type {{lines:string[], wgt:number}[]} */
  const sources = [
    { lines: baseLines.filter((l) => !/^\[/.test(l)), wgt: W.ec },
    { lines: ultimate.get(w)?.lines ?? [], wgt: W.ult },
  ];
  const kyle = kyleGloss.get(w) ?? [];
  // 词表很多（常用词在 20 个文本里都出现）时整体缩放，避免压过 ECDICT/ultimate
  const kyleScale = Math.min(1, 4 / Math.max(1, kyle.length));
  for (const g of kyle) {
    const segs = kyleSegments(g);
    const n = segs.reduce((acc, s) => acc + senseItems(s).length, 0);
    // 精选表（只列少数考点义）是强信号；照抄完整释义的弱一些（与 ultimate 高度相关）
    sources.push({ lines: segs, wgt: (n <= 4 ? W.kc : W.kf) * kyleScale });
  }
  /** key -> {score, variants: Map<text, count>, pos} */
  const cand = new Map();
  for (const { lines: raw, wgt } of sources) {
    // 有道/ultimate 常把 vi. 行排在 vt. 行前（accept：vi. 承认 / vt. 接受），及物用法更常见，vt. 行提前
    const lines = [...raw].sort((x, y) => (/^vi\./.test(x) && /^vt\./.test(y) ? 1 : /^vt\./.test(x) && /^vi\./.test(y) ? -1 : 0));
    const rankInPos = new Map();
    const seen = new Set();
    for (const line of lines) {
      const pos = posOfLine(line);
      for (const { text, marked, computing } of senseItems(line)) {
        // 候选按“词性 + 义项”区分：concrete 的“混凝土(n.)”与“混凝土的(adj.)”是两个候选，各自吃自己词性的分
        const key = pos + ':' + senseKeyOf(text, pos);
        if (seen.has(key)) continue;
        seen.add(key);
        const i = rankInPos.get(pos) ?? 0;
        rankInPos.set(pos, i + 1);
        let c = cand.get(key);
        if (!c) cand.set(key, (c = { key, base: senseKeyOf(text, pos), score: 0, variants: new Map(), pos, marked: false }));
        // 位次票按该词性的常用度缩放：implement 的名词“工具”在各词表都排名词第一，但名词只占 5%
        c.score += Math.max(10 - 3 * i, 1) * wgt * (weight.size ? 0.3 + 0.7 * ((weight.get(pos) || 0) / maxW) : 1);
        c.variants.set(text, (c.variants.get(text) ?? 0) + wgt);
        if (marked) c.marked = true;
        // 有道（ultimate）把计算机义项排在本行首位（browser：[计] 浏览器；printer：[计] 打印机），
        // 说明计算机义已是现代最常用义，不再降权。只对计算机领域放开：其他领域（[化] 化合物、[医] 瘤）放开后普遍变差；
        // ECDICT 基础版的 [计] 义项多为术语堆砌，不享受此例外
        if (computing && wgt === W.ult && i === 0) c.primaryMarked = true;
      }
    }
  }
  if (!cand.size) return { short: '' };
  let best;
  let bestScore = -Infinity;
  for (const c of cand.values()) {
    // 词性分：最常用词性满分 25；无词性信息时为 0，只看位次票
    let score = c.score + W.pos * ((weight.get(c.pos) || 0) / maxW);
    score += W.zh * Math.min(4, Math.log2(1 + (zhFreq.get(c.base) ?? 0)));
    if (c.marked && !c.primaryMarked) score -= W.mark;
    const len = c.base.length;
    score -= len === 1 ? 5 : len > SHORT_MAX ? 30 : len > 6 ? W.long : len > 4 ? 1 : 0;
    c.final = score;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (process.env.DEBUG_SHORT?.split(',').includes(w)) {
    console.log(w, [...cand.values()].sort((a, b) => b.final - a.final).slice(0, 8).map((c) => `${c.key}=${c.final.toFixed(1)}${c.marked ? '*' : ''}`).join(' '));
  }
  const short = displayText(best);
  // 动词短释义：首选义项不是动词、但该词有动词变形（-ed/-ing/-s）且动词用法不罕见时另给一个动词释义，
  // 页面上的词形是动词变形（advocating、elevated）时 engine 可改用它（advocate：提倡者 / 提倡）
  let verb;
  const verbForms = /(?:^|\/)[pdi3]:/.test(ecdict.get(w)?.exchange ?? '');
  if (best.pos !== 'v' && verbForms && (weight.size ? (weight.get('v') || 0) / maxW >= 0.15 : true)) {
    const bestVerb = [...cand.values()].filter((c) => c.pos === 'v').sort((x, y) => y.final - x.final)[0];
    if (bestVerb) verb = displayText(bestVerb);
    // 动词释义只在行内替换 short 用，必须同样精炼完整：超过 6 字或带“…”残缺框式（在上盖…的邮戳）的不提供，回退到 short
    if (verb && !isCleanVerbShort(verb)) verb = undefined;
  }
  // 人工覆盖（verb-overrides.tsv）：ECDICT 把冷僻动词义排在前面（match 使比赛、bolt 筛选、date 过时）时改成常用义；'-' 表示置空
  if (VERB_OVERRIDES.has(w)) verb = VERB_OVERRIDES.get(w) || undefined;
  return { short, verb: verb && verb !== short ? verb : undefined };
}

/** 候选义项的显示写法：在同义写法中挑最自然的一个，并去掉行内注解里生硬的成分 */
function displayText(best) {
  // 出现次数多的优先；动词去“使”（使合并 → 合并）；形容词带“的”更像形容词（具体 → 具体的）
  const variants = [...best.variants].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map((x) => x[0]);
  let text = variants[0];
  if (text.startsWith('使') && text.length >= 3 && variants.some((v) => !v.startsWith('使'))) text = variants.find((v) => !v.startsWith('使'));
  if (best.pos === 'j' && !/[的地]$/.test(text) && variants.some((v) => v.endsWith('的'))) text = variants.find((v) => v.endsWith('的'));
  // 副词不带“地”更自然（完全地 → 完全、特别地 → 特别）
  if (best.pos === 'r' && text.endsWith('地') && variants.some((v) => !v.endsWith('地'))) text = variants.find((v) => !v.endsWith('地'));
  // 动词义项的“对…/把…/使…/将…”框式前缀在行内注解里生硬（对…评价过高 → 评价过高、把…归档 → 归档），去掉；介词的“在…旁边”保留
  if (best.pos === 'v') text = text.replace(/^(?:对|把|使|将|给|为|向|与|让)…(?=..)/, '');
  // 超长义项在“或”处截断（服装设计或其服装店 → 服装设计），仍超长才硬截
  if (text.length > 6 && text.indexOf('或') >= 2) text = text.slice(0, text.indexOf('或'));
  return text.length > SHORT_MAX ? text.slice(0, SHORT_MAX) : text;
}

/** 人工覆盖表（scripts/data/short-overrides.tsv）：自动打分仍不合常用义的高频多义词 */
const SHORT_OVERRIDES = new Map(
  fs.readFileSync(new URL('./short-overrides.tsv', import.meta.url), 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t').map((x) => x.trim())),
);
for (const [w, g] of SHORT_OVERRIDES) if (!g || g.length > SHORT_MAX) throw new Error(`short-overrides.tsv: ${w} 的释义为空或超过 ${SHORT_MAX} 字`);

/**
 * 动词短释义人工覆盖表（scripts/data/verb-overrides.tsv）：单词<TAB>动词短释义，'-' 表示不提供 v（解析为 ''，shortOf 中置空）。
 * 格式约束（≤ 6 字、不含“…”）见 verb-short.mjs#isCleanVerbShort，解析时不合格直接抛错
 */
const VERB_OVERRIDES = parseVerbOverrides(fs.readFileSync(new URL('./verb-overrides.tsv', import.meta.url), 'utf8'));

/**
 * 短释义审计：给可疑的自动选义打标（不影响输出），人工复核后补进 short-overrides.tsv。
 * - one：单字（队、科、珠、孵），歧义大
 * - idiom：四字且非“…的”（流连忘返、若有所思），多为文学化译法
 * - offtop：不在 ECDICT / ultimate 任一来源首行的前 3 个义项中（启齿、全权），与常用义不重合
 * - domain：选中的义项带专业标注（[医]、[数]…）
 * - tech：ECDICT 有计算机义项而短释义没取它（server 发球员、cache 贮存物），网页上常是计算机义
 */
function auditFlags(w, short, baseLines) {
  if (!short || SHORT_OVERRIDES.has(w)) return [];
  const flags = [];
  const k = senseKey(short);
  if (short.length === 1) flags.push('one');
  if (short.length === 4 && !/[的地]$/.test(short)) flags.push('idiom');
  const firsts = [baseLines.find((l) => !/^\[/.test(l)), ultimate.get(w)?.lines[0]].filter(Boolean);
  const top3 = new Set(firsts.flatMap((l) => senseItems(l).slice(0, 3).map((x) => senseKey(x.text))));
  if (top3.size && !top3.has(k)) flags.push('offtop');
  const all = [...baseLines, ...(ultimate.get(w)?.lines ?? [])].flatMap((l) => senseItems(l));
  if (all.some((x) => x.marked && senseKey(x.text) === k) && !all.some((x) => !x.marked && senseKey(x.text) === k)) flags.push('domain');
  const tech = baseLines.filter((l) => /^\[计\]/.test(l)).flatMap((l) => senseItems(l).map((x) => x.text));
  if (tech.length && !tech.some((t) => senseKey(t) === k)) flags.push('tech:' + tech.slice(0, 2).join('/'));
  return flags;
}
const auditRows = [];

/** 词形变化：只保留屈折类型，供卡片展示 “widths 复数” */
function formsOf(e) {
  const out = [];
  for (const part of e.exchange.split('/')) {
    const idx = part.indexOf(':');
    const type = part.slice(0, idx);
    if (INFLECT_TYPES.has(type)) out.push(`${type}:${part.slice(idx + 1)}`);
  }
  return out.join('/');
}

const shortShards = new Map();
const fullShards = new Map();
let emptyShort = 0;
for (const w of [...dictWords].sort()) {
  const e = ecdict.get(w);
  // 完整释义优先 ultimate（义项更规整），按词性常用度排序
  const lines = sortLines(ultimate.get(w)?.lines.length ? ultimate.get(w).lines : e.lines, posWeights(w));
  let { short: s, verb: sv } = shortOf(w, e.lines);
  if (!s) {
    // 英式拼写 -ise 借 -ize 词条
    const alt = w.replace(/is(e|es|ed|ing|ation|ations)$/, 'iz$1');
    if (ecdict.has(alt) && alt !== w) ({ short: s, verb: sv } = shortOf(alt, ecdict.get(alt).lines));
  }
  if (!s) emptyShort++;
  if (AUDIT && (rankOf(w) <= 20000 || levelOf.has(w))) {
    const flags = auditFlags(w, s, e.lines);
    if (flags.length) auditRows.push([w, rankOf(w), s, flags.join(' '), (ultimate.get(w)?.lines[0] ?? e.lines[0] ?? '').slice(0, 60)].join('\t'));
  }
  const shard = w[0];
  const short = {};
  if (e.phonetic) short.p = e.phonetic;
  if (s) short.s = s;
  if (sv) {
    // 兜底断言：任何来源的 v 都必须精炼完整，否则构建失败（而不是把残缺释义写进产物）
    if (!isCleanVerbShort(sv)) throw new Error(`动词短释义不合格：${w}=${sv}（≤ 6 字且不含“…”）`);
    short.v = sv;
  }
  const g = examTagsOf.get(w);
  if (g) short.g = g.join(' ');
  if (levelOf.has(w)) short.l = levelOf.get(w);
  const r = rankOf(w);
  if (Number.isFinite(r)) short.r = r;
  if (!shortShards.has(shard)) shortShards.set(shard, {});
  shortShards.get(shard)[w] = short;
  const full = {};
  const f = lines.slice(0, FULL_MAX_LINES).join('\n');
  if (f) full.f = f;
  const x = formsOf(e);
  if (x) full.x = x;
  if (f || x) {
    if (!fullShards.has(shard)) fullShards.set(shard, {});
    fullShards.get(shard)[w] = full;
  }
}

// ---------------------------------------------------------------------------
// 9. 输出
// ---------------------------------------------------------------------------
const stats = { files: {}, books: {}, totals: {} };
function emit(rel, content) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const buf = Buffer.from(content);
  stats.files[rel] = { raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
}
// 清理旧产物（只清本脚本拥有的 books/ dict/，不动其他分片放在 data/ 下的文件）
fs.rmSync(path.join(OUT, 'books'), { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'dict'), { recursive: true, force: true });

// 目录按分类 + 难度排序，便于 UI 直接展示
const CATEGORY_ORDER = ['level', 'exam', 'frequency'];
catalog.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.level - b.level || (a.delta ? 1 : 0) - (b.delta ? 1 : 0));
for (const meta of catalog) {
  const parentId = bookExtends.get(meta.id);
  const parent = parentId ? new Set(bookWords.get(parentId)) : undefined;
  const words = parent ? bookWords.get(meta.id).filter((w) => !parent.has(w)) : bookWords.get(meta.id);
  emit(`books/${meta.id}.json`, JSON.stringify(parent ? { id: meta.id, words, extends: [parentId] } : { id: meta.id, words }));
  stats.books[meta.id] = meta.size;
}
emit('books/index.json', JSON.stringify({ version: 2, books: catalog }, null, 1));
for (const [shard, data] of [...shortShards].sort()) emit(`dict/${shard}.json`, JSON.stringify(data));
for (const [shard, data] of [...fullShards].sort()) emit(`dict/full/${shard}.json`, JSON.stringify(data));
emit('NOTICE.txt', `内置词书与词典数据来源（由 scripts/data/build-data.mjs 生成）

- ECDICT, Copyright (c) 2017 Linwei (skywind3000), MIT License. https://github.com/skywind3000/ECDICT
  音标、中英释义、考试标签（中考/高考/四级/六级/考研/雅思/托福/GRE）、COCA/BNC 词频、词形变化。
- The CEFR-J Wordlist Version 1.5. Compiled by Yukio Tono, Tokyo University of Foreign Studies.
  Retrieved from http://www.cefr-j.org/download.html (via https://github.com/openlanguageprofiles/olp-en-cefrj).
  A1–B2 分级。按其使用条款免费用于商业用途，需注明出处。
- KyleBing/english-vocabulary, BSD-3-Clause. https://github.com/KyleBing/english-vocabulary
  仅使用 SAT、英语专业四级/八级的单词列表（不含释义）。
`);

function sum(pred) {
  let raw = 0;
  let gzip = 0;
  for (const [k, v] of Object.entries(stats.files)) if (pred(k)) { raw += v.raw; gzip += v.gzip; }
  return { raw, gzip };
}
stats.totals = {
  dictWords: dictWords.size,
  levelWords: levelOf.size,
  emptyShort,
  books: sum((k) => k.startsWith('books/')),
  dictShort: sum((k) => /^dict\/[a-z]\.json$/.test(k)),
  dictFull: sum((k) => k.startsWith('dict/full/')),
  all: sum(() => true),
};
if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ ...stats, droppedInflections: Object.fromEntries(droppedInflections) }, null, 1));
if (AUDIT) fs.writeFileSync(AUDIT, ['word\trank\tshort\tflags\tfirst_line', ...auditRows.sort((a, b) => Number(a.split('\t')[1]) - Number(b.split('\t')[1]))].join('\n') + '\n');
console.log(JSON.stringify(stats.totals));
console.log(Object.entries(stats.books).map(([k, v]) => `${k}=${v}`).join(' '));
