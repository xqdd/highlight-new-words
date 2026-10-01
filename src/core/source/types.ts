import type { SourceSettings } from '../settings/schema';
import type { UserWord, UserWordMap } from '../wordbook/types';

/**
 * 生词本来源（source provider）契约。
 *
 * 一个来源（有道、欧路……）下可以有多个远端生词本，每个远端生词本同步为一本独立的来源词书
 * （id 为 `src:<providerId>:<remoteId>`，见 wordbook/ids.ts），各自存储与同步。
 *
 * 分两层：
 * - SourceProviderInfo：静态描述（id/名称/能力/登录页），任何上下文可用（UI 展示用），登记在 providers.ts
 * - SourceProvider：网络实现，仅在 background 中运行（依赖 host_permissions 跨域 fetch 携带 cookie），
 *   实现位于 src/background/sources/，新增来源只需实现此接口并在 background/sources/index.ts 注册
 */

export interface SourceCapabilities {
  /** 是否支持删除远端单词（决定卡片“从生词本删除”与 deleteOnKnown 是否可用） */
  delete: boolean;
  /** 是否支持多个生词本（false 时 listRemoteBooks 固定返回一本） */
  multiBook: boolean;
  /** 是否依赖用户在浏览器中登录来源网站的 cookie */
  requiresCookie: boolean;
  /** 是否支持（可选的）API token 鉴权，UI 据此显示 token 输入框 */
  apiToken: boolean;
}

export interface SourceProviderInfo {
  id: string;
  /** 显示名，如“有道词典” */
  name: string;
  capabilities: SourceCapabilities;
  /** 登录页（UI “登录”按钮打开） */
  loginUrl: string;
  /** 获取 API token 的页面（capabilities.apiToken 为 true 时） */
  tokenUrl?: string;
}

/** 远端生词本描述（listRemoteBooks 返回） */
export interface RemoteBook {
  /** provider 内唯一 id（如欧路分类 id），会被编码进本地词书 id */
  remoteId: string;
  name: string;
  /** 远端报告的词数（可选，仅展示） */
  size?: number;
}

/** provider 调用上下文：该来源的用户设置（含可选 apiToken） */
export interface SourceContext {
  settings: SourceSettings;
}

/** 远端删除结果：逐词成功/失败，便于部分成功时只移除成功的本地缓存 */
export interface RemoteDeleteResult {
  deleted: string[];
  failed: { word: string; error: string }[];
}

/** provider 网络实现（background 专用） */
export interface SourceProvider extends SourceProviderInfo {
  /** 列出远端生词本；multiBook=false 的来源固定返回一本 */
  listRemoteBooks(ctx: SourceContext): Promise<RemoteBook[]>;
  /**
   * fetchWords 返回空时是否已确认登录有效（如有道会在空结果时查询登录状态，未登录则抛 auth）。
   * true 时空结果提示“生词本为空”；否则沿用旧版“若实际有内容，请尝试重新登录”。
   */
  readonly verifiesLoginOnEmpty?: boolean;
  /** 拉取某个远端生词本的全部单词（带音标/释义），key 为小写单词 */
  fetchWords(remoteBookId: string, ctx: SourceContext): Promise<UserWordMap>;
  /**
   * 删除远端单词（capabilities.delete=false 的 provider 抛错即可）。
   * words 为本地缓存中的词条（含 ref 删除句柄）。
   */
  deleteWords(remoteBookId: string, words: UserWord[], ctx: SourceContext): Promise<RemoteDeleteResult>;
  /**
   * 可选：把单词加回远端生词本（用于“撤销熟词”时恢复 deleteOnKnown 删掉的词）。
   * 返回成功加入的词条（ref 为远端新的删除句柄，如有道新 itemId）；未实现的 provider 撤销时不恢复远端。
   */
  addWords?(remoteBookId: string, words: UserWord[], ctx: SourceContext): Promise<UserWord[]>;
}

/** 来源错误：message 为给用户看的中文提示；code=auth 时 UI 引导去登录；code=ratelimit 表示被来源限流，应稍后再试 */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly code: 'network' | 'auth' | 'ratelimit' | 'empty' | 'unsupported' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
