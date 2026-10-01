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
 *    - 已掌握：GET /studylist/mastered_words?language=en&page&page_size -> { data: [{ word, exp:null, add_time }] }，只读，
 *      作为 remoteId='mastered'、role=known 的来源熟词本（2026-10 用户提供 token 后实测）
 *    - 响应码：401 授权无效/过期；403 访问过于频繁（限流）；400 参数错误（message 字段）
 *    - 流量限制：1 分钟 30 次（超限封 1 小时）、30 分钟 500 次（超限封 24 小时）——因此所有 OpenAPI 请求全局串行并间隔 ≥ 2.1s
 */
export const EUDIC_ALL_BOOK_ID = '-1';
/**
 * “已掌握单词”的 remoteId：OpenAPI 中它不是分类，而是独立的只读集合 GET /studylist/mastered_words
 * （分类 id 都是数字字符串，不会与之冲突）。作为 role=known 的来源熟词本同步。
 */
export const EUDIC_MASTERED_BOOK_ID = 'mastered';
const MASTERED_READONLY = '欧路 OpenAPI 只提供读取“已掌握单词”的接口，不能写入或删除';
const COOKIE_READONLY = '网页登录（cookie）模式没有加词接口；配置 OpenAPI 授权后可加词';
const OPENAPI_BASE = 'https://api.frdic.com/api/open/v1';
const COOKIE_PAGE_DELAY_MS = 500;
/** OpenAPI 请求最小间隔：60s / 30 次 = 2s，再留余量 */
export const OPENAPI_MIN_INTERVAL_MS = 2_100;
export const OPENAPI_PAGE_SIZE = 100;
export const OPENAPI_MAX_PAGE = 50;
/** 读请求遇到网络错误 / 5xx 时的重试次数 */
export const OPENAPI_GET_RETRIES = 2;
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
    let res: Response | undefined;
    // 读请求（列分组、分页拉词）在网络错误 / 5xx 时指数退避重试（间隔 2.1s、4.2s）：实测偶发首个请求连接失败会让整个来源同步失败。
    // 写请求（加词/删词）不重试：结果未知时重试可能重复执行，交给调用方报告失败、保留本地缓存。
    // 重试同样排在全局串行链中并计入请求间隔，不会突破“1 分钟 30 次”的限流
    const attempts = method === 'GET' ? 1 + OPENAPI_GET_RETRIES : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const wait = lastOpenApiAt + minIntervalMs * 2 ** attempt - Date.now();
      if (wait > 0) await sleep(wait);
      lastOpenApiAt = Date.now();
      try {
        res = await fetch(OPENAPI_BASE + path, {
          method,
          headers: { Authorization: authHeader(ctx)!, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        if (attempt + 1 < attempts) {
          console.info('[hnw] 欧路请求网络错误，重试', path, attempt + 1);
          continue;
        }
        throw new SourceError('无法连接欧路服务器，请检查网络', 'network');
      }
      if (res.status >= 500 && attempt + 1 < attempts) {
        console.info('[hnw] 欧路服务器错误，重试', res.status, path, attempt + 1);
        continue;
      }
      break;
    }
    res = res!;
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
  exp?: string | null;
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
    if (!authHeader(ctx)) return [{ remoteId: EUDIC_ALL_BOOK_ID, name: '全部生词', canAdd: false, readOnlyReason: COOKIE_READONLY }];
    const { data } = await openApi<{ data?: { id: string | number; name: string }[] }>(ctx, 'GET', '/studylist/category?language=en');
    const books: RemoteBook[] = (data ?? []).map((c) => ({ remoteId: String(c.id), name: c.name || String(c.id), canAdd: true }));
    books.push({ remoteId: EUDIC_MASTERED_BOOK_ID, name: '已掌握单词', role: 'known', canAdd: false, canDelete: false, readOnlyReason: MASTERED_READONLY });
    return books;
  },

  async fetchWords(remoteBookId, ctx) {
    if (remoteBookId === EUDIC_MASTERED_BOOK_ID) {
      if (!authHeader(ctx)) throw new SourceError('同步“已掌握单词”需要先配置欧路 OpenAPI 授权', 'auth');
      return fetchOpenApiPages(ctx, '/studylist/mastered_words?language=en', remoteBookId);
    }
    if (!useOpenApi(ctx, remoteBookId)) return fetchCookieWords();
    return fetchOpenApiPages(ctx, `/studylist/words?language=en&category_id=${encodeURIComponent(remoteBookId)}`, remoteBookId);
  },

  async deleteWords(remoteBookId, words: UserWord[], ctx): Promise<RemoteDeleteResult> {
    if (remoteBookId === EUDIC_MASTERED_BOOK_ID) throw new SourceError(MASTERED_READONLY, 'unsupported');
    return deleteEudicWords(remoteBookId, words, ctx);
  },

  /** 加词（OpenAPI 分类；cookie 模式与“已掌握”不支持，service 按 SourceBookState.canAdd 不会调用） */
  async addWords(remoteBookId, words, ctx) {
    if (remoteBookId === EUDIC_MASTERED_BOOK_ID) throw new SourceError(MASTERED_READONLY, 'unsupported');
    if (!useOpenApi(ctx, remoteBookId)) throw new SourceError(COOKIE_READONLY, 'unsupported');
    const added: UserWord[] = [];
    for (let i = 0; i < words.length; i += OPENAPI_BATCH) {
      const batch = words.slice(i, i + OPENAPI_BATCH);
      await openApi(ctx, 'POST', '/studylist/words', { language: 'en', category_id: remoteBookId, words: batch.map((w) => w.ref ?? w.word) });
      added.push(...batch.map((w) => ({ ...w, ref: w.ref ?? w.word })));
    }
    return added;
  },
};

/**
 * OpenAPI 分页拉取（words / mastered_words 结构相同）：page 从 0 到 50，page_size 100，不满一页即结束。
 * pathWithQuery 已带 language（与分类参数），这里只追加分页参数。
 */
async function fetchOpenApiPages(ctx: SourceContext, pathWithQuery: string, remoteBookId: string): Promise<UserWordMap> {
  const words: UserWordMap = {};
  for (let page = 0; page <= OPENAPI_MAX_PAGE; page++) {
    const { data } = await openApi<{ data?: EudicApiWord[] }>(ctx, 'GET', `${pathWithQuery}&page=${page}&page_size=${OPENAPI_PAGE_SIZE}`);
    for (const item of data ?? []) {
      const word = item.word?.trim();
      if (word) words[word.toLowerCase()] = toUserWord(word, item.phon, item.exp ?? undefined);
    }
    if (!data || data.length < OPENAPI_PAGE_SIZE) break;
    if (page === OPENAPI_MAX_PAGE) console.warn('[hnw] 欧路 OpenAPI 单本最多返回', (OPENAPI_MAX_PAGE + 1) * OPENAPI_PAGE_SIZE, '词，已截断', remoteBookId);
  }
  return words;
}

/**
 * 删除：OpenAPI 按分类批量删除；cookie 模式逐词 SetStarRating（从整个生词本移除，不区分分类）。
 * 鉴权/限流错误对整批生效，直接抛给 service 统一提示。
 */
async function deleteEudicWords(remoteBookId: string, words: UserWord[], ctx: SourceContext): Promise<RemoteDeleteResult> {
  const result: RemoteDeleteResult = { deleted: [], failed: [] };
  if (useOpenApi(ctx, remoteBookId)) {
    for (let i = 0; i < words.length; i += OPENAPI_BATCH) {
      const batch = words.slice(i, i + OPENAPI_BATCH);
      try {
        await openApi(ctx, 'DELETE', '/studylist/words', { language: 'en', category_id: remoteBookId, words: batch.map((w) => w.ref ?? w.word) });
        result.deleted.push(...batch.map((w) => w.word));
      } catch (e) {
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
}
