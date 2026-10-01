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

/** markKnown 结果：熟词已写入；deleteOnKnown 开启时附带删除来源词的结果 */
export interface MarkKnownResult {
  ok: boolean;
  /** 写入熟词本的原形 */
  lemma: string;
  /** 未开启 deleteOnKnown 或没有可删除的来源时为空数组 */
  deleted: SourceDeleteReport[];
  message: string;
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
  /** 从来源生词本删除单词（卡片“从生词本删除”）：bookIds 不传则为包含该词的全部可删除来源词书；forms=true 时按原形删除全部词形 */
  deleteSourceWords(data: { word: string; bookIds?: BookId[]; forms?: boolean }): DeleteWordsResult;

  // ---- 熟词 ----
  /**
   * 标记熟词：写入熟词本（lemma）；若某来源开启 deleteOnKnown 且支持删除，
   * 在该来源各词书中删除与 lemma 原形相同的所有词形（远端 + 本地缓存）。word 为页面原词，仅用于日志/提示。
   */
  markKnown(data: { word: string; lemma: string }): MarkKnownResult;
  /**
   * 撤销熟词（卡片“撤销”、熟词本管理）。若 10 分钟内 markKnown 因 deleteOnKnown 删除过来源单词，
   * 且 provider 支持加词（有道、欧路 OpenAPI），会把这些词加回来源生词本，restored 为加回的单词（小写）。
   */
  unmarkKnown(data: { lemma: string }): { ok: boolean; restored?: string[]; message?: string };

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
