import type { DictEntry } from '@/core/dict/types';
import type { Settings } from '@/core/settings/schema';
import type { CardView } from '../card/types';

/**
 * 站点适配层契约（youtube 模块新增，见 architecture.md“站点适配层”）。
 * 通用 engine/card 不认识具体站点；站点特有的范围限制、交互与样式由适配层在入口装配时注册，
 * 适配层只通过本上下文访问 app 的状态，不直接改 engine/card 的内部实现。
 */
export interface SiteContext {
  doc: Document;
  /** 当前设置（实时值，设置变化后自动是新对象） */
  getSettings(): Settings;
  /** 扩展在本页是否生效（总开关 + 站点禁用） */
  isActive(): boolean;
  /** 卡片视图（引擎启动后才创建，之前为 null） */
  getCard(): CardView | null;
  /** 为 mark 打开卡片（与通用触发逻辑相同的组装流程：词书、释义、自动发音） */
  openCard(mark: HTMLElement): void;
  /** 批量查短释义（与行内翻译同一个组合词典：用户词书自带释义优先） */
  lookupMany(words: Iterable<string>): Promise<Map<string, DictEntry>>;
}

export interface SiteAdapter {
  readonly id: string;
  /** 是否适用于当前页面（按 hostname 判断） */
  matches(hostname: string): boolean;
  /** 启动适配层，返回停止函数 */
  start(ctx: SiteContext): () => void;
}
