import type { SiteAdapter, SiteContext } from './types';
import { youtubeAdapter } from './youtube';

export type { SiteAdapter, SiteContext } from './types';

/** 已注册的站点适配层（新增站点在这里追加） */
const ADAPTERS: SiteAdapter[] = [youtubeAdapter];

/**
 * 启动匹配当前页面的站点适配层（入口在引擎启动前调用一次，以便跳过规则在首次扫描前生效）。
 * 适配层内部按 ctx.isActive() 与各自的设置项实时判断是否工作，设置变化无需重启。
 */
export function startSiteAdapters(ctx: SiteContext, hostname = location.hostname): () => void {
  const stops = ADAPTERS.filter((a) => a.matches(hostname)).map((a) => a.start(ctx));
  return () => stops.forEach((stop) => stop());
}
