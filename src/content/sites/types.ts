import type { DictEntry } from '@/core/dict/types';
import type { MarkKnownResult } from '@/core/messaging/protocol';
import type { WordMatcher } from '@/core/match/matcher';
import type { Settings } from '@/core/settings/schema';
import type { CardView } from '../card/types';

/**
 * 页面扩展上下文（站点适配层与悬浮球共用，floatball 模块维护，见 architecture.md“悬浮球与站点适配层”）。
 * 通用 engine/card 不认识具体站点；站点特有的范围限制、交互与样式由适配层在入口装配时注册，
 * 适配层与悬浮球只通过本上下文访问 app 的状态，不直接改 engine/card 的内部实现。
 * 实现见 context.ts 的 createSiteContext（app.ts 只传入依赖）。
 */
export interface SiteContext {
  doc: Document;
  /** 当前设置（实时值，设置变化后自动是新对象） */
  getSettings(): Settings;
  /** 扩展在本页是否生效（总开关 + 站点禁用） */
  isActive(): boolean;
  /** 卡片视图（引擎启动后才创建，之前为 null） */
  getCard(): CardView | null;
  /**
   * 为锚点元素打开卡片（与通用触发逻辑相同的组装流程：词书、释义、自动发音）。
   * 锚点不必是 hnw-mark：带 `data-lemma`（词条）与 `data-books`（空格分隔的词书 id，可空）属性、文本为页面原词的任意元素均可。
   */
  openCard(anchor: HTMLElement): void;
  /** 批量查短释义（与行内翻译同一个组合词典：用户词书自带释义优先） */
  lookupMany(words: Iterable<string>): Promise<Map<string, DictEntry>>;
  /** 用当前启用词书与熟词本构造一个匹配器（与 engine 同口径；适配层自己的 UI 判断“是否生词”用） */
  createMatcher(): WordMatcher;
  /** 词形还原候选（原词优先，小写），用于给非生词选卡片词条 */
  lemmaCandidates(word: string): string[];
  /** 本页（本 frame）当前高亮的不同词条，按首次出现顺序 */
  pageLemmas(): string[];
  /** 标为熟词：与卡片“认识”同一流程（先乐观移除页面高亮，再由 background markKnown 写入） */
  markKnown(lemma: string, surface: string): Promise<MarkKnownResult>;
  /** 撤销熟词（background unmarkKnown） */
  unmarkKnown(lemma: string): Promise<{ ok: boolean; message?: string }>;
  /** 订阅设置变化（app 读到新设置后回调），返回取消函数 */
  onSettingsChange(cb: (next: Settings) => void): () => void;
}

export interface SiteAdapter {
  readonly id: string;
  /** 是否适用于当前页面（按 hostname 判断） */
  matches(hostname: string): boolean;
  /** 启动适配层，返回停止函数 */
  start(ctx: SiteContext): () => void;
}
