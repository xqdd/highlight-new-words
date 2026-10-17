/** 全局高亮与独立阅读辅助共用的本地网站规则。裸域名继续匹配其全部子域。 */
export interface SiteRules {
  mode: 'all' | 'allowlist';
  disabled: string[];
  allowed: string[];
}
export type SiteRuleKind = 'domain' | 'glob' | 'regex';
type Compiled = { error?: string; match?: (url: URL) => boolean };
const cache = new Map<string, Compiled>();
const MAX_RULE_LENGTH = 256;

/** URL 规则包含 query、忽略 hash 和登录凭据；纯 hostname 调用仍兼容旧域名规则。 */
export function siteUrl(input: string): URL | undefined {
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    url.hash = ''; url.username = ''; url.password = '';
    return url;
  } catch { return undefined; }
}

export function normalizeSiteRules(raw: unknown): SiteRules {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))] : [];
  return { mode: value.mode === 'allowlist' ? 'allowlist' : 'all', disabled: list(value.disabled), allowed: list(value.allowed) };
}

/** 限制正则语法而非尝试用超时终止主线程正则：禁用分组/分支/回溯引用和复杂重复。 */
function safeRegex(source: string): string | undefined {
  let escaped = false, inClass = false, repeats = 0, optional = 0;
  for (const char of source) {
    if (escaped) {
      if (/[1-9k]/.test(char)) return '正则不支持回溯引用';
      escaped = false; continue;
    }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[' && !inClass) { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (/[()|{}]/.test(char)) return '安全正则不支持分组、分支或花括号重复';
    if (char === '*' || char === '+') repeats++;
    if (char === '?') optional++;
  }
  if (repeats > 1 || optional > 4 || repeats && !source.startsWith('^')) return '正则最多一个 * 或 +、四个 ?；使用 * 或 + 时需以 ^ 开头';
  return undefined;
}

function compile(rule: string): Compiled {
  const key = rule.trim();
  const saved = cache.get(key); if (saved) return saved;
  const build = (): Compiled => {
    if (!key || key.length > MAX_RULE_LENGTH) return { error: `规则长度需为 1–${MAX_RULE_LENGTH} 个字符` };
    const prefix = /^(domain|glob|regex):/.exec(key);
    const value = prefix ? key.slice(prefix[0].length) : key;
    const kind = prefix?.[1] ?? (value.startsWith('/') ? 'regex' : value.includes('*') || value.includes('://') ? 'glob' : 'domain');
    if (kind === 'domain') {
      const url = siteUrl(value);
      if (!url || /[\s/*?#:@]/.test(value) || value.includes('://') || url.port || url.pathname !== '/') return { error: '域名规则只接受域名，不含协议、路径或通配符' };
      const host = url.hostname.replace(/\.$/, '').toLowerCase();
      return { match: target => target.hostname.replace(/\.$/, '').toLowerCase() === host || target.hostname.replace(/\.$/, '').toLowerCase().endsWith(`.${host}`) };
    }
    if (kind === 'regex') {
      const literal = /^\/(.*)\/([a-z]*)$/.exec(value);
      if (!literal) return { error: '正则格式为 /表达式/，可加 i 或 u 标志' };
      const source = literal[1]!, flags = literal[2]!;
      if (!/^(?:i?u?|ui)$/.test(flags)) return { error: '正则只支持 i、u 标志' };
      const error = safeRegex(source); if (error) return { error };
      try { const regex = new RegExp(source, flags); return { match: url => url.href.length <= 8192 && regex.test(url.href) }; }
      catch { return { error: '正则表达式无效' }; }
    }
    const isUrl = value.includes('://');
    if (/[\s#]/.test(value)) return { error: '通配规则不能包含空白或 #（网址匹配忽略片段）' };
    // Chrome 会把 hostname 中的 * 序列化为 %2A，Node 则保留它；先保护通配再统一规范化。
    let wildcardToken = 'hnwglobwildcard';
    while (value.toLowerCase().includes(wildcardToken)) wildcardToken += 'x';
    const protectHost = (host: string): string => {
      if (host.includes('%')) throw new Error('encoded-host');
      if (host.split('.').some(label => label.includes('*') && /[^\x00-\x7F]/.test(label))) throw new Error('mixed-idn');
      return host.replaceAll('*', wildcardToken);
    };
    const restoreWildcards = (canonical: string): string => canonical.replaceAll(wildcardToken, '*');
    let patterns = [value];
    if (isUrl) {
      const parts = /^(https?|\*):\/\/([^/?]+)(.*)$/i.exec(value);
      if (!parts || /[@]/.test(parts[2]!)) return { error: '网址通配规则需以 http://、https:// 或 *:// 开头' };
      try {
        // 与目标使用同一 URL 序列化，保留星号并规范化 IDN、中文路径与默认端口。
        const protocol = parts[1]!.toLowerCase();
        // * 协议分别按 http/https 序列化，避免默认端口在不同协议下语义改变。
        const authority = protectHost(parts[2]!);
        patterns = (protocol === '*' ? ['http', 'https'] : [protocol]).map(scheme => restoreWildcards(new URL(`${scheme}://${authority}${parts[3] || '/'}`).href));
      } catch { return { error: '网址通配规则无效：域名不支持百分号编码或同一标签混用中文与星号' }; }
    } else {
      if (/[/?@:]/.test(value)) return { error: '域名通配规则不能包含路径或端口' };
      try { patterns = [restoreWildcards(new URL(`https://${protectHost(value)}/`).hostname)]; }
      catch { return { error: '域名通配规则无效：不支持百分号编码或同一标签混用中文与星号' }; }
    }
    // * 不跨 /，** 可跨路径层级；? 始终是查询分隔符的字面字符。
    const matchers = patterns.map(pattern => {
      const tokens: { literal?: string; cross?: boolean }[] = [];
      for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]!;
        if (char === '*') { const cross = pattern[i + 1] === '*'; if (cross) i++; tokens.push({ cross }); }
        else tokens.push({ literal: char });
      }
      // 通配用动态规划而非回溯正则，避免 *a*a... 在长 URL 上指数回溯。
      const literalPrefix = pattern.split('*')[0]!;
      return (url: URL) => {
        const text = isUrl ? url.href : url.hostname;
        if (text.length > 8192 || !text.startsWith(literalPrefix)) return false;
        let previous = new Uint8Array(text.length + 1); previous[0] = 1;
        for (const token of tokens) {
          const next = new Uint8Array(text.length + 1);
          if (token.literal !== undefined) {
            for (let i = 1; i <= text.length; i++) if (previous[i - 1] && text[i - 1] === token.literal) next[i] = 1;
          } else {
            next[0] = previous[0]!;
            for (let i = 1; i <= text.length; i++) next[i] = previous[i] || next[i - 1] && (token.cross || text[i - 1] !== '/') ? 1 : 0;
          }
          previous = next;
        }
        return !!previous[text.length];
      };
    });
    return { match: url => matchers.some(match => match(url)) };
  };
  const result = build();
  if (cache.size >= 512) cache.clear();
  cache.set(key, result); return result;
}

export function validateSiteRule(rule: string): string | undefined { return compile(rule).error; }
export function matchesSiteRule(rule: string, input: string): boolean {
  const url = siteUrl(input); return !!url && !!compile(rule).match?.(url);
}
export function evaluateSiteRules(sites: SiteRules, input: string) {
  const blockedBy = sites.disabled.find(rule => matchesSiteRule(rule, input));
  const allowedBy = sites.allowed.find(rule => matchesSiteRule(rule, input));
  return { disabled: !!blockedBy || sites.mode === 'allowlist' && !allowedBy, blockedBy, allowedBy };
}

/** 开启本站沿用旧操作：移除命中的禁用规则；白名单模式补上本站域名。关闭保留允许列表，用黑名单覆盖。 */
export function setSiteEnabled(sites: SiteRules, input: string, enabled: boolean): SiteRules {
  const url = siteUrl(input); if (!url) return sites;
  const disabled = sites.disabled.filter(rule => !matchesSiteRule(rule, input));
  return { ...sites, disabled: enabled ? disabled : [...disabled, url.hostname],
    allowed: enabled && sites.mode === 'allowlist' && !sites.allowed.some(rule => matchesSiteRule(rule, input)) ? [...sites.allowed, url.hostname] : [...sites.allowed] };
}
