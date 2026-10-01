import { EUDIC_PROVIDER_ID, getProviderInfo } from '@/core/source/providers';
import { SourceError, type RemoteBook, type RemoteDeleteResult, type SourceContext, type SourceProvider } from '@/core/source/types';
import type { UserWord, UserWordMap } from '@/core/wordbook/types';

/**
 * 欧路生词本，两种访问方式：
 *
 * 1. cookie 模式（默认，沿用旧版 v2.0.1）：用户登录 my.eudic.net 后，后台 fetch 携带 cookie
 *    - 单词：GET https://my.eudic.net/StudyList/WordsDataSource?start&length（与旧版一致不带分类，即全部生词；
 *      length 过大会被拒绝，按 4000 分页、页间隔 500ms）；未登录时返回登录页 HTML（JSON 解析失败）
 *    - 删除：POST https://dict.eudic.net/Dicts/SetStarRating {rating:-1, word, lang:'en'}（从生词本整体移除，不区分分类）
 *    - cookie 模式的分类列表接口未公开，只提供“全部生词”（remoteId='-1'）一本
 *
 * 2. OpenAPI token 模式（settings.sources.eudic.apiToken 非空时，多生词本完整可用）。
 *    官方文档 https://my.eudic.net/doc/api_study.md 与 /doc/index.md（2026-10 查阅）：
 *    - 鉴权 Header `Authorization: NIS <token>`（token 在 https://my.eudic.net/OpenAPI/Authorization 获取）
 *    - 分类：GET /studylist/category?language=en -> { data: [{ id, language, name }] }（默认生词本 id '0'）
 *    - 单词：GET /studylist/words?language=en&category_id&page&page_size -> { data: [{ word, phon, exp, add_time, star }] }
 *      page 从 0 开始最大 50，page_size 最大 100（单本最多可取 5100 词）
 *    - 删除：DELETE /studylist/words { language, category_id, words } -> 204
 *    - 加词：POST /studylist/words { language, category_id, words } -> 201（重复单词不会添加）
 *    - 响应码：401 授权无效/过期；403 访问过于频繁（限流）；400 参数错误（message 字段）
 *    - 流量限制：1 分钟 30 次（超限封 1 小时）、30 分钟 500 次（超限封 24 小时）——因此所有 OpenAPI 请求全局串行并间隔 ≥ 2.1s
 */
export const EUDIC_ALL_BOOK_ID = '-1';
const OPENAPI_BASE = 'https://api.frdic.com/api/open/v1';
const COOKIE_PAGE_DELAY_MS = 500;
/** OpenAPI 请求最小间隔：60s / 30 次 = 2s，再留余量 */
export const OPENAPI_MIN_INTERVAL_MS = 2_100;
export const OPENAPI_PAGE_SIZE = 100;
export const OPENAPI_MAX_PAGE = 50;
/** 批量删除/加词每次最多的单词数（文档未写上限，保守取 100） */
const OPENAPI_BATCH = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authHeader(ctx: SourceContext): string | undefined {
  const token = ctx.settings.apiToken?.trim();
  if (!token) return undefined;
  return token.startsWith('NIS ') ? token : `NIS ${token}`;
}

/** 是否走 OpenAPI：配置了 token 且不是 cookie 模式的“全部生词”书 */
function useOpenApi(ctx: SourceContext, remoteBookId: string): boolean {
  return !!authHeader(ctx) && remoteBookId !== EUDIC_ALL_BOOK_ID;
}

/**
 * OpenAPI 全局节流：所有请求串行，相邻请求间隔 ≥ OPENAPI_MIN_INTERVAL_MS，避免触发“1 分钟 30 次”封禁。
 * 导出 setOpenApiThrottle 供单测缩短间隔。
 */
let openApiChain: Promise<unknown> = Promise.resolve();
let lastOpenApiAt = 0;
let minIntervalMs = OPENAPI_MIN_INTERVAL_MS;
export function setOpenApiThrottle(ms: number): void {
  minIntervalMs = ms;
  lastOpenApiAt = 0;
}

async function openApi<T>(ctx: SourceContext, method: string, path: string, body?: unknown): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = lastOpenApiAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastOpenApiAt = Date.now();
    let res: Response;
    try {
      res = await fetch(OPENAPI_BASE + path, {
        method,
        headers: { Authorization: authHeader(ctx)!, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SourceError('无法连接欧路服务器，请检查网络', 'network');
    }
    const text = await res.text();
    if (res.status === 401) throw new SourceError('欧路 API 授权无效或已过期，请重新获取授权信息', 'auth');
    if (res.status === 403 || res.status === 429) throw new SourceError('欧路接口访问过于频繁，已被临时限制，请 1 小时后再试', 'ratelimit');
    if (!res.ok) {
      let message = '';
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? '';
      } catch {
        // 非 JSON 错误体
      }
      throw new SourceError(`欧路服务器返回 ${res.status}${message ? `：${message}` : ''}`, 'network');
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new SourceError('欧路服务器返回了无法解析的数据', 'network');
    }
  };
  const next = openApiChain.then(run, run);
  openApiChain = next.catch(() => {});
  return next;
}

/** cookie 接口条目：uuid 实际就是单词本身，word 字段为带链接的 HTML */
export interface EudicCookieItem {
  uuid: string;
  word?: string;
  phon?: string;
  exp?: string;
}

/** OpenAPI 单词条目 */
export interface EudicApiWord {
  word: string;
  phon?: string;
  exp?: string;
  add_time?: string;
  star?: number;
}

/** 释义里 OpenAPI 用 <br> 分隔义项，cookie 接口可能带 HTML；原样保留，展示层统一清洗 */
function toUserWord(word: string, phon?: string, exp?: string): UserWord {
  const w: UserWord = { word, ref: word };
  if (phon) w.phonetic = phon;
  if (exp) w.trans = exp;
  return w;
}

async function fetchCookieWords(): Promise<UserWordMap> {
  const words: UserWordMap = {};
  const limit = 4000;
  for (let start = 0; ; start += limit) {
    let res: Response;
    try {
      res = await fetch(`https://my.eudic.net/StudyList/WordsDataSource?start=${start}&length=${limit}`, { credentials: 'include' });
    } catch {
      throw new SourceError('无法连接欧路服务器，请检查网络', 'network');
    }
    if (!res.ok) throw new SourceError(`欧路服务器返回 ${res.status}`, 'network');
    let result: { data?: EudicCookieItem[] };
    try {
      result = (await res.json()) as { data?: EudicCookieItem[] };
    } catch {
      // 未登录时被重定向到登录页 HTML
      throw new SourceError('未登录欧路或登录已失效，请先登录 my.eudic.net', 'auth');
    }
    const list = result.data ?? [];
    for (const item of list) {
      const word = (item.uuid ?? '').trim();
      if (word) words[word.toLowerCase()] = toUserWord(word, item.phon, item.exp);
    }
    if (list.length < limit) break;
    await sleep(COOKIE_PAGE_DELAY_MS);
  }
  return words;
}

export const eudicProvider: SourceProvider = {
  ...getProviderInfo(EUDIC_PROVIDER_ID)!,

  async listRemoteBooks(ctx): Promise<RemoteBook[]> {
    if (!authHeader(ctx)) return [{ remoteId: EUDIC_ALL_BOOK_ID, name: '全部生词' }];
    const { data } = await openApi<{ data?: { id: string | number; name: string }[] }>(ctx, 'GET', '/studylist/category?language=en');
    return (data ?? []).map((c) => ({ remoteId: String(c.id), name: c.name || String(c.id) }));
  },

  async fetchWords(remoteBookId, ctx) {
    if (!useOpenApi(ctx, remoteBookId)) return fetchCookieWords();
    const words: UserWordMap = {};
    for (let page = 0; page <= OPENAPI_MAX_PAGE; page++) {
      const q = `?language=en&category_id=${encodeURIComponent(remoteBookId)}&page=${page}&page_size=${OPENAPI_PAGE_SIZE}`;
      const { data } = await openApi<{ data?: EudicApiWord[] }>(ctx, 'GET', '/studylist/words' + q);
      for (const item of data ?? []) {
        const word = item.word?.trim();
        if (word) words[word.toLowerCase()] = toUserWord(word, item.phon, item.exp);
      }
      if (!data || data.length < OPENAPI_PAGE_SIZE) break;
      if (page === OPENAPI_MAX_PAGE) console.warn('[hnw] 欧路 OpenAPI 单本最多返回', (OPENAPI_MAX_PAGE + 1) * OPENAPI_PAGE_SIZE, '词，已截断', remoteBookId);
    }
    return words;
  },

  async deleteWords(remoteBookId, words: UserWord[], ctx): Promise<RemoteDeleteResult> {
    const result: RemoteDeleteResult = { deleted: [], failed: [] };
    if (useOpenApi(ctx, remoteBookId)) {
      for (let i = 0; i < words.length; i += OPENAPI_BATCH) {
        const batch = words.slice(i, i + OPENAPI_BATCH);
        try {
          await openApi(ctx, 'DELETE', '/studylist/words', { language: 'en', category_id: remoteBookId, words: batch.map((w) => w.ref ?? w.word) });
          result.deleted.push(...batch.map((w) => w.word));
        } catch (e) {
          // 鉴权/限流错误对整批生效，直接抛给 service 统一提示
          if (e instanceof SourceError && (e.code === 'auth' || e.code === 'ratelimit')) throw e;
          result.failed.push(...batch.map((w) => ({ word: w.word, error: e instanceof Error ? e.message : String(e) })));
        }
      }
      return result;
    }
    for (const w of words) {
      try {
        const res = await fetch('https://dict.eudic.net/Dicts/SetStarRating', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: -1, word: w.ref ?? w.word, lang: 'en' }),
        });
        // 未登录时会被重定向到登录页（最终 200 HTML），以 URL 判断
        if (res.redirected && /login/i.test(res.url)) throw new SourceError('未登录欧路或登录已失效，请先登录 my.eudic.net', 'auth');
        if (res.ok) result.deleted.push(w.word);
        else result.failed.push({ word: w.word, error: `HTTP ${res.status}` });
      } catch (e) {
        if (e instanceof SourceError) throw e;
        result.failed.push({ word: w.word, error: '网络错误' });
      }
    }
    return result;
  },

  /** 撤销时加回（仅 OpenAPI 模式；cookie 模式无公开加词接口，返回空） */
  async addWords(remoteBookId, words, ctx) {
    if (!useOpenApi(ctx, remoteBookId)) return [];
    const added: UserWord[] = [];
    for (let i = 0; i < words.length; i += OPENAPI_BATCH) {
      const batch = words.slice(i, i + OPENAPI_BATCH);
      await openApi(ctx, 'POST', '/studylist/words', { language: 'en', category_id: remoteBookId, words: batch.map((w) => w.ref ?? w.word) });
      added.push(...batch);
    }
    return added;
  },
};
