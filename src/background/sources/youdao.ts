import { YOUDAO_PROVIDER_ID, getProviderInfo } from '@/core/source/providers';
import { SourceError, type RemoteBook, type RemoteDeleteResult, type SourceProvider } from '@/core/source/types';
import type { UserWord, UserWordMap } from '@/core/wordbook/types';

/**
 * 有道单词本（cookie 方式：扩展拥有 host_permissions，后台 fetch 自动携带用户登录有道网页版后的 cookie）。
 *
 * 接口行为均为 2026-10 用调试账号实测（脱敏样例见 tests/fixtures/sources/youdao-*.json）：
 * - 分组列表：GET /wordbook/webapi/books -> { code:0, data:[{ bookId, bookName, isDefault }] }
 *   默认分组“无标签” bookId='0'；未登录时 code 仍为 0，data 为 []
 * - 单词：GET /wordbook/webapi/words?limit&offset[&bookId] -> { code:0, data:{ total, itemList:[{ itemId, bookId, bookName, word, trans, phonetic, modifiedTime }] } }
 *   不带 bookId 为全部单词；未登录时 total=0（不报错，必须另查登录状态）
 * - 删除：GET /wordbook/webapi/delete?itemId= -> { code:0 }；**未登录或 itemId 不存在也返回 code:0**，所以删除前必须先确认登录
 * - 加词：GET /wordbook/webapi/v2/ajax/add?word&lan=en -> { code:0 }，只能加入默认分组（bookId=0），所以只有该分组 canAdd
 * - 同一单词可以有大小写不同的多个条目（各自 itemId），本地按小写合并并在 refs 中保留全部 itemId
 * - 登录状态：GET /login/acc/query/accountinfo -> 未登录 { code:2035, msg:'NO_LOGIN' }；已登录 code:0
 *
 * remoteId：分组 bookId；旧版迁移来的 'default' 表示“全部单词”（不带 bookId 拉取），刷新列表后被各分组取代（见 service.ts 孤儿书替换）。
 */
const BASE = 'https://dict.youdao.com';
/** 旧版单一单词本 id（迁移数据），拉取时不带 bookId，即全部单词 */
export const YOUDAO_ALL_BOOK_ID = 'default';
const PAGE_SIZE = 5000;
const NO_LOGIN_MSG = '未登录有道或登录已失效，请先登录有道单词本网页版';

interface YoudaoResp<T> {
  code: number;
  msg?: string;
  data?: T;
}

export interface YoudaoItem {
  itemId?: string;
  bookId?: string;
  bookName?: string;
  word: string;
  trans?: string;
  phonetic?: string;
  modifiedTime?: number;
}

/** 网络层错误（fetch 抛错、没有拿到响应）的重试次数与间隔 */
const NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 500;

/**
 * GET 有道接口。retry：网络层错误（偶发连接重置）时重试，HTTP 错误码直接报告。
 * 列表/拉词只读，删除按 itemId（不存在的 itemId 也返回成功）都是幂等的，默认重试；
 * 加词接口重复调用是否会产生重复条目未实测，调用方传 false 不重试
 */
async function getJson<T>(path: string, retry = true): Promise<YoudaoResp<T>> {
  let res: Response | undefined;
  for (let attempt = 0; !res; attempt++) {
    try {
      res = await fetch(BASE + path, { credentials: 'include' });
    } catch {
      if (!retry || attempt >= NETWORK_RETRIES) throw new SourceError('无法连接有道服务器，请检查网络', 'network');
      await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  if (!res.ok) throw new SourceError(`有道服务器返回 ${res.status}`, 'network');
  try {
    return (await res.json()) as YoudaoResp<T>;
  } catch {
    // 被重定向到登录页等非 JSON 响应
    throw new SourceError(NO_LOGIN_MSG, 'auth');
  }
}

/** 是否已登录有道（accountinfo 未登录返回 code 2035 NO_LOGIN） */
export async function isYoudaoLoggedIn(): Promise<boolean> {
  return (await getJson<unknown>('/login/acc/query/accountinfo')).code === 0;
}

async function assertLoggedIn(): Promise<void> {
  if (!(await isYoudaoLoggedIn())) throw new SourceError(NO_LOGIN_MSG, 'auth');
}

/** 接口条目 -> UserWord；ref 为删除句柄 itemId */
export function youdaoItemToWord(item: YoudaoItem): UserWord {
  const w: UserWord = { word: item.word.trim() };
  if (item.phonetic) w.phonetic = item.phonetic;
  if (item.trans) w.trans = item.trans;
  if (item.itemId) w.ref = String(item.itemId);
  return w;
}

/**
 * 把一个接口条目并入词条表。有道按原文区分条目：同一账号可同时收录 Collapse 与 collapse（调试账号实测有 28 组），
 * 本地按小写合并为一个词条，但必须保留全部 itemId（refs），否则删除只删掉其中一条，重新同步后该词又出现。
 * 词条展示取第一个条目的原文/释义，后续条目只补缺失的音标/释义。
 */
export function mergeYoudaoItem(words: UserWordMap, item: YoudaoItem): void {
  const key = item.word.trim().toLowerCase();
  const next = youdaoItemToWord(item);
  const prev = words[key];
  if (!prev) {
    if (next.ref) next.refs = [next.ref];
    words[key] = next;
    return;
  }
  const refs = prev.refs ?? (prev.ref ? [prev.ref] : []);
  if (next.ref && !refs.includes(next.ref)) refs.push(next.ref);
  prev.refs = refs;
  prev.ref ??= next.ref;
  prev.phonetic ??= next.phonetic;
  prev.trans ??= next.trans;
}

/** 词条的全部删除句柄（旧缓存只有 ref） */
export function youdaoRefsOf(w: UserWord): string[] {
  return w.refs?.length ? w.refs : w.ref ? [w.ref] : [];
}

/** 默认分组 bookId：有道加词接口只能加入该分组 */
export const YOUDAO_DEFAULT_GROUP_ID = '0';
const READONLY_GROUP_REASON = '有道的加词接口只能加入默认分组“无标签”，该分组只能同步和删除';

export const youdaoProvider: SourceProvider = {
  ...getProviderInfo(YOUDAO_PROVIDER_ID)!,
  verifiesLoginOnEmpty: true,
  // itemId 在账号内全局唯一：迁移来的“全部单词”与各分组中的同一条目 itemId 相同，删除时按 itemId 去重
  globalRefs: true,

  async listRemoteBooks(): Promise<RemoteBook[]> {
    const body = await getJson<{ bookId: string; bookName: string; isDefault?: boolean }[]>('/wordbook/webapi/books');
    if (body.code !== 0) throw new SourceError(`有道返回错误：${body.msg ?? body.code}`, 'network');
    const books = body.data ?? [];
    // 未登录时分组列表为空（code 仍为 0），用登录状态区分“未登录”与“真的没有分组”
    if (books.length === 0) {
      await assertLoggedIn();
      return [{ remoteId: YOUDAO_DEFAULT_GROUP_ID, name: '无标签', canAdd: true }];
    }
    return books.map((b) => {
      const remoteId = String(b.bookId);
      const canAdd = remoteId === YOUDAO_DEFAULT_GROUP_ID;
      return { remoteId, name: b.bookName || remoteId, canAdd, ...(canAdd ? {} : { readOnlyReason: READONLY_GROUP_REASON }) };
    });
  },

  async fetchWords(remoteBookId) {
    const words: UserWordMap = {};
    const bookParam = remoteBookId === YOUDAO_ALL_BOOK_ID ? '' : `&bookId=${encodeURIComponent(remoteBookId)}`;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const body = await getJson<{ total: number; itemList?: YoudaoItem[] }>(`/wordbook/webapi/words?limit=${PAGE_SIZE}&offset=${offset}${bookParam}`);
      if (body.code !== 0 || !body.data) throw new SourceError(`有道返回错误：${body.msg ?? body.code}`, 'network');
      const list = body.data.itemList ?? [];
      for (const item of list) {
        if (!item.word?.trim()) continue;
        mergeYoudaoItem(words, item);
      }
      if (list.length < PAGE_SIZE || offset + list.length >= body.data.total) break;
    }
    // 空结果：未登录时接口同样返回 total=0，需区分（已登录且确实为空则正常返回空，由 service 提示）
    if (Object.keys(words).length === 0) await assertLoggedIn();
    return words;
  },

  /** 有道按 itemId 逐个删除；未登录时接口也返回成功，所以先校验登录 */
  async deleteWords(_remoteId, words) {
    const result: RemoteDeleteResult = { deleted: [], failed: [] };
    await assertLoggedIn();
    for (const w of words) {
      const refs = youdaoRefsOf(w);
      if (refs.length === 0) {
        result.failed.push({ word: w.word, error: '缺少 itemId，请先重新同步' });
        continue;
      }
      // 同一单词的多个条目（大小写不同）逐个删除，全部成功才算删除成功；部分失败时保留本地缓存，下次同步纠正
      const errors: string[] = [];
      for (const ref of refs) {
        try {
          const body = await getJson<null>(`/wordbook/webapi/delete?itemId=${encodeURIComponent(ref)}`);
          if (body.code !== 0) errors.push(body.msg ?? `code ${body.code}`);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (errors.length === 0) result.deleted.push(w.word);
      else
        result.failed.push({
          word: w.word,
          error: refs.length > 1 ? `${refs.length} 个条目中 ${errors.length} 个删除失败：${errors[0]}` : errors[0]!,
        });
    }
    return result;
  },

  /**
   * 撤销时加回：有道加词接口只能加入默认分组（bookId=0）。加词接口不返回 itemId，
   * 加完后读一次默认分组取新 itemId 作为删除句柄（旧 itemId 已失效，且有道删除不存在的 itemId 也返回成功，不能沿用）。
   */
  async addWords(remoteId, words) {
    if (remoteId !== YOUDAO_DEFAULT_GROUP_ID) throw new SourceError(READONLY_GROUP_REASON, 'unsupported');
    await assertLoggedIn();
    const ok = new Set<string>();
    // 最后一次失败原因：全部失败时抛出，避免调用方把空结果当成“已加入”（5xx、code≠0 都算失败）
    let lastError: SourceError | undefined;
    for (const w of words) {
      try {
        const body = await getJson<null>(`/wordbook/webapi/v2/ajax/add?word=${encodeURIComponent(w.word)}&lan=en`, false);
        if (body.code === 0) ok.add(w.word.toLowerCase());
        else lastError = new SourceError(`有道返回错误：${body.msg ?? body.code}`, 'network');
      } catch (e) {
        lastError = e instanceof SourceError ? e : new SourceError(String(e), 'unknown');
      }
    }
    if (ok.size === 0) throw lastError ?? new SourceError('有道加词失败', 'unknown');
    const fresh = await this.fetchWords(YOUDAO_DEFAULT_GROUP_ID, { settings: { enabled: true, autoSync: false, deleteOnKnown: false } });
    // 找不到新条目时去掉 ref（宁可让下次删除提示“请先重新同步”，也不要用失效 itemId 误报删除成功）
    return words
      .filter((w) => ok.has(w.word.toLowerCase()))
      .map((w) => {
        const f = fresh[w.word.toLowerCase()];
        return { ...w, ref: f?.ref, refs: f?.refs };
      });
  },
};
