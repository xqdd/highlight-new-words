import { isSourceNotConnected, SOURCE_NOT_CONNECTED_TEXT } from '@/core/source/connect-status';
import type { BookRole } from '@/core/settings/schema';
import type { BookMeta } from '@/core/wordbook/types';
import { formatCount, relativeTime } from './books';

/**
 * 来源卡片（生词本页 #sources）顶部摘要的纯计算：状态、标题、副标题、主按钮。
 *
 * - 从未同步成功过的来源统一是中性的“未连接”（口径见 core/source/connect-status，与 popup、悬浮球一致），
 *   不显示红色错误；主按钮是“登录网页版”（填了 token 时是“刷新列表”）。成功过之后再失败才显示红色错误。
 * - 标题按用途分开计数：生词本（高亮）与熟词本（不高亮）各自的本数与词数，用户改用途后随之变化。
 * - 填了 OpenAPI token 的来源不需要网页登录：副标题不再提示登录，隐藏“登录网页版”。
 */
export interface SourceCardInput {
  /** 来源显示名（“有道词典”） */
  name: string;
  /** 该来源下的书（含孤立书） */
  books: BookMeta[];
  roleOf: (b: BookMeta) => BookRole;
  /** 来源级列表刷新错误 */
  listError?: string;
  /** 是否已填写 OpenAPI token（只对支持 token 的来源有意义） */
  hasToken: boolean;
  now?: number;
}

export interface SourceCardSummary {
  /** neutral=未连接 / 尚未同步；ok=同步过；error=同步过后又失败 */
  tone: 'neutral' | 'ok' | 'error';
  title: string;
  subtitle: string;
  /** 主按钮：login=登录网页版，refresh=刷新列表，sync=全部同步 */
  primary: 'login' | 'refresh' | 'sync';
  /** 是否显示“登录网页版”按钮（填了 token 时不需要） */
  showLogin: boolean;
  /** 红色错误（只在 tone=error 时有） */
  error?: string;
  /** 未连接时最近一次失败的原因，灰色辅助文字 */
  hint?: string;
}

export function sourceCardSummary(input: SourceCardInput): SourceCardSummary {
  const { books, hasToken, listError } = input;
  const live = books.filter((b) => !b.sync?.orphaned);
  const lastSync = Math.max(0, ...books.map((b) => b.sync?.lastSyncAt ?? 0));
  const failedBook = live.find((b) => b.sync?.status === 'error');
  const failed = !!listError || !!failedBook;
  const showLogin = !hasToken;

  if (isSourceNotConnected({ lastSyncAt: lastSync, failed, bookCount: live.length })) {
    return {
      tone: 'neutral',
      title: SOURCE_NOT_CONNECTED_TEXT,
      subtitle: hasToken ? '已填写授权 token，点“刷新列表”获取生词本' : `登录${input.name}网页版后，回到这里点“全部同步”`,
      primary: hasToken ? 'refresh' : 'login',
      showLogin,
      hint: neverConnectedHint(input.name, listError || failedBook?.sync?.error),
    };
  }

  const newBooks = books.filter((b) => input.roleOf(b) !== 'known');
  const knownBooks = books.filter((b) => input.roleOf(b) === 'known');
  const sum = (list: BookMeta[]) => list.reduce((n, b) => n + b.size, 0);
  const parts = [`${newBooks.length} 个生词本 · ${formatCount(sum(newBooks))} 词`];
  if (knownBooks.length) parts.push(`${knownBooks.length} 个熟词本 ${formatCount(sum(knownBooks))} 词`);
  const title = parts.join(' · ');

  if (lastSync === 0) {
    // 已列出生词本但还没同步过：点“全部同步”即可
    return { tone: 'neutral', title, subtitle: '还没有同步过，点“全部同步”拉取单词', primary: 'sync', showLogin };
  }
  const subtitle = '上次同步 ' + relativeTime(lastSync, input.now);
  // 成功过之后列表刷新失败（登录过期、token 失效）：真正需要处理的错误
  if (listError) return { tone: 'error', title, subtitle, primary: 'sync', showLogin, error: listError };
  return { tone: 'ok', title, subtitle, primary: 'sync', showLogin };
}

/**
 * 未连接时的灰色辅助说明：后台的鉴权失败原文是“未登录X或登录已失效，请先登录…”（登录过期与从未登录共用一句），
 * 而这里只在从未成功同步过时出现，不可能是“失效”，改写成“没有检测到登录”，避免新用户以为自己之前登录过。
 */
function neverConnectedHint(name: string, reason: string | undefined): string | undefined {
  return reason?.replace(/^未登录\S*?或登录已失效/, `没有检测到${name}网页版的登录`);
}

/**
 * 单本书的状态行（词数 · 时间）：
 * 为空（同步成功但远端没有单词）显示“同步于 …”（按最近尝试时间），不是“从未同步”。
 */
export function bookSyncLine(b: BookMeta, now = Date.now()): string {
  const st = b.sync;
  const count = `${formatCount(b.size)} 词`;
  if (!st) return count;
  if (st.lastSyncAt) return `${count} · ${relativeTime(st.lastSyncAt, now)}`;
  if (st.status === 'empty' && st.lastAttemptAt) return `${count} · 同步于 ${relativeTime(st.lastAttemptAt, now)}`;
  return `${count} · 从未同步`;
}
