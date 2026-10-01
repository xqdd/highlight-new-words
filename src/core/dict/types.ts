/**
 * 词典查询契约：word（小写原形）-> 音标 + 简短释义 + 完整释义 + 标签。
 * 行内翻译使用 short，卡片展示 short/full。
 */
export interface DictEntry {
  word: string;
  phonetic?: string;
  /** 简短释义：一行，适合行内翻译（如 “v. 放弃；抛弃”） */
  short?: string;
  /** 完整释义：可多行（\n 分隔） */
  full?: string;
  /** 标签，如 ['cet4','cet6','gre']，与词书 id 一致时 UI 可展示为词书徽标 */
  tags?: string[];
  /** CEFR 风格级别 1..6 = A1..C2（A1–B2 来自 CEFR-J，C1/C2 由考试标签与词频推导），见 cefrLabel */
  level?: number;
  /** 词频排名（COCA，缺失时 BNC），越小越常用，可做词频点阵 */
  rank?: number;
  /** 屈折词形（只在完整查询 lookup 中提供），如 [{type:'s', word:'widths'}] */
  forms?: DictForm[];
}

/** 词形类型：p 过去式 d 过去分词 i 现在分词 3 第三人称单数 s 复数 r 比较级 t 最高级 */
export type DictFormType = 'p' | 'd' | 'i' | '3' | 's' | 'r' | 't';
export interface DictForm {
  type: DictFormType;
  word: string;
}
export const DICT_FORM_LABELS: Record<DictFormType, string> = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  '3': '第三人称单数',
  s: '复数',
  r: '比较级',
  t: '最高级',
};

/** 级别数值转标签：4 -> 'B2' */
export function cefrLabel(level: number | undefined): string | undefined {
  return level && level >= 1 && level <= 6 ? (['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const)[level - 1] : undefined;
}

export interface Dictionary {
  /** 单词完整查询（卡片用）：含完整释义 full 与词形 forms */
  lookup(word: string): Promise<DictEntry | undefined>;
  /**
   * 批量查询，结果只包含查到的词；实现应合并同一分片的加载。
   * 打包词典的批量查询只读短表（音标/短释义/标签/级别/词频，不含 full/forms），保证整页行内翻译的加载体积小；
   * 需要完整释义时用 lookup。
   */
  lookupMany(words: Iterable<string>): Promise<Map<string, DictEntry>>;
}

/**
 * 打包词典分片文件结构，shard 为首字母 a-z，其他字符归入 '_'。使用短键名以减小体积。分两层：
 * - 短表 data/dict/<shard>.json：p/s/g/l/r（高亮 + 行内翻译热路径）
 * - 全表 data/dict/full/<shard>.json：f/x（卡片展开时才加载）
 * 旧格式（f 直接在短表中）仍兼容。
 */
export interface PackedDictEntry {
  /** phonetic */
  p?: string;
  /** short translation：行内翻译用的单个义项，不带词性，≤ 8 字（如 “放弃”） */
  s?: string;
  /** full translation：每行一个词性（如 “vt. 放弃, 抛弃\nn. 放任”） */
  f?: string;
  /** 空格分隔标签（考试词书 id） */
  g?: string;
  /** level 1..6 */
  l?: number;
  /** rank 词频排名 */
  r?: number;
  /** exchange 屈折词形，"s:widths/p:went"（ECDICT exchange 格式子集） */
  x?: string;
}
export type DictShardFile = Record<string, PackedDictEntry>;

export function dictShardOf(word: string): string {
  const c = word.charAt(0).toLowerCase();
  return c >= 'a' && c <= 'z' ? c : '_';
}
