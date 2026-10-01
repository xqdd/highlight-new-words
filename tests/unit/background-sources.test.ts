import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { getKnownWords } from '@/core/known/store';
import { getSettings, patchSettings, runMigrationIfNeeded } from '@/core/settings/store';
import { SourceError } from '@/core/source/types';
import { getSourceBook, getSourceIndex, patchSourceBookState, saveSourceBook, updateSourceIndex } from '@/core/wordbook/user-store';
import { youdaoProvider } from '@/background/sources/youdao';
import { eudicProvider, setOpenApiThrottle } from '@/background/sources/eudic';
import {
  MSG_EMPTY_VERIFIED,
  autoSyncIfDue,
  deleteFromSources,
  recoverInterruptedSyncs,
  syncSourceBook,
  syncSourceBooks,
} from '@/background/sources/service';
import { markKnown, unmarkKnown } from '@/background/known';

// 词形还原器固定用规则版，避免依赖 lemma 分片的数据文件加载
vi.mock('@/core/lemma', () => ({ createLemmatizer: () => new SimpleLemmatizer() }));

const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, '../fixtures/sources', name), 'utf8'));
const YD_BOOKS = fixture('youdao-books.json');
const YD_WORDS = fixture('youdao-words.json');
const YD_MISC = fixture('youdao-misc.json');
const EUDIC = fixture('eudic-openapi.json');
const UNGROUPED = YD_BOOKS.data[0].bookId as string;

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** fetch 路由 mock：按顺序匹配，记录全部请求 */
function mockFetch(...routes: Route[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const on = (re: RegExp, res: () => Response): Route => (url) => (re.test(url) ? res() : undefined);

/** 有道已登录：按 bookId 返回 fixture 中对应分组的条目 */
function youdaoLoggedIn(extra: Route[] = []) {
  return mockFetch(
    ...extra,
    on(/accountinfo/, () => json(YD_MISC.accountinfoLoggedIn)),
    on(/webapi\/books/, () => json(YD_BOOKS)),
    (url) => {
      if (!/webapi\/words/.test(url)) return undefined;
      const bookId = new URL(url).searchParams.get('bookId');
      const list = YD_WORDS.data.itemList.filter((i: { bookId: string }) => bookId === null || i.bookId === bookId);
      return json({ code: 0, msg: 'SUCCESS', data: { total: list.length, itemList: list } });
    },
    on(/webapi\/delete/, () => json(YD_MISC.delete)),
  );
}
function youdaoAnonymous() {
  const a = YD_MISC.anonymous;
  return mockFetch(on(/accountinfo/, () => json(a.accountinfo)), on(/webapi\/books/, () => json(a.books)), on(/webapi\/words/, () => json(a.words)), on(/webapi\/delete/, () => json(a.delete)));
}

const ctx = { settings: { enabled: true, autoSync: true, deleteOnKnown: false } };

beforeEach(() => {
  fakeBrowser.reset();
  setOpenApiThrottle(0);
});
afterEach(() => vi.unstubAllGlobals());

describe('有道 provider（真实接口脱敏样例）', () => {
  it('列出分组，按 bookId 拉取；旧版 default 拉取全部', async () => {
    const calls = youdaoLoggedIn();
    // 加词接口只能加入默认分组，其他分组 canAdd=false 并给出原因
    expect(await youdaoProvider.listRemoteBooks(ctx)).toEqual([
      { remoteId: UNGROUPED, name: '未分组', canAdd: false, readOnlyReason: expect.stringContaining('默认分组') },
      { remoteId: '0', name: '无标签', canAdd: true },
    ]);
    const g0 = await youdaoProvider.fetchWords('0', ctx);
    expect(Object.keys(g0)).toEqual(['algorithm', 'asynchronous', 'authentication']);
    expect(g0.algorithm).toMatchObject({ word: 'Algorithm', trans: 'n. [计][数] 算法，运算法则', phonetic: "['ælgərɪð(ə)m]" });
    expect(g0.algorithm!.ref).toBe(YD_WORDS.data.itemList[0].itemId);
    const all = await youdaoProvider.fetchWords('default', ctx);
    expect(Object.keys(all)).toHaveLength(6);
    expect(calls.some((c) => /words/.test(c.url) && !/bookId/.test(c.url))).toBe(true);
    expect(calls.every((c) => c.url.startsWith('https://'))).toBe(true);
  });

  it('未登录：列表为空/单词为空时识别为 auth 错误（接口本身仍返回 code 0）', async () => {
    youdaoAnonymous();
    await expect(youdaoProvider.listRemoteBooks(ctx)).rejects.toMatchObject({ code: 'auth' });
    await expect(youdaoProvider.fetchWords('0', ctx)).rejects.toBeInstanceOf(SourceError);
  });

  it('删除前校验登录：未登录时删除接口虚假成功，provider 必须拒绝', async () => {
    youdaoAnonymous();
    await expect(youdaoProvider.deleteWords('0', [{ word: 'zyzzyva', ref: 'x' }], ctx)).rejects.toMatchObject({ code: 'auth' });
  });

  it('删除按 itemId，缺 ref 与 code≠0 记为失败', async () => {
    const calls = youdaoLoggedIn([on(/itemId=bad/, () => json({ code: 500, msg: 'ERR' }))]);
    const res = await youdaoProvider.deleteWords('0', [{ word: 'a', ref: 'id1' }, { word: 'b' }, { word: 'c', ref: 'bad' }], ctx);
    expect(res.deleted).toEqual(['a']);
    expect(res.failed.map((f) => f.word)).toEqual(['b', 'c']);
    expect(calls.filter((c) => /delete/.test(c.url))).toHaveLength(2);
  });

  it('加回单词后用默认分组的新 itemId 作为删除句柄', async () => {
    youdaoLoggedIn([on(/ajax\/add/, () => json(YD_MISC.add))]);
    const added = await youdaoProvider.addWords!('0', [{ word: 'Algorithm', ref: 'stale' }, { word: 'Missing', ref: 'stale2' }], ctx);
    expect(added[0]!.ref).toBe(YD_WORDS.data.itemList[0].itemId);
    expect(added[1]!.ref).toBeUndefined();
  });
});

describe('欧路 provider', () => {
  const tokenCtx = { settings: { ...ctx.settings, apiToken: 'abc' } };

  it('cookie 模式：只有“全部生词”，与旧版一致不带分类参数，未登录（HTML）识别为 auth', async () => {
    expect(await eudicProvider.listRemoteBooks(ctx)).toEqual([{ remoteId: '-1', name: '全部生词', canAdd: false, readOnlyReason: expect.any(String) }]);
    const calls = mockFetch(on(/WordsDataSource/, () => json({ data: [{ uuid: 'Apple', phon: 'ˈæpl', exp: 'n. 苹果' }] })));
    const words = await eudicProvider.fetchWords('-1', ctx);
    expect(words.apple).toEqual({ word: 'Apple', ref: 'Apple', phonetic: 'ˈæpl', trans: 'n. 苹果' });
    expect(calls[0]!.url).not.toContain('categoryid');
    mockFetch(on(/WordsDataSource/, () => new Response('<html>login</html>', { status: 200 })));
    await expect(eudicProvider.fetchWords('-1', ctx)).rejects.toMatchObject({ code: 'auth' });
  });

  it('OpenAPI：分类列表、page_size=100 分页直到不满一页、NIS 鉴权头', async () => {
    const page = (p: number, n: number) => Array.from({ length: n }, (_, i) => ({ word: `w${p}-${i}`, exp: 'x' }));
    const calls = mockFetch(
      on(/studylist\/category/, () => json(EUDIC.category)),
      (url) => {
        if (!/studylist\/words/.test(url)) return undefined;
        const p = Number(new URL(url).searchParams.get('page'));
        return json({ data: p < 2 ? page(p, 100) : page(p, 7) });
      },
    );
    // 分类可加词；“已掌握单词”作为只读的熟词本追加在最后
    expect(await eudicProvider.listRemoteBooks(tokenCtx)).toEqual([
      { remoteId: '0', name: '我的生词本', canAdd: true },
      { remoteId: '132303016416635230', name: 'nanana3', canAdd: true },
      { remoteId: 'mastered', name: '已掌握单词', role: 'known', canAdd: false, canDelete: false, readOnlyReason: expect.any(String) },
    ]);
    const words = await eudicProvider.fetchWords('0', tokenCtx);
    expect(Object.keys(words)).toHaveLength(207);
    const wordCalls = calls.filter((c) => /studylist\/words/.test(c.url));
    expect(wordCalls).toHaveLength(3);
    expect(wordCalls.every((c) => /page_size=100/.test(c.url))).toBe(true);
    const fn = fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    expect((fn.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe('NIS abc');
  });

  it('OpenAPI：401=auth、403=ratelimit（官方文档：403 为访问过于频繁）', async () => {
    mockFetch(on(/category/, () => json(EUDIC.unauthorized, 401)));
    await expect(eudicProvider.listRemoteBooks(tokenCtx)).rejects.toMatchObject({ code: 'auth' });
    mockFetch(on(/category/, () => new Response('', { status: 403 })));
    await expect(eudicProvider.listRemoteBooks(tokenCtx)).rejects.toMatchObject({ code: 'ratelimit' });
  });

  it('OpenAPI 请求全局串行且间隔不小于节流时间', async () => {
    setOpenApiThrottle(30);
    const times: number[] = [];
    mockFetch((url) => (times.push(Date.now()), /category/.test(url) ? json(EUDIC.category) : undefined));
    await Promise.all([eudicProvider.listRemoteBooks(tokenCtx), eudicProvider.listRemoteBooks(tokenCtx), eudicProvider.listRemoteBooks(tokenCtx)]);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(28);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(28);
  });

  it('OpenAPI 删除按批 DELETE，204 视为成功；加回用 POST', async () => {
    const calls = mockFetch(on(/studylist\/words/, () => new Response(null, { status: 204 })));
    const res = await eudicProvider.deleteWords('0', [{ word: 'Run', ref: 'Run' }, { word: 'ran', ref: 'ran' }], tokenCtx);
    expect(res).toEqual({ deleted: ['Run', 'ran'], failed: [] });
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ language: 'en', category_id: '0', words: ['Run', 'ran'] });
    mockFetch(on(/studylist\/words/, () => json(EUDIC.addWords, 201)));
    expect((await eudicProvider.addWords!('0', [{ word: 'run', ref: 'run' }], tokenCtx)).map((w) => w.word)).toEqual(['run']);
    // cookie 模式没有加词接口、“已掌握”只读：明确报 unsupported（service 按 canAdd 不会调用）
    await expect(eudicProvider.addWords!('-1', [{ word: 'run' }], tokenCtx)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(eudicProvider.addWords!('mastered', [{ word: 'run' }], tokenCtx)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(eudicProvider.deleteWords('mastered', [{ word: 'run' }], tokenCtx)).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('来源同步服务', () => {
  it('按来源同步：刷新列表 -> 各分组独立同步 -> 首次成功自动启用', async () => {
    youdaoLoggedIn();
    const results = await syncSourceBooks({ providerId: 'youdao' });
    expect(results.map((r) => [r.bookId, r.ok, r.count])).toEqual([
      [`src:youdao:${UNGROUPED}`, true, 3],
      ['src:youdao:0', true, 3],
    ]);
    const idx = await getSourceIndex();
    expect(idx.books['src:youdao:0']).toMatchObject({ status: 'ok', wordCount: 3, name: '无标签' });
    expect((await getSourceBook('src:youdao:0'))!.words.algorithm!.word).toBe('Algorithm');
    const enabled = (await getSettings()).books.enabled;
    expect(enabled.slice(0, 2).sort()).toEqual(['src:youdao:0', `src:youdao:${UNGROUPED}`].sort());
  });

  it('迁移来的“全部单词”书被分组取代：新书插到原位置，孤儿书移出启用列表但保留缓存', async () => {
    await patchSourceBookState({ id: 'src:youdao:default', providerId: 'youdao', remoteId: 'default', name: '单词本' }, { status: 'ok', lastSyncAt: 1, wordCount: 1 });
    await saveSourceBook({ id: 'src:youdao:default', words: { run: { word: 'run', ref: '7' } }, updatedAt: 1 });
    await patchSettings({ books: { enabled: ['cet4', 'src:youdao:default', 'cet6'] } });
    youdaoLoggedIn();
    await syncSourceBooks({ providerId: 'youdao' });
    const enabled = (await getSettings()).books.enabled;
    expect(enabled[0]).toBe('cet4');
    expect(enabled.slice(1, 3).sort()).toEqual(['src:youdao:0', `src:youdao:${UNGROUPED}`].sort());
    expect(enabled[3]).toBe('cet6');
    expect(enabled).not.toContain('src:youdao:default');
    expect((await getSourceIndex()).books['src:youdao:default']!.orphaned).toBe(true);
    expect(await getSourceBook('src:youdao:default')).toBeDefined();
  });

  it('列表刷新失败（未登录）：不逐本请求，已登记的书标记 error', async () => {
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'ok', lastSyncAt: 5, wordCount: 3 });
    await saveSourceBook({ id: 'src:youdao:0', words: { a: { word: 'a' } }, updatedAt: 5 });
    const calls = youdaoAnonymous();
    const results = await syncSourceBooks({ providerId: 'youdao' });
    expect(results).toEqual([{ bookId: 'src:youdao:0', ok: false, message: expect.stringContaining('未登录有道') }]);
    expect(calls.some((c) => /webapi\/words/.test(c.url))).toBe(false);
    const idx = await getSourceIndex();
    expect(idx.books['src:youdao:0']).toMatchObject({ status: 'error', lastSyncAt: 5 });
    expect(idx.providers.youdao!.error).toContain('未登录');
    // 失败不清除本地缓存
    expect((await getSourceBook('src:youdao:0'))!.words.a).toBeDefined();
  });

  it('各书独立：一本失败不影响另一本；空结果不覆盖缓存', async () => {
    youdaoLoggedIn([
      (url) => (/bookId=0/.test(url) ? json({ code: 0, data: { total: 0, itemList: [] } }) : undefined),
      (url) => (new URL(url).searchParams.get('bookId') === UNGROUPED ? new Response('boom', { status: 502 }) : undefined),
    ]);
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'ok', lastSyncAt: 5, wordCount: 1 });
    await saveSourceBook({ id: 'src:youdao:0', words: { keep: { word: 'keep' } }, updatedAt: 5 });
    const results = await syncSourceBooks({ providerId: 'youdao' });
    const byId = Object.fromEntries(results.map((r) => [r.bookId, r]));
    // 已确认登录的空分组：请求成功（ok=true + empty），文案与状态一致
    expect(byId['src:youdao:0']).toMatchObject({ ok: true, empty: true, message: MSG_EMPTY_VERIFIED });
    expect(byId[`src:youdao:${UNGROUPED}`]).toMatchObject({ ok: false, message: '有道服务器返回 502' });
    expect((await getSourceBook('src:youdao:0'))!.words.keep).toBeDefined();
    const idx = await getSourceIndex();
    expect(idx.books['src:youdao:0']!.status).toBe('empty');
    expect(idx.books[`src:youdao:${UNGROUPED}`]!.status).toBe('error');
  });

  it('同一本书并发同步只请求一次', async () => {
    const calls = youdaoLoggedIn();
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, {});
    const [a, b] = await Promise.all([syncSourceBook('src:youdao:0'), syncSourceBook('src:youdao:0')]);
    expect(a).toBe(b);
    expect(calls.filter((c) => /webapi\/words/.test(c.url))).toHaveLength(1);
  });

  it('SW 中断导致停在 syncing 的书启动时复位为 error', async () => {
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'syncing' });
    await recoverInterruptedSyncs();
    expect((await getSourceIndex()).books['src:youdao:0']).toMatchObject({ status: 'error', error: '同步被中断，请重试' });
  });

  it('自动同步：新安装默认不启用任何云端来源，后台不发任何请求', async () => {
    const calls = youdaoLoggedIn();
    await autoSyncIfDue(10 * 24 * 3600_000);
    expect(calls).toHaveLength(0);
  });

  it('自动同步：启用但从未同步成功过的来源不自动请求（由用户开启来源时同步）', async () => {
    const now = 10 * 24 * 3600_000;
    await patchSettings({ sources: { youdao: { enabled: true }, eudic: { enabled: true } } });
    const calls = youdaoLoggedIn();
    // 没有任何书
    await autoSyncIfDue(now);
    expect(calls).toHaveLength(0);
    // 列表里有书但从未成功同步（上次失败在很久以前）
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'error', lastSyncAt: 0, lastAttemptAt: 0 });
    await updateSourceIndex((idx) => void (idx.providers.youdao = { lastListAt: 0, error: '未登录' }));
    await autoSyncIfDue(now);
    expect(calls).toHaveLength(0);
  });

  it('自动同步：同步成功过的来源超过 24 小时且距上次尝试超过 1 小时才请求', async () => {
    const now = 10 * 24 * 3600_000;
    await patchSettings({ sources: { youdao: { enabled: true } } });
    const calls = youdaoLoggedIn();
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'ok', lastSyncAt: now - 3600_000, lastAttemptAt: now - 3600_000 });
    await autoSyncIfDue(now);
    expect(calls).toHaveLength(0);
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'error', lastSyncAt: now - 25 * 3600_000, lastAttemptAt: now - 10 * 60_000 });
    await autoSyncIfDue(now);
    expect(calls).toHaveLength(0);
    // autoSync 关闭时不请求
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { lastAttemptAt: now - 2 * 3600_000 });
    await patchSettings({ sources: { youdao: { autoSync: false } } });
    await autoSyncIfDue(now);
    expect(calls).toHaveLength(0);
    await patchSettings({ sources: { youdao: { autoSync: true } } });
    await autoSyncIfDue(now);
    expect(calls.some((c) => /webapi\/books/.test(c.url))).toBe(true);
    expect(calls.some((c) => /webapi\/words/.test(c.url))).toBe(true);
  });
});

describe('旧版迁移与自动同步', () => {
  const now = 10 * 24 * 3600_000;

  it('v2 有道用户：迁移后有道保持启用，超过 24 小时自动同步照常请求', async () => {
    await fakeBrowser.storage.local.set({
      ttsVoices: { lang: 'en' },
      dictionaryType: 0,
      autoSync: true,
      syncTime: now - 2 * 24 * 3600_000,
      newWords: { wordInfos: { run: { word: 'run', itemId: 1 } } },
    });
    expect(await runMigrationIfNeeded()).toBe(true);
    expect((await getSettings()).sources.youdao?.enabled).toBe(true);
    const calls = youdaoLoggedIn();
    await autoSyncIfDue(now);
    expect(calls.some((c) => /dict\.youdao\.com/.test(c.url))).toBe(true);
  });

  it('v2 欧路用户：迁移后欧路保持启用、有道关闭，自动同步只请求欧路', async () => {
    await fakeBrowser.storage.local.set({
      ttsVoices: { lang: 'en' },
      dictionaryType: 1,
      syncTime: now - 2 * 24 * 3600_000,
      newWords: { wordInfos: { apple: { word: 'apple', link: 'Apple' } } },
    });
    expect(await runMigrationIfNeeded()).toBe(true);
    const s = await getSettings();
    expect(s.sources.eudic?.enabled).toBe(true);
    expect(s.sources.youdao?.enabled).toBe(false);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response('', { status: 401 });
    }));
    await autoSyncIfDue(now);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => /eudic|frdic/.test(u))).toBe(true);
  });

  it('新安装：迁移只写默认设置，不启用任何来源，自动同步不发请求', async () => {
    // 全新安装不算迁移（返回 false），只写入默认设置
    expect(await runMigrationIfNeeded()).toBe(false);
    const s = await getSettings();
    expect(Object.values(s.sources).every((src) => !src.enabled)).toBe(true);
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    await autoSyncIfDue(now);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('删词、熟词与撤销', () => {
  async function seedYoudao() {
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { status: 'ok', lastSyncAt: 1, wordCount: 3, canAdd: true });
    await saveSourceBook({
      id: 'src:youdao:0',
      words: { run: { word: 'run', ref: 'i1' }, runs: { word: 'Runs', ref: 'i2' }, runner: { word: 'runner', ref: 'i3' }, apple: { word: 'apple', ref: 'i4' } },
      updatedAt: 1,
    });
  }

  it('deleteOnKnown 关闭：只写熟词本，不请求来源', async () => {
    await seedYoudao();
    const calls = youdaoLoggedIn();
    const res = await markKnown('running', 'run');
    expect(res).toMatchObject({ ok: true, lemma: 'run', deleted: [] });
    expect(calls).toHaveLength(0);
    expect((await getKnownWords()).has('run')).toBe(true);
  });

  it('deleteOnKnown 开启：删除原形相同的全部词形（run/runs），不删 runner；撤销时加回并更新句柄', async () => {
    await seedYoudao();
    await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });
    const calls = youdaoLoggedIn([on(/ajax\/add/, () => json(YD_MISC.add))]);
    const res = await markKnown('running', 'run');
    expect(res.deleted[0]!.deleted.sort()).toEqual(['run', 'runs']);
    expect(res.message).toContain('删除 run、runs');
    expect(calls.filter((c) => /delete\?itemId=/.test(c.url)).map((c) => new URL(c.url).searchParams.get('itemId')).sort()).toEqual(['i1', 'i2']);
    const book = await getSourceBook('src:youdao:0');
    expect(Object.keys(book!.words).sort()).toEqual(['apple', 'runner']);
    expect((await getSourceIndex()).books['src:youdao:0']!.wordCount).toBe(2);

    const undo = await unmarkKnown('run');
    expect(undo.restored!.sort()).toEqual(['run', 'runs']);
    expect((await getKnownWords()).has('run')).toBe(false);
    const after = await getSourceBook('src:youdao:0');
    expect(after!.words.runs!.word).toBe('Runs');
    // fixture 默认分组里没有 run/runs，新句柄缺失时去掉 ref，避免用失效 itemId 误报删除成功
    expect(after!.words.runs!.ref).toBeUndefined();
    // 撤销记录只用一次
    expect((await unmarkKnown('run')).restored).toEqual([]);
  });

  it('来源未登录时熟词照常写入，删除失败写进提示且本地缓存保留', async () => {
    await seedYoudao();
    await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });
    youdaoAnonymous();
    const res = await markKnown('run', 'run');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('删除失败');
    expect((await getKnownWords()).has('run')).toBe(true);
    expect((await getSourceBook('src:youdao:0'))!.words.run).toBeDefined();
  });

  it('deleteSourceWords：部分失败只移除成功的词', async () => {
    await seedYoudao();
    youdaoLoggedIn([on(/itemId=i2/, () => json({ code: 1, msg: 'fail' }))]);
    const res = await deleteFromSources('run', { forms: true, lemmatizer: new SimpleLemmatizer() });
    expect(res.ok).toBe(false);
    expect(res.reports[0]!.deleted).toEqual(['run']);
    expect(res.reports[0]!.failed.map((f) => f.word)).toEqual(['runs']);
    expect(Object.keys((await getSourceBook('src:youdao:0'))!.words).sort()).toEqual(['apple', 'runner', 'runs']);
  });
});
