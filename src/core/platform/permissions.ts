/**
 * 主机权限与数据收集授权（供 options / popup / background 调用）。
 *
 * 背景：
 * - Chrome / Edge：manifest 的 host_permissions 安装时授予，用户可在扩展详情里改成“点击时/特定网站”；
 * - Firefox MV3：host_permissions 是可撤销的，用户在 about:addons 或安装后可能未授予（例如 Android、
 *   以及用户手动关闭“访问所有网站的数据”）。没有授权时内容脚本不会注入，页面不高亮，来源同步请求也会失败。
 *   因此首次引导页和 popup 需要检测，未授予时给出“授权访问所有网站”按钮。
 * - WebDAV 等用户自填服务器：用 `requestOriginAccess(url)` 运行时申请该源。
 *
 * 重要：Firefox 要求 `permissions.request` 在用户操作（click 等）的同步调用栈内发起，
 * 调用前不能有任何 await，否则会抛 “permissions.request may only be called from a user input handler”。
 * 所以本文件的 request* 函数第一步就调用 request，调用方也应在 click 处理函数里直接调用、不要先 await 别的。
 */
import { browser } from 'wxt/browser';

/** “所有网站”对应的源模式（与 manifest host_permissions 中的 http/https 一致；file:// 需用户在浏览器设置中单独开启） */
export const ALL_SITES_ORIGINS = ['http://*/*', 'https://*/*'] as const;

/** Firefox 内置数据收集授权类别（manifest `data_collection_permissions` 中声明为 optional 的项） */
export type DataCollectionType = 'authenticationInfo';

interface PermissionsLike {
  origins?: string[];
  permissions?: string[];
  data_collection?: string[];
}

interface PermissionsApiLike {
  contains(p: PermissionsLike): Promise<boolean>;
  request(p: PermissionsLike): Promise<boolean>;
  getAll(): Promise<PermissionsLike>;
  onAdded?: { addListener(cb: (p: PermissionsLike) => void): void; removeListener(cb: (p: PermissionsLike) => void): void };
  onRemoved?: { addListener(cb: (p: PermissionsLike) => void): void; removeListener(cb: (p: PermissionsLike) => void): void };
}

/** WXT 的 browser 类型来自 @types/chrome，不含 Firefox 专有的 data_collection 字段，这里统一转成宽松类型 */
function api(): PermissionsApiLike {
  return browser.permissions as unknown as PermissionsApiLike;
}

/** 是否已获得访问所有 http/https 网站的权限（未获得时页面不会高亮） */
export function hasAllSitesAccess(): Promise<boolean> {
  return api().contains({ origins: [...ALL_SITES_ORIGINS] }).catch(() => false);
}

/**
 * 申请访问所有网站（必须在用户点击的同步调用栈内调用，见文件头说明）。
 * 已授予时浏览器不弹窗、直接返回 true；用户拒绝返回 false。
 * 授权后已打开的标签页不会自动注入内容脚本，需要刷新页面（调用方提示用户或调用 tabs.reload）。
 */
export function requestAllSitesAccess(): Promise<boolean> {
  return api()
    .request({ origins: [...ALL_SITES_ORIGINS] })
    .catch((e: unknown) => {
      console.warn('[hnw] 申请网站访问权限失败', e);
      return false;
    });
}

/**
 * 把 URL 转成只匹配该源的权限模式，如 `https://dav.jianguoyun.com/dav/` → `https://dav.jianguoyun.com/*`。
 * 权限模式不含端口，同主机任意端口均可访问（浏览器规则）。
 */
export function originPatternOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/** 是否可以访问指定 URL 所在的源（WebDAV 服务器、来源接口等） */
export function hasOriginAccess(url: string): Promise<boolean> {
  return api().contains({ origins: [originPatternOf(url)] }).catch(() => false);
}

/** 运行时申请访问指定 URL 所在的源（用户点击时调用；已在 host_permissions 覆盖范围内时直接返回 true） */
export function requestOriginAccess(url: string): Promise<boolean> {
  return api()
    .request({ origins: [originPatternOf(url)] })
    .catch((e: unknown) => {
      console.warn('[hnw] 申请站点权限失败', url, e);
      return false;
    });
}

/**
 * 监听主机权限变化（用户在浏览器设置里授予/撤销），返回取消监听函数。
 * popup/options 可据此即时刷新“未授权”提示。
 */
export function watchHostAccess(onChange: () => void): () => void {
  const p = api();
  const handler = (change: PermissionsLike) => {
    if (change.origins?.length) onChange();
  };
  p.onAdded?.addListener(handler);
  p.onRemoved?.addListener(handler);
  return () => {
    p.onAdded?.removeListener(handler);
    p.onRemoved?.removeListener(handler);
  };
}

/**
 * Firefox 140+ 的内置数据收集授权是否已授予。
 * 非 Firefox（Chrome/Edge 没有该机制）恒为 true；Firefox 上 `permissions.getAll()` 结果里没有 data_collection 键
 * 说明浏览器不支持该机制（不会出现在 strict_min_version=140 的正式安装中），也按 true 处理。
 */
export async function hasDataCollection(types: DataCollectionType[]): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return true;
  const all = await api().getAll().catch(() => ({}) as PermissionsLike);
  if (!all.data_collection) return true;
  return types.every((t) => all.data_collection!.includes(t));
}

/**
 * 申请 Firefox 数据收集授权（用户点击时调用）。
 * 用于开启“有道/欧路生词本来源”前：扩展会把用户的登录 cookie / API token 发给对应服务（authenticationInfo）。
 * 非 Firefox 直接返回 true。
 */
export function requestDataCollection(types: DataCollectionType[]): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return Promise.resolve(true);
  return api()
    .request({ data_collection: types })
    .catch((e: unknown) => {
      console.warn('[hnw] 申请数据收集授权失败', e);
      return false;
    });
}
