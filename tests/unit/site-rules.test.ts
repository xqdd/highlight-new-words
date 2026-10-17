import { describe, expect, it } from 'vitest';
import { evaluateSiteRules, matchesSiteRule, normalizeSiteRules, setSiteEnabled, siteUrl, validateSiteRule } from '@/core/sites/rules';
import { createDefaultSettings } from '@/core/settings/defaults';
import { normalizeSettings } from '@/core/settings/migrate';
import { isReadingSiteDisabled, isSiteDisabled } from '@/core/settings/store';
import { selectGlobalReadingPreset } from '@/core/reading/presets';

describe('网站黑白名单', () => {
  it('旧域名列表保持包含子域、大小写与尾点兼容，不误匹配相似域名', () => {
    for (const url of ['EXAMPLE.com', 'https://www.example.com/a', 'https://a.b.example.com./']) expect(matchesSiteRule('example.COM', url)).toBe(true);
    expect(matchesSiteRule('example.com', 'https://notexample.com')).toBe(false);
    expect(matchesSiteRule('domain:example.com', 'https://example.com.evil.test')).toBe(false);
    expect(matchesSiteRule('domain:例子.测试', 'https://例子.测试/')).toBe(true);
    expect(matchesSiteRule('localhost', 'http://localhost:8080/a')).toBe(true);
  });

  it('域名通配与完整 URL 通配有明确作用范围，路径和查询区分大小写', () => {
    expect(matchesSiteRule('glob:*.example.com', 'https://news.example.com/ANY/path')).toBe(true);
    expect(matchesSiteRule('glob:*.example.com', 'https://example.com')).toBe(false);
    expect(matchesSiteRule('glob:https://*.EXAMPLE.com/News/*', 'https://news.example.com/News/article')).toBe(true);
    expect(matchesSiteRule('glob:https://*.EXAMPLE.com/News/*', 'https://news.example.com/News/nested/article')).toBe(false);
    expect(matchesSiteRule('glob:*://example.com/News/**', 'http://example.com/News/nested/article')).toBe(true);
    expect(matchesSiteRule('glob:*://example.com/News/**', 'https://example.com/news/nested/article')).toBe(false);
    expect(matchesSiteRule('glob:https://example.com/?q=Word*', 'https://example.com/?q=Words#ignored')).toBe(true);
    expect(matchesSiteRule('glob:https://example.com/?q=Word*', 'https://example.com/?q=words')).toBe(false);
    expect(matchesSiteRule('glob:https://example.com/', 'https://user:password@example.com/#hash')).toBe(true);
    expect(matchesSiteRule('glob:https://例子.测试/文章/**?q=中文', 'https://例子.测试/文章/一?q=中文')).toBe(true);
    expect(matchesSiteRule('glob:https://*.例子.测试/**', 'https://新闻.例子.测试/文章')).toBe(true);
    expect(matchesSiteRule('glob:*.例子.测试', 'https://新闻.例子.测试/文章')).toBe(true);
    expect(matchesSiteRule('glob:https://api*.example.com/**', 'https://api2.example.com/a')).toBe(true);
    expect(matchesSiteRule('glob:*://example.com:443/**', 'http://example.com:443/a')).toBe(true);
    expect(matchesSiteRule('glob:*://example.com:443/**', 'https://example.com/a')).toBe(true);
    expect(matchesSiteRule('glob:*://example.com:443/**', 'http://example.com/a')).toBe(false);
  });

  it('正则按声明保留大小写与 flags，忽略 hash 但保留 query', () => {
    expect(matchesSiteRule('regex:/News/', 'https://example.com/News')).toBe(true);
    expect(matchesSiteRule('/News/', 'https://example.com/news')).toBe(false);
    expect(matchesSiteRule('/News/i', 'https://example.com/news')).toBe(true);
    expect(matchesSiteRule('/[A-Z]+/i', 'https://example.com/news')).toBe(false); // 不锚定的无界重复被拒绝。
    expect(matchesSiteRule('/^https?:\/\/example\.com\/News/u', 'https://example.com/News?q=1')).toBe(true);
    expect(matchesSiteRule('/hash/', 'https://example.com/#hash')).toBe(false);
    expect(matchesSiteRule('/q=Word/', 'https://example.com/?q=Word')).toBe(true);
  });

  it('无效与可能回溯的正则不会执行，超长 URL 不进入正则', () => {
    for (const rule of ['/([a-z]+)+$/', '/^a*a*$/', '/^a{1,999999}$/', '/(a|aa)+$/', '/[/', '/a/g', '/a/ii', '/^a\\1/', '/a+/']) {
      expect(validateSiteRule(rule), rule).toBeTruthy();
      expect(() => matchesSiteRule(rule, `https://example.com/${'a'.repeat(8000)}!`)).not.toThrow();
      expect(matchesSiteRule(rule, 'https://example.com/')).toBe(false);
    }
    expect(validateSiteRule('/^https?:\/\/[^/]+\/News/')).toBeUndefined();
    expect(matchesSiteRule('/^https:/', `https://example.com/${'a'.repeat(9000)}`)).toBe(false);
    expect(validateSiteRule('a'.repeat(257))).toBeTruthy();
    expect(validateSiteRule('glob:https://example.com/#hash')).toBeTruthy();
    expect(validateSiteRule('domain:example.com:443')).toBeTruthy();
    for (const rule of ['glob:https://%2A.example.com/**', 'glob:%2A.example.com', 'glob:https://新*闻.测试/**', 'glob:新*闻.测试']) expect(validateSiteRule(rule)).toBeTruthy();
  });

  it('重复通配以有界动态规划匹配，失败输入不会指数回溯', () => {
    const rule = `glob:https://example.com/${'*a'.repeat(70)}b`;
    expect(matchesSiteRule(rule, `https://example.com/${'a'.repeat(500)}!`)).toBe(false);
    expect(matchesSiteRule('glob:https://example.com/**/file*', 'https://example.com/a/b/file1')).toBe(true);
  });

  it('黑名单优先，白名单模式缺省拒绝，手动开关在白名单模式补允许域名', () => {
    const sites = { mode: 'allowlist' as const, allowed: ['glob:https://example.com/allowed/**'], disabled: ['glob:https://example.com/**/blocked'] };
    expect(evaluateSiteRules(sites, 'https://example.com/allowed/page').disabled).toBe(false);
    expect(evaluateSiteRules(sites, 'https://example.com/allowed/blocked').disabled).toBe(true);
    expect(evaluateSiteRules(sites, 'https://other.test/').disabled).toBe(true);
    const enabled = setSiteEnabled(sites, 'https://other.test/path', true);
    expect(enabled.allowed).toContain('other.test');
    expect(evaluateSiteRules(enabled, 'https://other.test/path').disabled).toBe(false);
    const disabled = setSiteEnabled(enabled, 'https://other.test/path', false);
    expect(disabled.allowed).toEqual(enabled.allowed);
    expect(evaluateSiteRules(disabled, 'https://other.test/path').disabled).toBe(true);
    expect(setSiteEnabled(disabled, 'https://other.test/path', true).disabled).not.toContain('other.test');
  });

  it('从 URL 规则和父域黑名单开启本站沿用原有移除匹配规则体验', () => {
    const sites = { mode: 'all' as const, disabled: ['example.com', 'glob:https://*.example.com/**', '/^https:\/\/www\.example\.com/', 'other.test'], allowed: [] };
    expect(setSiteEnabled(sites, 'https://www.example.com/path', true).disabled).toEqual(['other.test']);
    expect(setSiteEnabled(sites, 'https://www.example.com/path', false).disabled).toEqual(['other.test', 'www.example.com']);
  });

  it('阅读辅助默认继承，独立空规则显式放行，双方独立黑名单互不干扰', () => {
    const settings = createDefaultSettings();
    settings.sites.disabled = ['example.com'];
    expect(isSiteDisabled(settings, 'https://example.com/')).toBe(true);
    expect(isReadingSiteDisabled(settings, 'https://example.com/')).toBe(true);
    settings.readingSites = { mode: 'all', allowed: [], disabled: [] };
    expect(isReadingSiteDisabled(settings, 'https://example.com/')).toBe(false);
    settings.sites.disabled = [];
    settings.readingSites.disabled = ['glob:https://example.com/private/**'];
    expect(isSiteDisabled(settings, 'https://example.com/private/article')).toBe(false);
    expect(isReadingSiteDisabled(settings, 'https://example.com/private/article')).toBe(true);
    expect(isReadingSiteDisabled(settings, 'https://example.com/public')).toBe(false);
  });

  it('旧设置和损坏备份补齐网站字段，独立规则不进入阅读预设', () => {
    const migrated = normalizeSettings({ sites: { disabled: ['example.com'] } });
    expect(migrated.sites).toEqual({ mode: 'all', allowed: [], disabled: ['example.com'] });
    expect(migrated.readingSites).toBeUndefined();
    expect(normalizeSettings({ readingSites: { disabled: [] } }).readingSites).toEqual({ mode: 'all', allowed: [], disabled: [] });
    expect(normalizeSettings({ readingSites: null }).readingSites).toBeUndefined();
    expect(normalizeSiteRules({ mode: 'bad', disabled: [1, ' a.test ', 'a.test', null], allowed: null })).toEqual({ mode: 'all', disabled: ['a.test'], allowed: [] });
    expect(siteUrl('https://name:secret@example.com/path?q=1#ignored')?.href).toBe('https://example.com/path?q=1');
    migrated.readingSites = { mode: 'allowlist', disabled: [], allowed: ['glob:https://example.com/articles/**'] };
    const expectedSites = structuredClone({ sites: migrated.sites, readingSites: migrated.readingSites });
    selectGlobalReadingPreset(migrated, 'all');
    selectGlobalReadingPreset(migrated, 'off');
    expect({ sites: migrated.sites, readingSites: migrated.readingSites }).toEqual(expectedSites);
  });
});
