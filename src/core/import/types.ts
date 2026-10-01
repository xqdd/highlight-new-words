import type { UserWord } from '../wordbook/types';

/**
 * 词表导入契约：本地导入词书与熟词本导入共用。
 *
 * 解析在扩展页面（options）中进行（XML 依赖 DOMParser，service worker 中不可用）。
 * 新增格式：在 ImportFormat 加一项，在 parse.ts 的 detectImportFormat / PARSERS 中补齐。
 */
export type ImportFormat =
  /** 一行一词，或“词<分隔符>释义”（分隔符自动识别 tab/逗号/竖线） */
  | 'txt'
  /** 逗号分隔，支持 RFC 4180 引号；首行为表头时按列名识别 单词/音标/释义 列 */
  | 'csv'
  /** tab 分隔，规则同 csv */
  | 'tsv'
  /** 有道单词本导出 XML：<wordbook><item><word/><trans/><phonetic/></item></wordbook> */
  | 'youdao-xml'
  /** 欧路生词本导出（CSV/TXT，表头含“单词/音标/解释”等列；无表头时按 词,释义） */
  | 'eudic'
  /** Anki “导出笔记为纯文本”：tab 分隔，# 开头为指令行（#separator:tab 等），字段可含 HTML，首字段为单词 */
  | 'anki';

/** 解析时可传 'auto' 自动识别（按扩展名 + 内容嗅探） */
export type ImportFormatOption = ImportFormat | 'auto';

/** 格式枚举（UI 下拉用） */
export const IMPORT_FORMATS: { value: ImportFormatOption; label: string; accept: string }[] = [
  { value: 'auto', label: '自动识别', accept: '.txt,.csv,.tsv,.xml' },
  { value: 'txt', label: 'TXT（一行一词 / 词+释义）', accept: '.txt' },
  { value: 'csv', label: 'CSV', accept: '.csv,.txt' },
  { value: 'tsv', label: 'TSV', accept: '.tsv,.txt' },
  { value: 'youdao-xml', label: '有道导出 XML', accept: '.xml' },
  { value: 'eudic', label: '欧路导出（CSV/TXT）', accept: '.csv,.txt' },
  { value: 'anki', label: 'Anki 导出纯文本', accept: '.txt' },
];

export interface ImportInput {
  text: string;
  /** 文件名，用于自动识别格式 */
  fileName?: string;
  format?: ImportFormatOption;
}

export interface ImportResult {
  /** 实际使用的格式（auto 时为识别结果） */
  format: ImportFormat;
  /** 规范化后的词条，按小写单词去重（后出现的覆盖前者） */
  words: UserWord[];
  /** 被跳过的行数（空行、注释、非英文单词等） */
  skipped: number;
  /** 给用户看的提示（如“第 3 行无法解析”），最多若干条 */
  warnings: string[];
}

/** 词表解析器：纯函数，无副作用 */
export type WordListParser = (text: string) => Omit<ImportResult, 'format'>;
