/**
 * 搭配义覆盖：单词在固定搭配中的短释义与词典首选义不同（vicious cycle 的 vicious 是“恶性的”，不是“恶毒的”；
 * concrete structures 的 concrete 是“混凝土”，不是“具体的”）。
 *
 * 行内短释义按原形一词一义（`DictEntry.short`），无法区分语境。engine 在显示某个生词的行内译文时，
 * 用它前后相邻的单词（小写原形，跨空白、不跨标点）调用 {@link collocationShort}，命中则改用搭配义。
 * 表中只收新闻/科普/网页中高频、且首选义会明显误导的搭配；不追求覆盖全部短语。
 */

/** [生词原形, 相邻词原形, 相邻词在左(prev)还是右(next), 搭配中的短释义] */
type CollocationRow = readonly [word: string, neighbor: string, side: 'prev' | 'next', short: string];

const ROWS: readonly CollocationRow[] = [
  // 形容词 + 名词
  ['vicious', 'cycle', 'next', '恶性的'],
  ['vicious', 'circle', 'next', '恶性的'],
  ['real', 'estate', 'next', '房地产'],
  ['estate', 'real', 'prev', '房地产'],
  ['deliberate', 'decision', 'next', '审慎的'],
  ['deliberate', 'process', 'next', '审慎的'],
  ['token', 'gesture', 'next', '象征性的'],
  ['net', 'income', 'next', '净的'],
  ['net', 'profit', 'next', '净的'],
  ['net', 'worth', 'next', '净的'],
  ['gross', 'domestic', 'next', '总的'],
  // 名词 + 名词（前一个词决定义项）
  ['concrete', 'structure', 'next', '混凝土'],
  ['concrete', 'wall', 'next', '混凝土'],
  ['concrete', 'floor', 'next', '混凝土'],
  ['concrete', 'slab', 'next', '混凝土'],
  ['concrete', 'block', 'next', '混凝土'],
  ['concrete', 'building', 'next', '混凝土'],
  ['concrete', 'road', 'next', '混凝土'],
  ['concrete', 'pour', 'next', '混凝土'],
  ['surge', 'storm', 'prev', '风暴潮'],
  ['community', 'plant', 'prev', '群落'],
  ['community', 'microbial', 'prev', '群落'],
  ['community', 'ecological', 'prev', '群落'],
  ['interest', 'rate', 'next', '利率'],
  ['stock', 'market', 'next', '股票'],
  ['stock', 'price', 'next', '股价'],
  ['credit', 'card', 'next', '信用'],
  ['power', 'plant', 'prev', '发电厂'],
  ['plant', 'power', 'prev', '发电厂'],
  ['plant', 'nuclear', 'prev', '核电站'],
  ['plant', 'manufacturing', 'prev', '工厂'],
  ['cell', 'phone', 'next', '手机'],
  ['cell', 'solar', 'prev', '电池'],
  ['cell', 'fuel', 'prev', '电池'],
  ['footprint', 'carbon', 'prev', '足迹'],
  ['figure', 'public', 'prev', '人物'],
  ['issue', 'key', 'prev', '问题'],
  // 名词 + 介词 / 介词 + 名词
  ['bulk', 'of', 'next', '大部分'],
  ['fraction', 'of', 'next', '一小部分'],
  ['parallel', 'in', 'prev', '同时'],
  ['drain', 'on', 'next', '消耗'],
  ['means', 'by', 'prev', '方式'],
  ['account', 'on', 'prev', '因为'],
  // 动词 + 小品词（短语动词）
  ['shed', 'light', 'next', '揭示'],
  ['rule', 'out', 'next', '排除'],
  ['carry', 'out', 'next', '执行'],
  ['figure', 'out', 'next', '弄清'],
  ['turn', 'out', 'next', '结果是'],
  ['point', 'out', 'next', '指出'],
  ['run', 'out', 'next', '用完'],
  ['set', 'up', 'next', '建立'],
  ['break', 'down', 'next', '分解'],
  ['phase', 'out', 'next', '逐步淘汰'],
  ['account', 'for', 'next', '占'],
  ['result', 'in', 'next', '导致'],
  ['result', 'from', 'next', '源于'],
  ['stem', 'from', 'next', '源于'],
  ['opt', 'out', 'next', '退出'],
  ['call', 'for', 'next', '呼吁'],
  ['give', 'up', 'next', '放弃'],
  ['take', 'place', 'next', '发生'],
  ['take', 'over', 'next', '接管'],
  ['look', 'forward', 'next', '期待'],
  ['come', 'across', 'next', '偶遇'],
  ['pick', 'up', 'next', '拿起'],
];

const TABLE: ReadonlyMap<string, string> = new Map(ROWS.map(([w, n, side, s]) => [`${w}|${side}|${n}`, s]));

/**
 * 搭配义：word 为生词小写原形，prev/next 为左右相邻单词的小写原形（无则省略）。
 * 右侧搭配优先（短语动词、名词修饰多由后一个词决定），都不命中返回 undefined，调用方回退到 `DictEntry.short`。
 */
export function collocationShort(word: string, prev?: string, next?: string): string | undefined {
  return (next && TABLE.get(`${word}|next|${next}`)) || (prev && TABLE.get(`${word}|prev|${prev}`)) || undefined;
}
