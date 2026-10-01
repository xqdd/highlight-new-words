import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * release 跨模块事项（/tmp/gauntlet/release/issues.md）的落地回归：
 * - 权限说明表 store/permissions.md 必须覆盖 wxt.config.ts 声明的每一个权限（商店隐私页按此表填写，漏行会导致如实披露缺失）
 * - 已标记 [已修复] 的条目在源码中确实接入了 platform 垫片，防止后续重构把垫片调用改回直接调浏览器 API
 * 这里用源码静态断言而不是挂载组件：被检查的是“接入点是否存在”，行为本身由 release-platform.test.ts 等覆盖。
 */
const read = (path: string) => readFileSync(path, 'utf8');

describe('release: 权限说明表与 manifest 一致', () => {
  const config = read('wxt.config.ts');
  const declared = JSON.parse(
    config.match(/^\s*permissions:\s*(\[[^\]]*\])/m)![1]!.replace(/'/g, '"'),
  ) as string[];
  const table = read('store/permissions.md');

  it('wxt.config 声明了 contextMenus 与 scripting', () => {
    expect(declared).toEqual(expect.arrayContaining(['contextMenus', 'scripting']));
  });

  it.each(declared)('permissions.md 有 `%s` 一行', (perm) => {
    expect(table).toMatch(new RegExp(`^\\| \`${perm}\` \\|`, 'm'));
  });

  it('已删除的 cookies 权限不再出现在表中', () => {
    expect(declared).not.toContain('cookies');
    expect(table).not.toMatch(/^\| `cookies` \|/m);
  });
});

describe('release: 已修复条目的 platform 垫片接入点', () => {
  it('#3 background/tts 用 speakText / getPlatformVoices，不再直接调 browser.tts', () => {
    const src = read('src/background/tts.ts');
    expect(src).toMatch(/speakText\(/);
    expect(src).toMatch(/getPlatformVoices\(/);
    expect(src).not.toMatch(/browser\.tts/);
  });

  it('#5 TtsSection 用 getPlatformVoices，“获取更多声音”仅 chrome 显示', () => {
    const src = read('src/entrypoints/options/sections/TtsSection.vue');
    expect(src).toMatch(/getPlatformVoices\(/);
    expect(src).not.toMatch(/browser\.tts/);
    expect(src).toMatch(/getBrowserFamily\(\) === 'chrome'/);
    expect(src).toMatch(/<a v-if="isChrome"[^>]*speakit/);
  });

  it('#6 popup 与欢迎页接入网站访问权限检测', () => {
    expect(read('src/entrypoints/popup/usePopupData.ts')).toMatch(/hasAllSitesAccess\(/);
    // 授权按钮第一句就是 requestAllSitesAccess（Firefox 要求在用户操作的同步调用栈内发起）
    expect(read('src/entrypoints/popup/App.vue')).toMatch(/async function grantAccess\(\) \{\s*const pending = requestAllSitesAccess\(\);/);
    expect(read('src/entrypoints/options/pages/WelcomeGuide.vue')).toMatch(/<SiteAccessBanner \/>/);
    expect(read('src/entrypoints/options/components/SiteAccessBanner.vue')).toMatch(/hasAllSitesAccess\(/);
  });

  it('#7 SyncSection 读取 storageSyncRoams 并在不跨设备时提示', () => {
    const src = read('src/entrypoints/options/sections/SyncSection.vue');
    expect(src).toMatch(/detectCapabilities\(\)\.storageSyncRoams/);
    expect(src).toMatch(/v-if="!roams"/);
  });

  it('#8 WebDavSection 在点击处理中先 requestOriginAccess', () => {
    const src = read('src/entrypoints/options/sections/WebDavSection.vue');
    expect(src.match(/const granted = requestOriginAccess\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('#9（options 部分）开启有道/欧路来源时 requestDataCollection', () => {
    expect(read('src/entrypoints/options/sections/SourcesSection.vue')).toMatch(/requestDataCollection\(\['authenticationInfo'\]\)/);
  });

  it('FB-2 “更多”页挂载悬浮球与 YouTube 字幕两节', () => {
    const src = read('src/entrypoints/options/pages/MorePage.vue');
    expect(src).toMatch(/<FloatBallSection \/>/);
    expect(src).toMatch(/<YouTubeSection \/>/);
  });
});
