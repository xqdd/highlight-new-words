#!/usr/bin/env node
/**
 * 内置词书与词典数据构建脚本（可复现：输入固定 commit 的原始数据，输出确定性排序的 JSON）。
 *
 * 用法：
 *   scripts/data/fetch-raw.sh .cache/data-raw [--with-ultimate]
 *   node scripts/data/build-data.mjs --raw .cache/data-raw [--out public/data] [--report report.json]
 *
 * 输入（--raw 目录）：
 *   ecdict.csv                         ECDICT（MIT）：音标/释义/考试标签/COCA(frq)/BNC 排名/词形变化(exchange)
 *   lemma.en.txt                       ECDICT 附带 BNC 词形表（MIT）：补充屈折词形 -> 原形
 *   cefrj/cefrj-vocabulary-profile-1.5.csv  CEFR-J Wordlist 1.5（免费商用，需署名）：A1–B2 分级
 *   kyle/7 SAT-乱序.txt、kyle/tsv_专四.txt、kyle/tsv_专八.txt  KyleBing/english-vocabulary（BSD-3）：只取词表
 *   ultimate/ultimate.csv              可选，ECDICT-ultimate（MIT）：只用 pos 词性占比给短释义排序
 *
 * 输出（--out 目录，默认 public/data，结构见 src/core/wordbook/types.ts、src/core/dict/types.ts）：
 *   books/index.json        BookCatalog：词书目录（词数/描述/分类/级别/增量关系）
 *   books/<id>.json         BookDataFile：小写原形，已排序
 *   dict/<a-z>.json         DictShardFile 短表：p 音标、s 行内短释义、g 考试标签、l 级别、r 词频排名（高亮/行内翻译热路径）
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
if (!fs.existsSync(path.join(RAW, 'ecdict.csv'))) {
  console.error(`缺少 ${RAW}/ecdict.csv，先运行 scripts/data/fetch-raw.sh ${RAW}`);
  process.exit(1);
}

/** 只有纯字母才视为可高亮单词；短语、连字符词、缩写不进词书 */
const WORD_RE = /^[a-z]+$/;
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
  if (!e || w.length < 2 || isProperNoun(w)) return false;
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
for (const [w] of ecdict) if (rankOf(w) <= INVENTORY_RANK_MAX && isLemmaCandidate(w)) extraWords.add(w);
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
function addBook(meta, words, extendsId) {
  const list = [...new Set(words)].filter((w) => WORD_RE.test(w)).sort();
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
 * 格式："v. 使固定；修理 n. 困境" 或 "v::离弃；放弃"
 * @type {Map<string, string>}
 */
const kyleGloss = new Map();
for (const f of fs.existsSync(path.join(RAW, 'kyle')) ? fs.readdirSync(path.join(RAW, 'kyle')).sort() : []) {
  if (!f.endsWith('.txt')) continue;
  for (const line of fs.readFileSync(path.join(RAW, 'kyle', f), 'utf8').split('\n')) {
    const [w, gloss] = line.split('\t');
    const key = w?.trim().toLowerCase();
    if (key && gloss && dictWords.has(key) && !kyleGloss.has(key)) kyleGloss.set(key, gloss.replace(/::/g, '. '));
  }
}

const POS_PREFIX = {
  n: ['n.'], v: ['v.', 'vt.', 'vi.'], j: ['adj.', 'a.', 's.'], r: ['adv.', 'ad.'], i: ['prep.'],
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

/** 一行释义拆成义项：去掉词性前缀、学科标注、括注 */
function senses(line) {
  return line
    .replace(/^(?:[a-z]+\.\s*)+/i, '')
    .replace(/\[[^\]]*\]|［[^］]*］|〔[^〕]*〕/g, '')
    .replace(/\([^)]*\)|（[^）]*）|<[^>]*>|《[^》]*》/g, '')
    .split(/[,;，；、]/)
    // “在……之后”“使...加快”统一为单个省略号，行内更紧凑
    .map((x) => x.trim().replace(/…+$|\.+$/g, '').replace(/…+|\.{2,}/g, '…'))
    .filter((x) => CJK_RE.test(x));
}
/** 义项比较时忽略“使/的/地”等虚词，让“使固定”与“固定”、“过时的”与“过时”视为同一义项 */
const senseKey = (s) => s.replace(/^使/, '').replace(/[的地]$/, '');

/**
 * 行内短释义：在首选词性的义项里投票选出最常用的一个。
 * 候选 = ECDICT 基础版与 ultimate 首选词性行的义项；ECDICT/ultimate/教材词表各自包含该义项各得一票，
 * 同票按出现位置靠前优先；超过 SHORT_MAX 字的义项降权。
 * 例：scenario -> 方案（ultimate、教材都靠前），convert -> 转换，obsolete -> 废弃的
 */
function shortOf(w, baseLines) {
  const weight = posWeights(w);
  const sources = [sortLines(baseLines, weight), sortLines(ultimate.get(w)?.lines ?? [], weight)]
    .filter((ls) => ls.some((l) => senses(l).length));
  if (!sources.length) return '';
  // 首选词性：权重最高的，没有权重信息时用 ECDICT 第一行的词性
  const topPos = posOfLine(sources[0].find((l) => senses(l).length));
  const pick = (lines) => {
    const same = lines.filter((l) => posOfLine(l) === topPos).flatMap(senses);
    return same.length ? same : senses(lines.find((l) => senses(l).length) ?? '');
  };
  const lists = sources.map(pick);
  // 教材词表：取与首选词性相同的那段释义，没有则取第一段
  const segs = (kyleGloss.get(w) ?? '').trim().split(/\s+(?=[a-z]+\.)/);
  const kyle = senses(segs.find((g) => posOfLine(g) === topPos) ?? segs[0] ?? '');
  // 位次投票：来源中排第 i 位得 max(10-3i, 1) 分，越靠前越重要；ultimate 义项更现代（scenario：方案）权重略高，
  // 教材词表多抄自有道（与 ultimate 相关），权重略低
  const voters = [[lists[0], 1], [lists[1] ?? [], 1.2], [kyle, 0.8]];
  let best = '';
  let bestScore = -Infinity;
  for (const s of new Set(lists.flat())) {
    const k = senseKey(s);
    let score = 0;
    for (const [list, wgt] of voters) {
      const i = list.findIndex((x) => senseKey(x) === k);
      if (i >= 0) score += Math.max(10 - 3 * i, 1) * wgt;
    }
    // 偏好短义项：超长截断难看，5 字以上降权（住在都市的 < 城市的）
    score -= s.length > SHORT_MAX ? 20 : s.length > 4 ? 2 : 0;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best.length > SHORT_MAX ? best.slice(0, SHORT_MAX) : best;
}

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
  let s = shortOf(w, e.lines);
  if (!s) {
    // 英式拼写 -ise 借 -ize 词条
    const alt = w.replace(/is(e|es|ed|ing|ation|ations)$/, 'iz$1');
    s = ecdict.has(alt) && alt !== w ? shortOf(alt, ecdict.get(alt).lines) : '';
  }
  if (!s) emptyShort++;
  const shard = w[0];
  const short = {};
  if (e.phonetic) short.p = e.phonetic;
  if (s) short.s = s;
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
if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(stats, null, 1));
console.log(JSON.stringify(stats.totals));
console.log(Object.entries(stats.books).map(([k, v]) => `${k}=${v}`).join(' '));
