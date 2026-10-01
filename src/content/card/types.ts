import type { DictEntry } from '@/core/dict/types';
import type { DeleteWordsResult, MarkKnownResult } from '@/core/messaging/protocol';
import type { CardStyle } from '@/core/theme/themes';
import type { BookMeta } from '@/core/wordbook/types';

/** 卡片展示数据（engine/入口组装，card 只负责渲染） */
export interface CardData {
  /** 页面上的原词 */
  surface: string;
  /** 命中的词条 */
  lemma: string;
  /** 命中的词书（按优先级） */
  books: BookMeta[];
  /** 释义；undefined 表示加载中或无释义 */
  entry?: DictEntry;
  /** 命中的、且 provider 支持删除的来源词书（非空时显示“从生词本删除”） */
  deletableBooks: BookMeta[];
  /**
   * 可选：该词是否已在“我的生词本”（收藏）中。undefined 表示入口未接入收藏能力，卡片不显示收藏按钮；
   * 需与 `CardActions.setCollected` 同时提供。
   */
  collected?: boolean;
}

/** 卡片上的用户操作（由入口注入实现） */
export interface CardActions {
  speak(text: string): void;
  /**
   * 标记为熟词（永不高亮）。由 background markKnown 处理：开启 deleteOnKnown 的来源会同步删除原形相同的词形，
   * 结果中的 message 可直接展示（如 toast），并可配合 unmarkKnown 提供“撤销”。
   */
  markKnown(lemma: string, surface: string): Promise<MarkKnownResult>;
  /** 撤销熟词（不恢复已删除的来源单词） */
  unmarkKnown(lemma: string): Promise<void>;
  /** 从来源生词本删除（lemma 为命中词条；bookIds 为 deletableBooks 的 id） */
  deleteFromSources(lemma: string, bookIds: string[]): Promise<DeleteWordsResult>;
  /**
   * 可选：加入（collected=true）/移出“我的生词本”。未注入时卡片不显示收藏按钮。
   * 返回的 message 用于 toast 展示；ok=false 时卡片回滚按钮状态。
   */
  setCollected?(lemma: string, surface: string, collected: boolean): Promise<{ ok: boolean; message?: string }>;
}

/**
 * 卡片视图契约：card 分片可以整体替换实现（如移动端底部抽屉），入口只依赖此接口。
 */
export interface CardView {
  /** 在 anchor（hnw-mark 元素）附近打开卡片 */
  open(anchor: HTMLElement, data: CardData): void;
  /** 更新已打开卡片的数据（如释义异步加载完成） */
  update(data: CardData): void;
  close(): void;
  readonly isOpen: boolean;
  /** 当前锚点元素 */
  readonly anchor: HTMLElement | null;
  /** 事件目标是否位于卡片内（composedPath 判断，用于外部点击关闭） */
  contains(event: Event): boolean;
  setStyle(style: CardStyle): void;
  destroy(): void;
}
