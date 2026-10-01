import { defineConfig } from 'wxt';
import { patchFirefoxManifest } from './src/core/platform/manifest';

/**
 * WXT 构建配置。
 *
 * 并行构建约定：设置环境变量 OUT_DIR 可改变构建输出根目录（默认 `.output`），
 * 产物位于 `${OUT_DIR}/chrome-mv3`（dev 模式为 `chrome-mv3-dev`，edge 为 `edge-mv3`）。
 * 多个 agent 并行构建时各自使用不同 OUT_DIR，避免互相覆盖，例如：
 *   OUT_DIR=/tmp/gauntlet/out/engine npm run build
 */
export default defineConfig({
  srcDir: 'src',
  outDir: process.env.OUT_DIR || '.output',
  modules: ['@wxt-dev/module-vue'],
  // 关闭自动导入：所有依赖显式 import，便于并行开发时 grep 定位与各模块边界清晰
  imports: false,
  // 不自动打开浏览器（WSL/无头环境下 dev 更稳定）
  webExt: { disabled: true },
  manifest: {
    name: '__MSG_appName__',
    description: '__MSG_appDesc__',
    default_locale: 'zh_CN',
    // storage: 设置/生词本；tts: 发音；tabs: 徽章计数与当前页状态
    // unlimitedStorage: 云端生词本与熟词本可能很大，超出 local 默认 10MB 配额
    // 不申请 cookies：有道/欧路请求用 fetch credentials:'include'，浏览器凭 host 权限自动带登录 cookie（background 第 3 轮实测去掉后同步正常）
    permissions: ['storage', 'unlimitedStorage', 'tts', 'tabs'],
    // 同步有道/欧路生词本需要跨域携带 cookie；内容脚本需在所有页面运行
    host_permissions: ['http://*/*', 'https://*/*', 'file://*/*'],
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      64: 'icons/64.png',
      128: 'icons/128.png',
    },
    action: {
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        64: 'icons/64.png',
        128: 'icons/128.png',
      },
    },
    // 内置词书/词典数据由内容脚本直接 fetch（请求源为页面），需声明为可访问资源
    web_accessible_resources: [
      { resources: ['data/*'], matches: ['<all_urls>'] },
    ],
  },
  // 所有目标统一 MV3：WXT 对 firefox 默认产出 MV2，这里固定为 MV3（Firefox 后台自动转为 background.scripts 事件页）。
  // Firefox 产物仅用于开发调试（npm run build:firefox），暂不上架 AMO，见 docs/release.md
  manifestVersion: 3,
  // gecko id 与 data_collection_permissions 由下方 hooks 注入（WXT 在钩子之前检查，会误报），关闭这两条提示
  suppressWarnings: { firefoxDataCollection: true, firefoxId: true },
  hooks: {
    // 目标浏览器专有的 manifest 字段（release 模块）：firefox 补 gecko id/最低版本/数据收集声明并去掉不支持的 tts 权限
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.browser === 'firefox') patchFirefoxManifest(manifest as Parameters<typeof patchFirefoxManifest>[0]);
    },
  },
});
