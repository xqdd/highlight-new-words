import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataLemmatizer, type LemmaDataFile } from '@/core/lemma/data-lemmatizer';
import { getKnownData, getKnownWords, setKnownWords } from '@/core/known/store';
import { LOCAL_KNOWN_BOOK_ID, MY_WORDS_BOOK_ID } from '@/core/settings/schema';
import { getSettings, patchSettings } from '@/core/settings/store';
import { getLocalBook, getSourceBook, getSourceIndex, patchSourceBookState, saveLocalBook, saveSourceBook } from '@/core/wordbook/user-store';
import type { SourceBookState, UserWordMap } from '@/core/wordbook/types';
import { findInflectedForms } from '@/background/forms';
import { youdaoProvider } from '@/background/sources/youdao';
import { setOpenApiThrottle } from '@/background/sources/eudic';
import { deleteFromSources, syncSourceBooks } from '@/background/sources/service';
import { addWord, getWordState, markKnown, previewWordAction, removeWord, setHomographDictionary, unmarkKnown } from '@/background/known';
import { PackagedDictionary } from '@/core/dict/packaged';
import type { DictShardFile } from '@/core/dict/types';

/**
 * 第 2 轮评审阻塞项回归：
 * - F1 删除只用屈折词形（真实 lemma.json 数据，runner/careless/ability 这类派生词绝不删除）
 * - F2 有道同一单词多个 itemId（大小写不同）全部删除才算成功
 * - F4 迁移孤儿书与分组持有同一 itemId 时只请求一次
 * - F5 熟词本多来源、加入生词本、写入/移除目标、同原形开关
 */

const lemmaData = JSON.parse(readFileSync(resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile;
const realLemmatizer = () => {
  const l = new DataLemmatizer();
  l.setData(lemmaData);
  return l;
};
// background 的 getLemmatizer 走 createLemmatizer：这里换成加载了真实数据的 DataLemmatizer（与扩展运行时一致）
vi.mock('@/core/lemma', () => ({
  createLemmatizer: () => {
    const l = new DataLemmatizer();
    l.setData(JSON.parse(readFileSync(resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile);
    return l;
  },
}));

const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, '../fixtures/sources', name), 'utf8'));
const YD_MISC = fixture('youdao-misc.json');
const YD_CASEDUP = fixture('youdao-words-casedup.json');
const EUDIC = fixture('eudic-openapi.json');

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
function mockFetch(...routes: Route[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      for (const r of routes) {
        const res = await r(url, init);
        if (res) return res;
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const on = (re: RegExp, res: () => Response): Route => (url) => (re.test(url) ? res() : undefined);
const deletedItemIds = (calls: { url: string }[]) =>
  calls.filter((c) => /webapi\/delete\?itemId=/.test(c.url)).map((c) => new URL(c.url).searchParams.get('itemId')!);

/** 有道已登录 + 删除/加词成功 */
function youdaoOk(extra: Route[] = []) {
  return mockFetch(...extra, on(/accountinfo/, () => json(YD_MISC.accountinfoLoggedIn)), on(/webapi\/delete/, () => json(YD_MISC.delete)), on(/ajax\/add/, () => json(YD_MISC.add)));
}

async function seedSourceBook(state: Partial<SourceBookState> & Pick<SourceBookState, 'id' | 'providerId' | 'remoteId' | 'name'>, words: UserWordMap) {
  await patchSourceBookState(state, { status: 'ok', lastSyncAt: 1, wordCount: Object.keys(words).length, ...state });
  await saveSourceBook({ id: state.id, words, updatedAt: 1 });
}

/** 有道默认分组：run/care 的屈折形与派生形混在一起，每个词一个 itemId（i-<词>） */
const WORDS = ['run', 'runs', 'ran', 'running', 'runner', 'runners', 'care', 'cares', 'cared', 'caring', 'careful', 'careless', 'carelessly', 'carer', 'able', 'ability', 'apple'];
async function seedYoudaoMixed() {
  const words: UserWordMap = Object.fromEntries(WORDS.map((w) => [w, { word: w, ref: `i-${w}` }]));
  await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, words);
  await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });
}

beforeEach(() => {
  fakeBrowser.reset();
  setOpenApiThrottle(0);
});
afterEach(() => vi.unstubAllGlobals());

describe('F1 删除集合只含屈折词形（真实 lemma 数据）', () => {
  const l = realLemmatizer();
  it('run / care / able：派生词（runner、careful、careless、carelessly、carer、ability）不在删除集合中', () => {
    expect(findInflectedForms('run', WORDS, l).sort()).toEqual(['ran', 'run', 'running', 'runs']);
    expect(findInflectedForms('care', WORDS, l).sort()).toEqual(['care', 'cared', 'cares', 'caring']);
    expect(findInflectedForms('able', WORDS, l)).toEqual(['able']);
    // 不规则形与比较级仍按屈折处理
    expect(findInflectedForms('go', ['went', 'gone', 'goes', 'going', 'goer'], l).sort()).toEqual(['goes', 'going', 'gone', 'went']);
    expect(findInflectedForms('good', ['better', 'best', 'goodness'], l).sort()).toEqual(['best', 'better']);
    // runner 的复数也不是 run 的词形
    expect(findInflectedForms('runner', WORDS, l).sort()).toEqual(['runner', 'runners']);
  });

  it('同原形开关关闭：只处理当前词形与原形本身', () => {
    expect(findInflectedForms('run', WORDS, l, { sameLemma: false, surface: 'running' }).sort()).toEqual(['run', 'running']);
  });

  it('标记 run：只向有道发出 run/runs/ran/running 四个 itemId 的删除', async () => {
    await seedYoudaoMixed();
    const calls = youdaoOk();
    const res = await markKnown('running', 'run');
    expect(deletedItemIds(calls).sort()).toEqual(['i-ran', 'i-run', 'i-running', 'i-runs']);
    expect(res.deleted[0]!.deleted.sort()).toEqual(['ran', 'run', 'running', 'runs']);
    const left = Object.keys((await getSourceBook('src:youdao:0'))!.words);
    expect(left).toContain('runner');
    expect(left).toContain('runners');
  });

  it('标记 care：只删除 care/cares/cared/caring，careful/careless/carelessly/carer 保留', async () => {
    await seedYoudaoMixed();
    const calls = youdaoOk();
    await markKnown('care', 'care');
    expect(deletedItemIds(calls).sort()).toEqual(['i-care', 'i-cared', 'i-cares', 'i-caring']);
    const left = Object.keys((await getSourceBook('src:youdao:0'))!.words);
    for (const w of ['careful', 'careless', 'carelessly', 'carer']) expect(left).toContain(w);
  });

  it('标记 ability（派生词本身）：只删 ability，不删 able', async () => {
    await seedYoudaoMixed();
    const calls = youdaoOk();
    await markKnown('ability', 'ability');
    expect(deletedItemIds(calls)).toEqual(['i-ability']);
  });

  it('卡片“从生词本删除”forms=true 同样只删屈折形', async () => {
    await seedYoudaoMixed();
    const calls = youdaoOk();
    const res = await deleteFromSources('care', { forms: true, lemmatizer: realLemmatizer() });
    expect(res.ok).toBe(true);
    expect(deletedItemIds(calls).sort()).toEqual(['i-care', 'i-cared', 'i-cares', 'i-caring']);
  });

  it('执行前预览列出将删除的远端词形，needsConfirm=true，且不发任何请求', async () => {
    await seedYoudaoMixed();
    const calls = youdaoOk();
    const p = await previewWordAction({ action: 'known', word: 'careless', lemma: 'care' });
    expect(calls).toHaveLength(0);
    expect(p.needsConfirm).toBe(true);
    expect(p.remove).toHaveLength(1);
    // 当前词形 careless 是用户点的词，本身会被处理；careful/carelessly 不会
    expect(p.remove[0]).toMatchObject({ bookId: 'src:youdao:0', name: '有道词典 · 无标签', remote: true, undoable: true });
    expect(p.remove[0]!.words.sort()).toEqual(['care', 'cared', 'careless', 'cares', 'caring']);
    expect(p.write).toEqual([expect.objectContaining({ bookId: LOCAL_KNOWN_BOOK_ID, ok: true })]);
  });
});

describe('F2 有道同一单词的多个条目（真实账号脱敏样例：Zyzzyva / zyzzyva）', () => {
  function youdaoWithDup(extra: Route[] = []) {
    return youdaoOk([...extra, on(/webapi\/words/, () => json(YD_CASEDUP))]);
  }
  const ids = YD_CASEDUP.data.itemList.map((i: { itemId: string }) => i.itemId) as string[];

  it('拉取时保留全部 itemId；条目数与网页一致', async () => {
    youdaoWithDup();
    const words = await youdaoProvider.fetchWords('0', { settings: { enabled: true, autoSync: true, deleteOnKnown: false } });
    expect(Object.keys(words)).toEqual(['zyzzyva']);
    expect(words.zyzzyva!.refs!.sort()).toEqual([...ids].sort());
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, {});
    const [r] = await syncSourceBooks({ bookIds: ['src:youdao:0'] });
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(r!.message).toContain('重复条目');
    expect((await getSourceIndex()).books['src:youdao:0']).toMatchObject({ wordCount: 1, entryCount: 2 });
  });

  it('删除时逐个删除全部 itemId，全部成功才报告成功', async () => {
    const calls = youdaoWithDup();
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, {});
    await syncSourceBooks({ bookIds: ['src:youdao:0'] });
    const res = await deleteFromSources('zyzzyva', { forms: false, lemmatizer: realLemmatizer() });
    expect(res.ok).toBe(true);
    expect(deletedItemIds(calls).sort()).toEqual([...ids].sort());
    expect((await getSourceBook('src:youdao:0'))!.words.zyzzyva).toBeUndefined();
  });

  it('其中一个条目删除失败：报告失败、保留本地缓存，不显示“删除成功”', async () => {
    const calls = youdaoWithDup([(url) => (url.includes(`itemId=${ids[1]}`) ? json({ code: 1, msg: 'FAIL' }) : undefined)]);
    await patchSourceBookState({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, {});
    await syncSourceBooks({ bookIds: ['src:youdao:0'] });
    const res = await deleteFromSources('zyzzyva', { forms: false, lemmatizer: realLemmatizer() });
    expect(res.ok).toBe(false);
    expect(res.message).not.toContain('删除成功');
    expect(res.message).toContain('2 个条目中 1 个删除失败');
    expect(deletedItemIds(calls)).toHaveLength(2);
    expect((await getSourceBook('src:youdao:0'))!.words.zyzzyva).toBeDefined();
  });
});

describe('F4 迁移来的孤儿书', () => {
  it('孤儿书（未启用、与分组持有同一 itemId）：同一 itemId 只请求一次，孤儿书缓存同步清理', async () => {
    await seedSourceBook({ id: 'src:youdao:default', providerId: 'youdao', remoteId: 'default', name: '单词本', orphaned: true }, { run: { word: 'run', ref: '11' } });
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true }, { run: { word: 'run', ref: '11' } });
    await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });
    const calls = youdaoOk();
    await markKnown('run', 'run');
    expect(deletedItemIds(calls)).toEqual(['11']);
    expect((await getSourceBook('src:youdao:default'))!.words.run).toBeUndefined();
  });

  it('未孤立但两本书持有同一 itemId（显式 bookIds）：也只请求一次', async () => {
    await seedSourceBook({ id: 'src:youdao:default', providerId: 'youdao', remoteId: 'default', name: '单词本' }, { run: { word: 'run', ref: '11' } });
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签' }, { run: { word: 'run', ref: '11' } });
    const calls = youdaoOk();
    const res = await deleteFromSources('run', { forms: false, lemmatizer: realLemmatizer(), bookIds: ['src:youdao:default', 'src:youdao:0'] });
    expect(res.ok).toBe(true);
    expect(deletedItemIds(calls)).toEqual(['11']);
  });
});

describe('F5 熟词本多来源与单词操作配置', () => {
  const tokenSettings = { sources: { eudic: { enabled: true, apiToken: 'abc' } } };
  function eudicApi() {
    return mockFetch(
      on(/studylist\/category/, () => json(EUDIC.category)),
      on(/studylist\/mastered_words/, () => json(EUDIC.mastered)),
      (url, init) => {
        if (!/studylist\/words/.test(url)) return undefined;
        if (init?.method === 'POST') return json(EUDIC.addWords, 201);
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return json(EUDIC.words);
      },
    );
  }

  it('欧路“已掌握单词”同步为熟词本：进 knownBooks.enabled 而不是高亮词书，参与熟词判定', async () => {
    await patchSettings(tokenSettings);
    eudicApi();
    await syncSourceBooks({ providerId: 'eudic' });
    const s = await getSettings();
    expect(s.knownBooks.enabled).toEqual(['src:eudic:mastered']);
    expect(s.books.enabled).not.toContain('src:eudic:mastered');
    expect(s.books.enabled).toContain('src:eudic:0');
    expect((await getSourceIndex()).books['src:eudic:mastered']).toMatchObject({ role: 'known', canAdd: false, canDelete: false });
    const known = await getKnownWords();
    expect(known.has('careful')).toBe(true);
    // 本地熟词本未被污染（storage.sync 只同步本地熟词）
    expect(Object.keys((await getKnownData()).words)).toEqual([]);
    // 用户把角色改回 new 后不再作为熟词
    await patchSettings({ knownBooks: { roles: { 'src:eudic:mastered': 'new' } } });
    expect((await getKnownWords()).has('careful')).toBe(false);
  });

  it('认识：写入目标为只读的“已掌握”时跳过并说明，兜底写本地熟词本', async () => {
    await patchSettings(tokenSettings);
    eudicApi();
    await syncSourceBooks({ providerId: 'eudic' });
    await patchSettings({ wordActions: { knownTargets: ['src:eudic:mastered'] } });
    const res = await markKnown('run', 'run');
    expect(res.written![0]).toMatchObject({ bookId: 'src:eudic:mastered', ok: false, skipped: true });
    expect(res.written![1]).toMatchObject({ bookId: LOCAL_KNOWN_BOOK_ID, ok: true });
    expect(res.message).toContain('已掌握');
    expect((await getKnownWords()).has('run')).toBe(true);
  });

  it('认识：显式移除目标（本地词书 + 欧路分类），撤销时本地完整恢复、欧路加回', async () => {
    await patchSettings(tokenSettings);
    const calls = eudicApi();
    await syncSourceBooks({ providerId: 'eudic' });
    await saveSourceBook({ id: 'src:eudic:0', words: { action: { word: 'action', ref: 'action' }, actions: { word: 'actions', ref: 'actions' }, activity: { word: 'activity', ref: 'activity' } }, updatedAt: 2 });
    const book = await saveLocalBook({ id: 'local:b1', name: '导入', format: 'txt', words: [{ word: 'action', trans: '行动' }, { word: 'actor' }] });
    await patchSettings({ wordActions: { knownRemoveFrom: [book.id, 'src:eudic:0'] } });
    const res = await markKnown('actions', 'action');
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(JSON.parse(del.body!).words.sort()).toEqual(['action', 'actions']);
    expect(res.fullyUndoable).toBe(true);
    expect(Object.keys((await getLocalBook(book.id))!.words)).toEqual(['actor']);
    const undo = await unmarkKnown('action');
    expect(undo.restored!.sort()).toEqual(['action', 'actions']);
    expect((await getLocalBook(book.id))!.words.action!.trans).toBe('行动');
    const post = calls.filter((c) => c.method === 'POST');
    expect(JSON.parse(post[0]!.body!)).toMatchObject({ category_id: '0', words: ['action', 'actions'] });
  });

  it('加入生词本：默认写入自动创建的“我的生词本”并启用，同时移出本地熟词本（屈折词形一起）', async () => {
    await setKnownWords(['run', 'runs', 'runner'], true);
    const res = await addWord({ word: 'running', lemma: 'run', trans: 'v. 跑' });
    expect(res.ok).toBe(true);
    expect(res.added).toEqual([expect.objectContaining({ bookId: MY_WORDS_BOOK_ID, ok: true, words: ['run'] })]);
    expect((await getLocalBook(MY_WORDS_BOOK_ID))!.words.run).toEqual({ word: 'run', trans: 'v. 跑' });
    expect((await getSettings()).books.enabled[0]).toBe(MY_WORDS_BOOK_ID);
    const known = await getKnownWords();
    expect(known.has('run')).toBe(false);
    expect(known.has('runs')).toBe(false);
    expect(known.has('runner')).toBe(true);
    expect(await getWordState('run')).toMatchObject({ collected: true, known: false });

    // 移出生词本 = 撤销加入：熟词加回
    const rm = await removeWord({ lemma: 'run' });
    expect(rm.ok).toBe(true);
    expect((await getLocalBook(MY_WORDS_BOOK_ID))!.words.run).toBeUndefined();
    expect((await getKnownWords()).has('runs')).toBe(true);
  });

  it('加入生词本：来源目标按能力处理（欧路分类 POST 写入；有道非默认分组跳过并说明）', async () => {
    await patchSettings(tokenSettings);
    const calls = eudicApi();
    await syncSourceBooks({ providerId: 'eudic' });
    await seedSourceBook({ id: 'src:youdao:g1', providerId: 'youdao', remoteId: 'g1', name: '考研', canAdd: false, readOnlyReason: '有道的加词接口只能加入默认分组“无标签”' }, {});
    await patchSettings({ wordActions: { addTargets: ['src:eudic:132303016416635230', 'src:youdao:g1'] } });
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva' });
    expect(res.added[0]).toMatchObject({ ok: true, words: ['zyzzyva'] });
    expect(res.added[1]).toMatchObject({ ok: false, skipped: true });
    expect(res.message).toContain('默认分组');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({ language: 'en', category_id: '132303016416635230', words: ['zyzzyva'] });
    expect((await getSourceBook('src:eudic:132303016416635230'))!.words.zyzzyva).toBeDefined();
  });

  it('加入生词本时词在只读来源熟词本（欧路已掌握）中：说明仍不会高亮', async () => {
    await patchSettings(tokenSettings);
    eudicApi();
    await syncSourceBooks({ providerId: 'eudic' });
    await patchSettings({ wordActions: { addRemoveFromKnown: [LOCAL_KNOWN_BOOK_ID, 'src:eudic:mastered'] } });
    const res = await addWord({ word: 'careful', lemma: 'careful' });
    expect(res.removedKnown).toEqual([expect.objectContaining({ bookId: 'src:eudic:mastered', ok: false, skipped: true })]);
    expect(res.message).toContain('不会高亮');
  });
});

describe('第 3 轮：O1–O4', () => {
  const tokenSettings = { sources: { eudic: { enabled: true, apiToken: 'abc' } } };
  /** 从磁盘读打包词典分片（与扩展运行时 data/dict 一致），用于同形异义判定 */
  const diskDict = () =>
    new PackagedDictionary(async (p) => JSON.parse(readFileSync(resolve(__dirname, '../../public/data/dict', `${p}.json`), 'utf8')) as DictShardFile);
  afterEach(() => setHomographDictionary(undefined));

  it('O1 欧路列分组首个请求网络错误：GET 自动重试，整轮同步成功；写请求（POST）不重试', async () => {
    await patchSettings(tokenSettings);
    let categoryCalls = 0;
    let postCalls = 0;
    mockFetch(
      (url) => {
        if (!/studylist\/category/.test(url)) return undefined;
        if (++categoryCalls === 1) throw new TypeError('Failed to fetch');
        return json(EUDIC.category);
      },
      on(/studylist\/mastered_words/, () => json(EUDIC.mastered)),
      (url, init) => {
        if (!/studylist\/words/.test(url)) return undefined;
        if (init?.method === 'POST') {
          postCalls++;
          throw new TypeError('Failed to fetch');
        }
        return json(EUDIC.words);
      },
    );
    const results = await syncSourceBooks({ providerId: 'eudic' });
    expect(categoryCalls).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
    await patchSettings({ wordActions: { addTargets: ['src:eudic:0'] } });
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva' });
    expect(postCalls).toBe(1);
    expect(res.added[0]).toMatchObject({ ok: false });
  });

  it('O2 默认 auto：认识后从“我的生词本”移除，卡片状态不再同时显示已收藏与熟词；撤销后加回', async () => {
    await addWord({ word: 'run', lemma: 'run', trans: '跑' });
    expect(await getWordState('run')).toMatchObject({ collected: true, known: false });
    const res = await markKnown('running', 'run');
    expect(res.removedLocal).toEqual([expect.objectContaining({ bookId: MY_WORDS_BOOK_ID, ok: true, words: ['run'] })]);
    expect(await getWordState('run')).toMatchObject({ collected: false, known: true });
    await unmarkKnown('run');
    expect(await getWordState('run')).toMatchObject({ collected: true, known: false });
    expect((await getLocalBook(MY_WORDS_BOOK_ID))!.words.run!.trans).toBe('跑');
  });

  it('O3 撤销文案与行为一致：可加回原书不提示；只能加回默认分组时说明去向；加不回时才说“不会恢复”', async () => {
    // 有道非默认分组（不能加词）+ 默认分组可加词 -> fallback
    await seedSourceBook({ id: 'src:youdao:g1', providerId: 'youdao', remoteId: 'g1', name: '考研', canAdd: false, canDelete: true }, { run: { word: 'run', ref: 'i1' } });
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, {});
    await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });
    // 加词后 provider 会重新拉取默认分组以取得新 itemId
    youdaoOk([on(/webapi\/words/, () => json(YD_CASEDUP))]);
    const res = await markKnown('run', 'run');
    expect(res.fullyUndoable).toBe(false);
    expect(res.message).toContain('撤销时 run 会加回“有道词典 · 无标签”');
    expect(res.message).not.toContain('不会恢复');
    const undo = await unmarkKnown('run');
    expect(undo.message).toContain('已加回“无标签”');

    // 原书可加词：不提示撤销去向
    fakeBrowser.reset();
    await seedYoudaoMixed();
    youdaoOk();
    const ok = await markKnown('apple', 'apple');
    expect(ok.fullyUndoable).toBe(true);
    expect(ok.message).not.toMatch(/撤销/);
  });

  it('O4 同形异义：标记 lie 时生词本里的 lay/lain 中 lay 是独立单词——未带 confirmed 不删除，带 confirmed 才删除', async () => {
    setHomographDictionary(diskDict());
    const words: UserWordMap = Object.fromEntries(['lie', 'lies', 'lay', 'lain', 'lying', 'find', 'found', 'finds'].map((w) => [w, { word: w, ref: `i-${w}` }]));
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, words);
    await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });

    const preview = await previewWordAction({ action: 'known', word: 'lie', lemma: 'lie' });
    expect(preview.needsConfirm).toBe(true);
    expect(preview.remove[0]!.homographs).toEqual(['lay']);

    let calls = youdaoOk();
    const res = await markKnown('lie', 'lie');
    expect(deletedItemIds(calls).sort()).toEqual(['i-lain', 'i-lie', 'i-lies', 'i-lying']);
    expect(res.withheld).toEqual([{ bookId: 'src:youdao:0', name: '有道词典 · 无标签', words: ['lay'] }]);
    expect(res.message).toContain('lay 也是独立的单词');
    expect((await getSourceBook('src:youdao:0'))!.words.lay).toBeDefined();

    calls = youdaoOk();
    const res2 = await markKnown('lie', 'lie', { confirmed: true });
    expect(deletedItemIds(calls)).toEqual(['i-lay']);
    expect(res2.withheld).toBeUndefined();

    // find -> found（也是“创立”）同样需要确认；finds 是规则变化，直接删除
    calls = youdaoOk();
    const r3 = await markKnown('find', 'find');
    expect(deletedItemIds(calls).sort()).toEqual(['i-find', 'i-finds']);
    expect(r3.withheld![0]!.words).toEqual(['found']);
  });

  it('O4 用户点的就是该词形（页面上的 found 还原为 find）：视为用户本意，不拦截', async () => {
    setHomographDictionary(diskDict());
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, { find: { word: 'find', ref: 'i-find' }, found: { word: 'found', ref: 'i-found' } });
    await patchSettings({ sources: { youdao: { enabled: true, deleteOnKnown: true } } });
    const calls = youdaoOk();
    const res = await markKnown('found', 'find');
    expect(deletedItemIds(calls).sort()).toEqual(['i-find', 'i-found']);
    expect(res.withheld).toBeUndefined();
  });
});

describe('第二阶段 F1：addWord 的 targets 完全取代默认 addTargets', () => {
  it('T1 targets=[local:other]：只写入 local:other，“我的生词本”与远端来源都不写', async () => {
    const other = await saveLocalBook({ id: 'local:other', name: '其他', format: 'txt', words: [] });
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, {});
    await patchSettings({ sources: { youdao: { enabled: true } }, wordActions: { addTargets: [MY_WORDS_BOOK_ID, 'src:youdao:0'] } });
    const calls = youdaoOk();
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva', targets: [other.id] });
    expect(res.ok).toBe(true);
    expect(res.added.map((a) => a.bookId)).toEqual([other.id]);
    expect((await getLocalBook(other.id))!.words.zyzzyva).toBeDefined();
    expect(await getLocalBook(MY_WORDS_BOOK_ID)).toBeUndefined();
    expect(calls.filter((c) => /ajax\/add/.test(c.url))).toHaveLength(0);
  });

  it('B3：有道加词接口返回 500 时 added 记 ok=false 并带原因，toast 文案为“加入失败”而不是“已加入”', async () => {
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, {});
    await patchSettings({ sources: { youdao: { enabled: true } }, wordActions: { addTargets: ['src:youdao:0'] } });
    const calls = mockFetch(on(/accountinfo/, () => json(YD_MISC.accountinfoLoggedIn)), on(/wordbook\/webapi\/v2\/ajax\/add/, () => new Response('oops', { status: 500 })));
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva' });
    expect(calls.filter((c) => /ajax\/add/.test(c.url))).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.added).toEqual([expect.objectContaining({ bookId: 'src:youdao:0', ok: false, words: [], error: '有道服务器返回 500' })]);
    expect(res.message).toContain('加入失败');
    expect(res.message).toContain('有道服务器返回 500');
    expect(res.message).not.toContain('已加入');
    expect((await getSourceBook('src:youdao:0'))!.words.zyzzyva).toBeUndefined();
  });

  it('B3：有道加词返回 code≠0 时同样判为失败', async () => {
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, {});
    await patchSettings({ sources: { youdao: { enabled: true } }, wordActions: { addTargets: ['src:youdao:0'] } });
    mockFetch(on(/accountinfo/, () => json(YD_MISC.accountinfoLoggedIn)), on(/ajax\/add/, () => json({ code: 4001, msg: 'LIMIT' })));
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva' });
    expect(res.ok).toBe(false);
    expect(res.added[0]).toMatchObject({ ok: false, error: '有道返回错误：LIMIT' });
    expect(res.message).toContain('加入失败');
  });

  it('T2 启用有道且默认 addTargets 含有道：targets=[我的生词本] 时有道加词接口调用 0 次', async () => {
    await seedSourceBook({ id: 'src:youdao:0', providerId: 'youdao', remoteId: '0', name: '无标签', canAdd: true, canDelete: true }, {});
    await patchSettings({ sources: { youdao: { enabled: true } }, wordActions: { addTargets: ['src:youdao:0'] } });
    const calls = youdaoOk();
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva', targets: [MY_WORDS_BOOK_ID] });
    expect(res.added).toEqual([expect.objectContaining({ bookId: MY_WORDS_BOOK_ID, ok: true })]);
    expect(calls.filter((c) => /ajax\/add/.test(c.url))).toHaveLength(0);
    expect((await getSourceBook('src:youdao:0'))!.words.zyzzyva).toBeUndefined();
  });

  it('未知 id 过滤、只读目标跳过并说明；空数组/全部未知视为非法，不回退默认目标', async () => {
    await seedSourceBook({ id: 'src:eudic:mastered', providerId: 'eudic', remoteId: 'mastered', name: '已掌握单词', canAdd: false, readOnlyReason: '欧路只提供读取已掌握单词的接口' }, {});
    const res = await addWord({ word: 'zyzzyva', lemma: 'zyzzyva', targets: ['local:nope', 'src:eudic:mastered', MY_WORDS_BOOK_ID] });
    expect(res.added.map((a) => [a.bookId, a.ok])).toEqual([
      ['src:eudic:mastered', false],
      [MY_WORDS_BOOK_ID, true],
    ]);
    expect(res.message).toContain('已掌握');

    const empty = await addWord({ word: 'quux', lemma: 'quux', targets: [] });
    expect(empty).toMatchObject({ ok: false, added: [] });
    expect(empty.message).toContain('未选择');
    const unknown = await addWord({ word: 'quux', lemma: 'quux', targets: ['local:gone'] });
    expect(unknown).toMatchObject({ ok: false, added: [] });
    expect((await getLocalBook(MY_WORDS_BOOK_ID))!.words.quux).toBeUndefined();
  });
});
