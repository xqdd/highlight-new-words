/**
 * 动态注册内容脚本/样式（scripting.registerContentScripts）的跨浏览器垫片。
 *
 * - Chrome / Edge（MV3）：需要 `scripting` 权限；注册默认 persistAcrossSessions=true，浏览器重启、扩展更新后仍在。
 * - Firefox（MV3，最低 140）：同样支持 registerContentScripts / getRegisteredContentScripts / unregisterContentScripts，
 *   但不同版本对 persistAcrossSessions 的支持与默认值有差异，所以调用方应在每次后台启动时按设置重新对齐一次（见 syncRegisteredCss），
 *   不依赖注册是否被持久化。
 * - API 不存在（测试环境、未来移动端裁剪）时静默跳过，调用方按“未注册”处理。
 */
import { browser } from 'wxt/browser';

/** 动态注册的纯样式内容脚本（只注入 CSS 文件，不注入 JS） */
export interface DynamicCssScript {
  /** 注册 id（扩展内唯一，不能以 `_` 开头） */
  id: string;
  /** 扩展包内的 CSS 文件路径（如 `/prehide.css`，对应 public/ 下的文件） */
  css: string[];
  matches: string[];
  runAt: 'document_start' | 'document_end' | 'document_idle';
  allFrames: boolean;
}

interface ScriptingApiLike {
  registerContentScripts(scripts: DynamicCssScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  updateContentScripts?(scripts: DynamicCssScript[]): Promise<void>;
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<{ id: string }[]>;
}

/** 当前环境的 scripting 动态注册 API；不存在时返回 undefined */
function scriptingApi(): ScriptingApiLike | undefined {
  const s = (browser as unknown as { scripting?: Partial<ScriptingApiLike> }).scripting;
  return typeof s?.registerContentScripts === 'function' && typeof s.getRegisteredContentScripts === 'function' ? (s as ScriptingApiLike) : undefined;
}

/**
 * 按 enabled 对齐某个动态样式的注册状态（幂等）：需要且未注册时注册，不需要且已注册时注销。
 * 需要且已注册时用 updateContentScripts 原地更新定义（扩展更新后旧注册可能残留旧的 matches/css）；
 * 不用“先注销再注册”：后台每次被唤醒都会对齐一次，注销到重新注册之间加载的页面会漏掉样式。
 * 返回对齐后是否处于注册状态；API 不可用时返回 false。
 */
export async function syncRegisteredCss(script: DynamicCssScript, enabled: boolean): Promise<boolean> {
  const api = scriptingApi();
  if (!api) return false;
  const registered = (await api.getRegisteredContentScripts({ ids: [script.id] })).some((s) => s.id === script.id);
  if (enabled && registered) await api.updateContentScripts?.([script]);
  else if (enabled) await api.registerContentScripts([script]);
  else if (registered) await api.unregisterContentScripts({ ids: [script.id] });
  return enabled;
}
