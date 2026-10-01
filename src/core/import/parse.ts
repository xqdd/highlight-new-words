import type { UserWord } from '../wordbook/types';
import type { ImportFormat, ImportInput, ImportResult, WordListParser } from './types';

/**
 * 词表导入的最小解析实现（options 分片负责完善与 UI；接口见 types.ts）。
 *
 * 通用规则：
 * - 单词必须含拉丁字母（中文等其他语言词条计入 skipped），保留短语（如 “cut off”，匹配阶段不会命中但不报错）
 * - 释义/音标原样保留，展示时由 userWordToEntry 清洗 HTML
 * - 同一小写单词重复出现时后者覆盖前者
 */

const MAX_WARNINGS = 20;
/** 判断“像英文单词/短语”：拉丁字母开头（含 café/naïve 等变音符），仅含拉丁字母、空格、连字符、撇号、点 */
const WORD_RE = /^\p{Script=Latin}[\p{Script=Latin}\p{M} .'’-]*$/u;
/** 行首序号：“1. ”“2) ”“3、”“4 ” */
const LINE_NUMBER_RE = /^\d+(?:\s*[.)、．:：]\s*|\s+)/;
/** 常见词性缩写开头的释义（用于“word n. xxx”这种纯英文行的切分） */
const POS_RE = /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|int|interj|num|art|abbr|aux|det)\.\s*/i;

/** 统一入口：按 format（默认 auto）选择解析器 */
export function parseWordList(input: ImportInput): ImportResult {
  const format = !input.format || input.format === 'auto' ? detectImportFormat(input.text, input.fileName) : input.format;
  // 去掉 UTF-8 BOM（Excel 导出的 CSV 常见）
  const text = input.text.replace(/^﻿/, '');
  return { format, ...PARSERS[format](text) };
}

/**
 * 页面上不会被高亮的“短语”条目：含空格或连字符（give up、well-known）。
 * engine 只按单个英文单词（连续 ASCII 字母）匹配，多词条目整体永远不会命中，导入时据此提示用户（#38）。
 */
export function isPhraseEntry(word: string): boolean {
  return /[\s-]/.test(word.trim());
}

/** 导入结果中短语条目的数量（导入预览与结果提示用） */
export function countPhraseEntries(words: readonly UserWord[]): number {
  return words.reduce((n, w) => n + (isPhraseEntry(w.word) ? 1 : 0), 0);
}

/** 短语提示文案；没有短语时为空串 */
export function phraseNotice(count: number): string {
  return count > 0 ? `${count} 个短语不会在页面上高亮（含空格或连字符的词条，如 give up、well-known；目前只按单个单词匹配）` : '';
}

/** 按扩展名 + 内容嗅探识别格式 */
export function detectImportFormat(text: string, fileName = ''): ImportFormat {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 500);
  if (ext === 'xml' || /^<\?xml|^<wordbook/i.test(head)) return 'youdao-xml';
  if (/^#(separator|html|columns|notetype|deck|guid|tags)/m.test(head)) return 'anki';
  if (ext === 'tsv') return 'tsv';
  if (ext === 'csv') return 'csv';
  return 'txt';
}

/** 构造结果收集器：统一处理去重、校验与警告 */
function collector() {
  const map = new Map<string, UserWord>();
  let skipped = 0;
  const warnings: string[] = [];
  return {
    add(raw: string | undefined, trans?: string, phonetic?: string, line?: number) {
      const word = (raw ?? '').trim();
      if (!word) {
        skipped++;
        return;
      }
      if (!WORD_RE.test(word)) {
        skipped++;
        if (warnings.length < MAX_WARNINGS) warnings.push(`${line ? `第 ${line} 行` : ''}“${word.slice(0, 30)}”不是英文单词，已跳过`);
        return;
      }
      const w: UserWord = { word };
      if (trans?.trim()) w.trans = trans.trim();
      if (phonetic?.trim()) w.phonetic = phonetic.trim();
      map.set(word.toLowerCase(), w);
    },
    skip() {
      skipped++;
    },
    result() {
      return { words: [...map.values()], skipped, warnings };
    },
  };
}

/**
 * 最小 RFC 4180 解析：支持引号包裹、引号内换行、"" 转义。
 * 浏览器没有内置 CSV API，这里只实现导入所需的子集。
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 表头列识别：返回 单词/音标/释义 列下标；首行不像表头时返回 undefined */
function detectHeader(row: string[]): { word: number; phonetic: number; trans: number } | undefined {
  const find = (re: RegExp) => row.findIndex((c) => re.test(c.trim()));
  const word = find(/^(word|words|单词|词条|词汇|term|front|英文)$/i);
  if (word < 0) return undefined;
  return {
    word,
    phonetic: find(/^(phonetic|phon|音标|发音)$/i),
    trans: find(/^(trans|translation|meaning|definition|exp|explanation|back|释义|解释|中文|词义)$/i),
  };
}

/** 分隔符表格（csv/tsv/eudic 共用）：有表头按列名，无表头按 第1列=词、第2列=释义 */
function parseTable(text: string, delimiter: string): Omit<ImportResult, 'format'> {
  const out = collector();
  const rows = parseDelimited(text, delimiter);
  const header = rows[0] ? detectHeader(rows[0]) : undefined;
  const cols = header ?? { word: 0, phonetic: -1, trans: 1 };
  rows.forEach((r, i) => {
    if (header && i === 0) return;
    if (r.every((c) => !c.trim())) return out.skip();
    out.add(r[cols.word], cols.trans >= 0 ? r[cols.trans] : undefined, cols.phonetic >= 0 ? r[cols.phonetic] : undefined, i + 1);
  });
  return out.result();
}

/** 根据首个非空行猜测分隔符：tab > 逗号/分号中出现次数多者（Excel 在部分区域设置下导出分号分隔的 CSV） */
function guessDelimiter(text: string, fallback = '\t'): string {
  const line = text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? '';
  if (line.includes('\t')) return '\t';
  const commas = line.split(',').length - 1;
  const semis = line.split(';').length - 1;
  if (semis > commas) return ';';
  if (commas > 0) return ',';
  return fallback;
}

/** 释义开头的音标（[ˈæpl] 或 /ˈæpl/）拆出来 */
function splitPhonetic(rest: string): { phonetic?: string; trans: string } {
  const m = /^(\[[^\]]*\]|\/[^/]+\/)\s*([\s\S]*)$/.exec(rest.trim());
  return m ? { phonetic: m[1], trans: m[2] ?? '' } : { trans: rest };
}

/**
 * txt：一行一词；或 “词<tab/,/，/|/:/：>释义”；或 “abandon v. 放弃”“apple [ˈæpl] n. 苹果” 这种 单词+空格+(音标)+释义。
 * 行首序号（“1. ”“2) ”“3、”）会被去掉。
 */
const parseTxt: WordListParser = (text) => {
  const out = collector();
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = raw.trim().replace(LINE_NUMBER_RE, '');
    if (!line || line.startsWith('#') || line.startsWith('//')) return out.skip();
    const m =
      /^(.+?)\s*[\t,，|:：]\s*(.*)$/.exec(line) ??
      // 单词 + 空格 + 含非 ASCII 字符的释义/音标
      /^([\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*)\s+(.*[^\x00-\x7f].*)$/u.exec(line) ??
      // 单词 + 空格 + 词性开头的英文释义
      (() => {
        const sp = /^(\S+)\s+(.*)$/.exec(line);
        return sp && POS_RE.test(sp[2] ?? '') ? sp : null;
      })();
    if (!m) return out.add(line, undefined, undefined, i + 1);
    const { phonetic, trans } = splitPhonetic(m[2] ?? '');
    out.add(m[1], trans, phonetic, i + 1);
  });
  return out.result();
};

/**
 * 有道导出 XML（tests/fixtures/exampleNewWords.xml 为样例，字段多为 CDATA）。
 * 优先用 DOMParser；没有 DOMParser（service worker）或 XML 不规范（如未转义的 &）时退回正则逐条提取，坏条目不影响其他条目。
 */
const parseYoudaoXml: WordListParser = (text) => {
  const out = collector();
  const xml = typeof DOMParser === 'function' ? new DOMParser().parseFromString(text, 'text/xml') : undefined;
  if (xml && !xml.querySelector('parsererror')) {
    xml.querySelectorAll('item').forEach((item) => {
      out.add(
        item.querySelector('word')?.textContent ?? '',
        item.querySelector('trans')?.textContent ?? undefined,
        item.querySelector('phonetic')?.textContent ?? undefined,
      );
    });
    return out.result();
  }
  const field = (body: string, tag: string): string | undefined => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
    if (!m) return undefined;
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]!);
    return cdata ? cdata[1] : decodeEntities(m[1]!);
  };
  let found = false;
  for (const m of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    found = true;
    out.add(field(m[1]!, 'word'), field(m[1]!, 'trans'), field(m[1]!, 'phonetic'));
  }
  if (!found) throw new Error('XML 解析失败：没有找到 <item> 词条');
  return out.result();
};

/** 常见 XML/HTML 实体解码（不规范的裸 & 原样保留） */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** 去掉 Anki 字段中的 HTML 标签与常见实体 */
function stripHtml(s: string): string {
  // [sound:xxx.mp3] 为 Anki 媒体引用
  return decodeEntities(s.replace(/\[sound:[^\]]*\]/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

/**
 * Anki “导出笔记为纯文本”：
 * - 头部 # 指令：#separator:tab|comma|semicolon|pipe|space、#html:true、#guid column:N、#notetype column:N、#deck column:N、#tags column:N
 * - 指令声明的元数据列需跳过，剩余列中第 1 列为单词（正面），第 2 列为释义（背面）
 */
const parseAnki: WordListParser = (text) => {
  const SEPARATORS: Record<string, string> = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' };
  let delimiter = '\t';
  const metaCols = new Set<number>();
  const body: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = /^#(\w+)(?: column)?:(.*)$/.exec(line);
    if (!m) {
      body.push(line);
      continue;
    }
    const [, key, value = ''] = m;
    if (key === 'separator') delimiter = SEPARATORS[value.trim().toLowerCase()] ?? (value.trim() || '\t');
    else if (key && ['guid', 'notetype', 'deck', 'tags'].includes(key)) metaCols.add(Number(value) - 1);
  }
  const out = collector();
  parseDelimited(body.join('\n'), delimiter).forEach((row, i) => {
    const fields = row.filter((_, idx) => !metaCols.has(idx)).map(stripHtml);
    if (fields.every((f) => !f.trim())) return out.skip();
    out.add(fields[0], fields[1], undefined, i + 1);
  });
  return out.result();
};

const PARSERS: Record<ImportFormat, WordListParser> = {
  txt: parseTxt,
  // 扩展名为 csv 但实际可能是分号/tab 分隔
  csv: (t) => parseTable(t, guessDelimiter(t, ',')),
  tsv: (t) => parseTable(t, '\t'),
  'youdao-xml': parseYoudaoXml,
  // 欧路导出的 CSV/TXT：表头列名识别，分隔符按首行猜测
  eudic: (t) => parseTable(t, guessDelimiter(t)),
  anki: parseAnki,
};
