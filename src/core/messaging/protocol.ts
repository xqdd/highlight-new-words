import type { BookId } from '../settings/schema';
import type { SourceBookState } from '../wordbook/types';
import type { SyncStatus } from '../sync/types';

/**
 * 跨上下文消息契约（类型即文档）。
 *
 * - BackgroundProtocol：content/popup/options -> background（runtime.sendMessage）
 * - ContentProtocol：popup/background -> 某个标签页的内容脚本（tabs.sendMessage）
 *
 * 设置、本地导入词书等变更不走消息：扩展页面直接写 storage，其他上下文通过 storage.onChanged 感知。
 * 需要网络（来源同步/删除）或跨数据协调（熟词 + 删除来源词）的操作走 background 消息。
 * 新增消息：在对应 Protocol 接口加一项（参数 -> 返回值），并在接收方 handlers 中实现，TS 会强制补齐。
 */

/** 单本来源词书的同步结果 */
export interface SourceSyncResult {
  bookId: BookId;
  ok: boolean;
  /** 给用户看的提示文案（沿用旧版文案） */
  message: string;
  count?: number;
  /** 请求成功但远端为空（ok=true，本地缓存未被覆盖；background 第 2 轮新增） */
  empty?: boolean;
}

/** 单本来源词书的删词结果 */
export interface SourceDeleteReport {
  bookId: BookId;
  /** 成功删除（远端 + 本地缓存）的词条（小写） */
  deleted: string[];
  /** 失败的词条及原因（本地缓存保留，下次同步保持一致） */
  failed: { word: string; error: string }[];
}

/** 来源删词汇总 */
export interface DeleteWordsResult {
  ok: boolean;
  message: string;
  reports: SourceDeleteReport[];
}

/** 单个写入/移除目标的执行结果（加入生词本、标记熟词写入熟词本等） */
export interface WordTargetResult {
  /** 目标 id：`local:…`、`src:…` 或 LOCAL_KNOWN_BOOK_ID */
  bookId: BookId;
  /** 目标显示名（如“有道 · 无标签”“本地熟词本”） */
  name: string;
  ok: boolean;
  /** 实际写入/移除的单词（小写） */
  words: string[];
  /** 失败或跳过原因（如“欧路 OpenAPI 只提供读取已掌握单词的接口”） */
  error?: string;
  /** true = 因能力不足被跳过（未发请求） */
  skipped?: boolean;
}

/** markKnown 结果：熟词已写入；配置了移除目标（或旧开关 deleteOnKnown）时附带删除生词本中词形的结果 */
export interface MarkKnownResult {
  ok: boolean;
  /** 写入熟词本的原形 */
  lemma: string;
  /** 从来源生词本删除的结果；未配置移除目标或没有可删除的词时为空数组 */
  deleted: SourceDeleteReport[];
  message: string;
  /** 写入各熟词本的结果（background 第 2 轮新增） */
  written?: WordTargetResult[];
  /** 从本地生词本移除的结果（本地移除可完整撤销） */
  removedLocal?: WordTargetResult[];
  /** 撤销时远端删除能否完整恢复：false 时卡片应提示“撤销不会恢复已从来源删除的词”或部分恢复 */
  fullyUndoable?: boolean;
}

/** addWord 结果 */
export interface AddWordResult {
  ok: boolean;
  /** 加入的原形 */
  lemma: string;
  /** 写入各生词本的结果 */
  added: WordTargetResult[];
  /** 从各熟词本移除的结果 */
  removedKnown: WordTargetResult[];
  message: string;
}

/** removeWord 结果（“移出生词本”/撤销加入） */
export interface RemoveWordResult {
  ok: boolean;
  removed: WordTargetResult[];
  message: string;
}

/** 预览中的一个目标 */
export interface WordActionPreviewItem extends WordTargetResult {
  /** 远端操作（来源词书）；删除远端单词无法完全撤销时 undoable=false */
  remote: boolean;
  undoable: boolean;
}

/**
 * 执行前预览（卡片据此在确认框中列出“将从哪些生词本删除哪些词”，尤其是不可恢复的远端删除）。
 * 预览只读本地缓存，不发网络请求；words 为空的目标不列出。
 */
export interface WordActionPreview {
  action: 'add' | 'known';
  lemma: string;
  /** 将写入的目标 */
  write: WordActionPreviewItem[];
  /** 将移除的目标（含各书中将被移除的词形） */
  remove: WordActionPreviewItem[];
  /** 是否包含不可完全撤销的远端删除 */
  needsConfirm: boolean;
}

export interface BackgroundProtocol {
  /**
   * 朗读单词（遵循 settings.tts 的 voice/rate；force=true 时忽略自动发音开关，用于卡片上的发音按钮）。
   * 返回 spoken=false 表示未朗读：reason='disabled' 自动发音关闭；'unavailable' 当前浏览器无 chrome.tts（如部分移动端），
   * 调用方可退回页面内 speechSynthesis。
   */
  tts(data: { text: string; force?: boolean }): { spoken: boolean; reason?: 'disabled' | 'unavailable' | 'error' };

  // ---- 来源生词本 ----
  /** 刷新某来源的远端生词本列表（调用 provider.listRemoteBooks），新发现的书登记到索引（status=never），返回该来源全部书的状态 */
  refreshSourceBooks(data: { providerId: string }): SourceBookState[];
  /**
   * 同步来源词书：bookIds 指定则只同步这些书；否则同步 providerId 下（或全部启用来源下）已登记的全部书。
   * 某来源尚无登记的书时先自动 refreshSourceBooks。各书独立执行，互不影响。
   */
  syncSourceBooks(data: { bookIds?: BookId[]; providerId?: string }): SourceSyncResult[];
  /**
   * 从来源生词本删除单词（卡片“从生词本删除”）：bookIds 不传则为包含该词的全部可删除来源词书；
   * forms=true 时删除该词的屈折词形（runs/ran/running，不含 runner 等派生词，见 background/forms.ts）
   */
  deleteSourceWords(data: { word: string; bookIds?: BookId[]; forms?: boolean }): DeleteWordsResult;

  // ---- 熟词 ----
  /**
   * 标记熟词：按 settings.wordActions.knownTargets 写入熟词本（默认本地熟词本），
   * 按 knownRemoveFrom（'auto' = 各来源 deleteOnKnown）从生词本移除该词；sameLemma 开启时移除屈折词形（不含派生词）。
   * word 为页面原词（同原形开关关闭时也会移除该词形本身）。
   */
  markKnown(data: { word: string; lemma: string }): MarkKnownResult;
  /**
   * 撤销熟词（卡片“撤销”、熟词本管理）：移出本地熟词本；10 分钟内会撤回 markKnown 的其他写入/移除：
   * 本地生词本完整恢复；来源生词本在 provider 可加词时加回（有道非默认分组只能加回默认分组，欧路 cookie 模式无法加回）。
   * restored 为加回的单词（小写）。
   */
  unmarkKnown(data: { lemma: string }): { ok: boolean; restored?: string[]; message?: string };
  /**
   * 加入生词本（卡片收藏按钮、选中文本/右键菜单）：按 settings.wordActions.addTargets 写入（本地词书直接写；
   * 来源词书调用 provider.addWords，不支持加词的跳过并说明），按 addRemoveFromKnown 从熟词本移除该词（及同原形词形）。
   * “我的生词本”（MY_WORDS_BOOK_ID）不存在时自动创建并启用。trans/phonetic 可选，写入本地词书供释义显示。
   */
  addWord(data: { word: string; lemma: string; trans?: string; phonetic?: string }): AddWordResult;
  /** 移出生词本（收藏按钮取消、撤销加入）：bookIds 不传则为 addTargets；10 分钟内撤销加入会把移出的熟词加回 */
  removeWord(data: { lemma: string; bookIds?: BookId[] }): RemoveWordResult;
  /** 执行 addWord / markKnown 前的预览（只读本地缓存），卡片在包含远端删除时据此弹确认 */
  previewWordAction(data: { action: 'add' | 'known'; word: string; lemma: string }): WordActionPreview;
  /** 单词状态：是否已在 addTargets 的某本生词本中（卡片收藏按钮状态）、是否为熟词（含来源熟词本） */
  getWordState(data: { lemma: string }): { collected: boolean; collectedIn: BookId[]; known: boolean };

  // ---- storage.sync ----
  /** 读取跨设备同步状态与用量 */
  getSyncStatus(data: Record<string, never>): SyncStatus;
  /** 立即执行一次拉取合并 + 推送（忽略防抖），返回最新状态 */
  syncNow(data: Record<string, never>): SyncStatus;
  /** 内容脚本上报本 frame 已高亮的不同词条（全量，非增量），用于徽章计数 */
  reportPageWords(data: { lemmas: string[] }): void;
  /** popup 查询某标签页已高亮的不同词条（合并所有 frame） */
  getTabWords(data: { tabId: number }): { lemmas: string[] };
}

export interface PageState {
  /** 当前页是否在高亮（总开关 + 站点未禁用） */
  active: boolean;
  hostname: string;
  /** 本 frame 已高亮的不同词条数 */
  matchedCount: number;
}

export interface ContentProtocol {
  /** 查询页面状态（仅顶层 frame 应答） */
  getPageState(data: Record<string, never>): PageState;
}

type Proto = object;
export type MsgType<P extends Proto> = Extract<keyof P, string>;
export type MsgData<P extends Proto, K extends MsgType<P>> = P[K] extends (data: infer D) => unknown ? D : never;
export type MsgReturn<P extends Proto, K extends MsgType<P>> = P[K] extends (...args: never[]) => infer R ? R : never;

/** 线上消息格式；ns 用于和其他扩展/旧消息区分 */
export interface Envelope<K extends string = string, D = unknown> {
  ns: 'hnw';
  type: K;
  data: D;
}

/** 响应格式：handler 抛错时返回 error，发送方重新抛出 */
export type ResponseEnvelope<R> = { ok: true; result: R } | { ok: false; error: string };
