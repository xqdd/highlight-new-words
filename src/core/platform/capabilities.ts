/**
 * 运行时能力探测：同一份代码在 Chrome / Edge（service worker 后台）与 Firefox（事件页后台）上运行，
 * 对“可能不存在”的能力统一在这里探测，调用方按结果降级，而不是各处写 `?.`/`typeof`。
 *
 * Firefox 最低版本 140（见 platform/manifest.ts）下，以下能力按 MDN 兼容数据均可用，探测主要用于：
 * - Firefox 的 `tts` 扩展 API 不存在；
 * - Firefox for Android 的 `storage.sync` 只存本机、不与 Mozilla 账号同步；
 * - 内容脚本中 `storage.session` 默认不可访问（两端一致，只能在扩展页面/后台使用）；
 * - 测试环境（Node/jsdom）缺少 Web Locks、CompressionStream 等。
 */
import { browser } from 'wxt/browser';

export type BrowserFamily = 'chrome' | 'edge' | 'firefox';

export interface PlatformCapabilities {
  browser: BrowserFamily;
  /** 移动端（Edge Android / Firefox for Android 等）：用于提示“同步不跨设备”、隐藏桌面专属入口 */
  mobile: boolean;
  /** 扩展 tts API（chrome.tts） */
  extensionTts: boolean;
  /** Web Speech 朗读（speechSynthesis），Chrome 的 service worker 中为 false */
  speechSynthesis: boolean;
  /** storage.session（内容脚本中默认不可用） */
  storageSession: boolean;
  /** storage.sync 是否存在 */
  storageSync: boolean;
  /** storage.sync 是否真正跨设备同步（Firefox for Android 为 false：数据只存本机） */
  storageSyncRoams: boolean;
  /** CompressionStream / DecompressionStream 且支持 'deflate-raw'（同步编码依赖） */
  deflateRaw: boolean;
  /** Web Locks（navigator.locks），storage 读改写互斥依赖 */
  webLocks: boolean;
  /** requestIdleCallback（内容引擎分片调度） */
  idleCallback: boolean;
  /** Element.attachShadow（释义卡片） */
  shadowDom: boolean;
}

/**
 * 浏览器家族：构建期 `import.meta.env.FIREFOX` 区分 firefox 产物；
 * Edge 与 Chrome 共用 chrome 产物，只能按 UA（`Edg/`、Android 上 `EdgA/`）区分。
 */
export function getBrowserFamily(): BrowserFamily {
  if (import.meta.env.FIREFOX) return 'firefox';
  const ua = globalThis.navigator?.userAgent ?? '';
  return /\bEdg(A|iOS)?\//.test(ua) ? 'edge' : 'chrome';
}

export function isMobilePlatform(): boolean {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { mobile?: boolean } }) | undefined;
  if (typeof nav?.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent ?? '');
}

function supportsDeflateRaw(): boolean {
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return false;
  try {
    // 旧实现只支持 gzip/deflate，构造不支持的格式会抛 TypeError
    new CompressionStream('deflate-raw');
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

/** 探测当前上下文的能力（同步、无副作用，可在任意上下文调用） */
export function detectCapabilities(): PlatformCapabilities {
  const g = globalThis as {
    speechSynthesis?: unknown;
    requestIdleCallback?: unknown;
    navigator?: { locks?: unknown };
    Element?: { prototype: { attachShadow?: unknown } };
  };
  const b = browser as unknown as {
    tts?: { speak?: unknown };
    storage?: { session?: { get?: unknown }; sync?: { get?: unknown } };
  };
  const family = getBrowserFamily();
  const mobile = isMobilePlatform();
  const storageSync = typeof b.storage?.sync?.get === 'function';
  return {
    browser: family,
    mobile,
    extensionTts: typeof b.tts?.speak === 'function',
    speechSynthesis: !!g.speechSynthesis,
    storageSession: typeof b.storage?.session?.get === 'function',
    storageSync,
    storageSyncRoams: storageSync && !(family === 'firefox' && mobile),
    deflateRaw: supportsDeflateRaw(),
    webLocks: !!g.navigator?.locks,
    idleCallback: typeof g.requestIdleCallback === 'function',
    shadowDom: typeof g.Element?.prototype.attachShadow === 'function',
  };
}
