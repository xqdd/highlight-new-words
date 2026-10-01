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
  /** 命中的词书里实际记的词（生词本记的 running；内置词书记的就是原形），与页面词形不同时卡片标出“生词 xx” */
  bookWords?: string[];
  /** 生词本自带的释义（先按原形、再按生词本里实际记的词查）；undefined 表示没有或设置关闭了显示 */
  userTrans?: string;
  /** 命中的词书（按优先级） */
  books: BookMeta[];
  /** 释义；undefined 表示加载中或无释义 */
  entry?: DictEntry;
  /** 命中的、且 provider 支持删除的来源词书（非空时显示“从生词本删除”） */
  deletableBooks: BookMeta[];
  /**
   * 可选：该词是否已在“加入生词本”的默认目标中。不传时卡片自己通过 background `getWordState` 查询
   * （card 第二阶段起“加入生词本”由卡片直接调用 background，见 word-actions.ts）。
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
  /**
   * 撤销熟词。可返回 background `unmarkKnown` 的结果（含“已加回 …/无法加回 …”说明），卡片用其 message 作为 toast；
   * 返回 void 时卡片显示通用文案。
   */
  unmarkKnown(lemma: string): Promise<void | { ok: boolean; restored?: string[]; message?: string }>;
  /** 从来源生词本删除（lemma 为命中词条；bookIds 为 deletableBooks 的 id） */
  deleteFromSources(lemma: string, bookIds: string[]): Promise<DeleteWordsResult>;
  /**
   * @deprecated card 第二阶段起卡片直接调用 background 的 addWord/removeWord（支持临时目标、撤销），不再使用该回调；保留仅为类型兼容。
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
  /**
   * 可选（v11 card 新增）：在已打开的卡片内显示一行一次性提示（如当前触发方式），卡片关闭或用户点“知道了”后消失。
   * 由 bindCardTrigger 在 PC 端卡片首次出现时调用；未实现时不提示。
   */
  showHint?(text: string): void;
  /**
   * 可选（card 修复轮新增）：在页面底部显示一条与卡片操作同款的结果 toast（不需要卡片打开），
   * 用于右键菜单“加入生词本/标为熟词”等后台发起的操作结果（ContentProtocol.actionNotice）。
   * message 按“；”分段：第一段为主行，其余折叠在“详情”；ok=false 用失败样式；lemma 用于主行前缀「lemma」。
   */
  showMessage?(message: string, ok: boolean, lemma?: string): void;
  destroy(): void;
}
