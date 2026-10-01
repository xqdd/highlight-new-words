/**
 * 各浏览器 manifest 差异（构建期使用，由 wxt.config.ts 的 `build:manifestGenerated` 钩子调用）。
 *
 * 只在这里放“某个目标浏览器专有”的字段，公共字段仍写在 wxt.config.ts 的 manifest 中。
 * 本文件在 Node 构建环境执行，不能引用 `browser`/DOM 等运行时 API。
 */

/**
 * Firefox 扩展 id：MV3 必填（storage.sync 等也依赖固定 id）。目前 Firefox 仅开发调试、暂不上架 AMO；
 * 将来上架时沿用此 id，一经发布不可修改，否则视为新扩展。
 */
export const GECKO_ID = 'highlight-new-words@xqdd';

/**
 * Firefox 最低版本：
 * - 桌面 140：`data_collection_permissions`（内置数据收集授权）从 140 开始支持，140 也是当前 ESR；
 *   低于该版本需要自建授权弹窗，得不偿失
 * - Android 142：同一字段在 Firefox for Android 从 142 开始支持
 * 140+ 已覆盖本项目用到的 storage.session、CompressionStream('deflate-raw')、Web Locks、
 * CSS ruby、`text-decoration-style: wavy` 等能力（核对记录见 docs/release.md）。
 */
export const GECKO_MIN_VERSION = '140.0';
export const GECKO_ANDROID_MIN_VERSION = '142.0';

/** Firefox 不认识的权限：留在 manifest 中会让 web-ext lint 报警告，安装时也会被忽略 */
const FIREFOX_UNSUPPORTED_PERMISSIONS = ['tts'];

interface ManifestLike {
  permissions?: string[];
  browser_specific_settings?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 给 firefox 产物补齐 gecko 设置并剔除不支持的权限（原地修改）。
 *
 * data_collection_permissions 取舍：
 * - 扩展没有开发者自己的服务器，不做统计/遥测，词书匹配全部在本地；
 * - 但用户主动开启“有道/欧路生词本来源”后，后台会按天自动拉取，请求中携带用户的登录 cookie 或欧路 API token，
 *   属于“身份验证信息（authenticationInfo）”传给第三方，且是后台持续传输，不满足隐式同意条件；
 * - 该功能是可选的，所以声明为 optional：安装时不提示；将来上架 AMO 前，需由 options 在用户开启来源的点击中调用
 *   `requestDataCollection(['authenticationInfo'])`（见 platform/permissions.ts），本地调试不受影响。
 * - WebDAV/storage.sync 只把用户自己的设置与词表存到用户自己配置的存储（浏览器账号 / 自建 WebDAV），
 *   不属于向开发者或第三方收集，不单独声明。
 */
export function patchFirefoxManifest(manifest: ManifestLike): void {
  manifest.permissions = manifest.permissions?.filter((p) => !FIREFOX_UNSUPPORTED_PERMISSIONS.includes(p));
  manifest.browser_specific_settings = {
    ...manifest.browser_specific_settings,
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: {
        required: ['none'],
        optional: ['authenticationInfo'],
      },
    },
    gecko_android: {
      strict_min_version: GECKO_ANDROID_MIN_VERSION,
    },
  };
}
