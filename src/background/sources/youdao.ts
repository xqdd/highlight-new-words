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
 * - 加词：GET /wordbook/webapi/v2/ajax/add?word&lan=en -> { code:0 }，加入默认分组（bookId=0）
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

async function getJson<T>(path: string): Promise<YoudaoResp<T>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { credentials: 'include' });
  } catch {
    throw new SourceError('无法连接有道服务器，请检查网络', 'network');
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

export const youdaoProvider: SourceProvider = {
  ...getProviderInfo(YOUDAO_PROVIDER_ID)!,
  verifiesLoginOnEmpty: true,

  async listRemoteBooks(): Promise<RemoteBook[]> {
    const body = await getJson<{ bookId: string; bookName: string; isDefault?: boolean }[]>('/wordbook/webapi/books');
    if (body.code !== 0) throw new SourceError(`有道返回错误：${body.msg ?? body.code}`, 'network');
    const books = body.data ?? [];
    // 未登录时分组列表为空（code 仍为 0），用登录状态区分“未登录”与“真的没有分组”
    if (books.length === 0) {
      await assertLoggedIn();
      return [{ remoteId: '0', name: '无标签' }];
    }
    return books.map((b) => ({ remoteId: String(b.bookId), name: b.bookName || String(b.bookId) }));
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
        words[item.word.trim().toLowerCase()] = youdaoItemToWord(item);
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
      if (!w.ref) {
        result.failed.push({ word: w.word, error: '缺少 itemId，请先重新同步' });
        continue;
      }
      try {
        const body = await getJson<null>(`/wordbook/webapi/delete?itemId=${encodeURIComponent(w.ref)}`);
        if (body.code === 0) result.deleted.push(w.word);
        else result.failed.push({ word: w.word, error: body.msg ?? `code ${body.code}` });
      } catch (e) {
        result.failed.push({ word: w.word, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  },

  /**
   * 撤销时加回：有道加词接口只能加入默认分组（bookId=0）。加词接口不返回 itemId，
   * 加完后读一次默认分组取新 itemId 作为删除句柄（旧 itemId 已失效，且有道删除不存在的 itemId 也返回成功，不能沿用）。
   */
  async addWords(_remoteId, words) {
    await assertLoggedIn();
    const ok = new Set<string>();
    for (const w of words) {
      const body = await getJson<null>(`/wordbook/webapi/v2/ajax/add?word=${encodeURIComponent(w.word)}&lan=en`).catch(() => undefined);
      if (body?.code === 0) ok.add(w.word.toLowerCase());
    }
    if (ok.size === 0) return [];
    const fresh = await this.fetchWords('0', { settings: { enabled: true, autoSync: false, deleteOnKnown: false } });
    // 找不到新条目时去掉 ref（宁可让下次删除提示“请先重新同步”，也不要用失效 itemId 误报删除成功）
    return words.filter((w) => ok.has(w.word.toLowerCase())).map((w) => ({ ...w, ref: fresh[w.word.toLowerCase()]?.ref }));
  },
};
