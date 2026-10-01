import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataLemmatizer, type LemmaDataFile } from '@/core/lemma/data-lemmatizer';
import { patchSettings } from '@/core/settings/store';
import { getSourceBook, saveSourceBook } from '@/core/wordbook/user-store';
import { setOpenApiThrottle } from '@/background/sources/eudic';
import { syncSourceBooks } from '@/background/sources/service';
import { addWord, markKnown, unmarkKnown } from '@/background/known';
import { youdaoProvider } from '@/background/sources/youdao';

/**
 * background 集成审核第 1 轮（audit）P2 回归：
 * - 认识/撤销时来源接口瞬时网络错误（fetch 抛 TypeError，无响应）自动重试
 * - 撤销加回来源词书后保留删除前缓存的释义与音标
 * - 浏览器重启（storage.session 清空）后撤销仍能加回远端删除的词；记录过期时说明未加回
 */

vi.mock('@/core/lemma', () => ({
  createLemmatizer: () => {
    const l = new DataLemmatizer();
    l.setData(JSON.parse(readFileSync(resolve(__dirname, '../../public/data/lemma/lemma.json'), 'utf8')) as LemmaDataFile);
    return l;
  },
}));

const EUDIC = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/sources/eudic-openapi.json'), 'utf8'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * 欧路 OpenAPI 模拟：failWrites 指定前 N 次写请求（POST/DELETE）抛网络层错误（与 node/Chrome 的 fetch failed 一致）
 */
function eudicApi(opts: { failWrites?: number } = {}) {
  let failWrites = opts.failWrites ?? 0;
  const calls: { url: string; method: string; body?: string; failed?: boolean }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const call = { url, method, body: init?.body as string | undefined, failed: false };
      calls.push(call);
      if (/studylist\/category/.test(url)) return json(EUDIC.category);
      if (/studylist\/mastered_words/.test(url)) return json(EUDIC.mastered);
      if (/studylist\/words/.test(url)) {
        if (method !== 'GET' && failWrites > 0) {
          failWrites--;
          call.failed = true;
          throw new TypeError('fetch failed');
        }
        if (method === 'POST') return json(EUDIC.addWords, 201);
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return json(EUDIC.words);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}

/** 欧路“测试”分组：zyzzyva 带音标与释义（打包词典没有的冷僻词只能靠来源释义） */
async function seedEudic() {
  await patchSettings({ sources: { eudic: { enabled: true, apiToken: 'abc', deleteOnKnown: true } } });
  await syncSourceBooks({ providerId: 'eudic' });
  await saveSourceBook({
    id: 'src:eudic:0',
    words: {
      zyzzyva: { word: 'zyzzyva', ref: 'zyzzyva', phonetic: 'ˈzɪzəvə', trans: 'n. 象鼻虫' },
      zyzzyvas: { word: 'zyzzyvas', ref: 'zyzzyvas', trans: 'n. 象鼻虫（复数）' },
      apple: { word: 'apple', ref: 'apple' },
    },
    updatedAt: 2,
  });
}

beforeEach(() => {
  fakeBrowser.reset();
  setOpenApiThrottle(0);
});
afterEach(() => vi.unstubAllGlobals());

describe('A1 写请求网络层错误自动重试', () => {
  it('认识：DELETE 第一次 fetch failed，自动重试后远端删除成功', async () => {
    eudicApi();
    await seedEudic();
    const calls = eudicApi({ failWrites: 1 });
    const res = await markKnown('zyzzyvas', 'zyzzyva');
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.failed).toBe(true);
    expect(res.deleted[0]!.failed).toEqual([]);
    expect(res.deleted[0]!.deleted.sort()).toEqual(['zyzzyva', 'zyzzyvas']);
    expect(Object.keys((await getSourceBook('src:eudic:0'))!.words)).toEqual(['apple']);
  });

  it('连续网络错误超过重试次数：报告失败、保留本地缓存', async () => {
    eudicApi();
    await seedEudic();
    const calls = eudicApi({ failWrites: 10 });
    const res = await markKnown('zyzzyva', 'zyzzyva');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(3);
    expect(res.deleted[0]!.failed.map((f) => f.word).sort()).toEqual(['zyzzyva', 'zyzzyvas']);
    expect(Object.keys((await getSourceBook('src:eudic:0'))!.words).sort()).toEqual(['apple', 'zyzzyva', 'zyzzyvas']);
  });
});

describe('A2 撤销加回来源词书保留释义与音标', () => {
  it('认识 -> 撤销：加回后缓存仍有 trans/phonetic，并带新句柄', async () => {
    eudicApi();
    await seedEudic();
    await markKnown('zyzzyva', 'zyzzyva');
    expect((await getSourceBook('src:eudic:0'))!.words.zyzzyva).toBeUndefined();
    const undo = await unmarkKnown('zyzzyva');
    expect(undo.restored!.sort()).toEqual(['zyzzyva', 'zyzzyvas']);
    const words = (await getSourceBook('src:eudic:0'))!.words;
    expect(words.zyzzyva).toEqual({ word: 'zyzzyva', ref: 'zyzzyva', phonetic: 'ˈzɪzəvə', trans: 'n. 象鼻虫' });
    expect(words.zyzzyvas).toMatchObject({ trans: 'n. 象鼻虫（复数）', ref: 'zyzzyvas' });
  });
});

describe('A2b 审核复现路径：卡片“加入”不带释义的已缓存词，再认识 -> 撤销', () => {
  it('加入时不覆盖同步来的释义/音标，撤销加回后仍保留', async () => {
    eudicApi();
    await seedEudic();
    await patchSettings({ wordActions: { addTargets: ['src:eudic:0'] } });
    const calls = eudicApi();
    await addWord({ word: 'zyzzyva', lemma: 'zyzzyva' });
    // 远端只收单词
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!).words).toEqual(['zyzzyva']);
    expect((await getSourceBook('src:eudic:0'))!.words.zyzzyva).toMatchObject({ phonetic: 'ˈzɪzəvə', trans: 'n. 象鼻虫' });
    await markKnown('zyzzyva', 'zyzzyva');
    await unmarkKnown('zyzzyva');
    expect((await getSourceBook('src:eudic:0'))!.words.zyzzyva).toEqual({ word: 'zyzzyva', ref: 'zyzzyva', phonetic: 'ˈzɪzəvə', trans: 'n. 象鼻虫' });
  });

  it('新词加入来源词书：缓存带卡片释义', async () => {
    eudicApi();
    await seedEudic();
    await patchSettings({ wordActions: { addTargets: ['src:eudic:0'] } });
    await addWord({ word: 'quokka', lemma: 'quokka', trans: 'n. 短尾矮袋鼠' });
    expect((await getSourceBook('src:eudic:0'))!.words.quokka).toEqual({ word: 'quokka', ref: 'quokka', trans: 'n. 短尾矮袋鼠' });
  });
});

describe('A1b 有道网络层错误重试', () => {
  it('删除请求第一次 fetch 抛错：重试后成功；加词不重试', async () => {
    let deleteCalls = 0;
    let addCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (/accountinfo/.test(url)) return json({ code: 0 });
        if (/webapi\/delete/.test(url)) {
          if (++deleteCalls === 1) throw new TypeError('fetch failed');
          return json({ code: 0 });
        }
        if (/ajax\/add/.test(url)) {
          addCalls++;
          throw new TypeError('fetch failed');
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const ctx = { settings: { enabled: true, autoSync: false, deleteOnKnown: false } };
    const res = await youdaoProvider.deleteWords('0', [{ word: 'run', ref: 'i1' }], ctx);
    expect(res).toEqual({ deleted: ['run'], failed: [] });
    expect(deleteCalls).toBe(2);
    await expect(youdaoProvider.addWords!('0', [{ word: 'run' }], ctx)).rejects.toThrow('无法连接有道服务器');
    expect(addCalls).toBe(1);
  });
});

describe('A4 撤销记录跨浏览器重启', () => {
  it('storage.session 清空后撤销仍加回远端删除的词', async () => {
    eudicApi();
    await seedEudic();
    const calls = eudicApi();
    await markKnown('zyzzyva', 'zyzzyva');
    // 模拟浏览器重启：session 存储清空
    await fakeBrowser.storage.session.clear();
    const undo = await unmarkKnown('zyzzyva');
    expect(undo.restored!.sort()).toEqual(['zyzzyva', 'zyzzyvas']);
    expect(JSON.parse(calls.filter((c) => c.method === 'POST')[0]!.body!).words.sort()).toEqual(['zyzzyva', 'zyzzyvas']);
  });

  it('撤销记录超过 10 分钟：说明来源中删除的词未加回', async () => {
    eudicApi();
    await seedEudic();
    eudicApi();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await markKnown('zyzzyva', 'zyzzyva');
    spy.mockReturnValue(now + 11 * 60 * 1000);
    const undo = await unmarkKnown('zyzzyva');
    spy.mockRestore();
    expect(undo.restored).toEqual([]);
    expect(undo.message).toContain('撤销记录已失效');
    expect(undo.message).toContain('未加回');
  });
});
