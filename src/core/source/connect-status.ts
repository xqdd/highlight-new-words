/**
 * 来源“未连接”状态的统一口径：options 来源卡片、popup 同步行、悬浮球底栏共用同一套文案与级别。
 *
 * - 从未同步成功过（lastSyncAt=0）的来源，不论是还没试过、还是试了但未登录 / token 不可用，都只是“还没连上”，
 *   统一显示中性的“未连接”（StatusLevel=never，灰色），不用红色错误样式，也不计入 popup / 悬浮球的告警。
 *   典型场景：新装扩展后有道默认启用，但用户从没登录过有道网页版。
 * - 同步成功过之后再失败（登录过期、token 失效）才是需要处理的错误（StatusLevel=error）。
 *
 * background 的 sourceItem 按此口径产出 StatusItem，各界面只按 level 选样式、直接展示 text。
 */

/** 未连接的状态文案（状态行 / 徽标） */
export const SOURCE_NOT_CONNECTED_TEXT = '未连接';

/**
 * 是否属于“未连接”：从未成功同步过，且（列表 / 各书刷新失败，或者还没有任何远端生词本）。
 * 已列出生词本但还没点过同步、也没有失败时不算（那是“尚未同步”，点同步即可）。
 */
export function isSourceNotConnected(input: { lastSyncAt: number; failed: boolean; bookCount: number }): boolean {
  return input.lastSyncAt === 0 && (input.failed || input.bookCount === 0);
}
