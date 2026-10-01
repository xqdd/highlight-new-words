import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CompositeDictionary, PackagedDictionary, parseForms } from '@/core/dict/packaged';
import type { DictShardFile } from '@/core/dict/types';
import { createUserWordBook, UserBooksDictionary } from '@/core/wordbook/user-book';
import { DefaultWordBookRegistry, localBookMeta, type RegistryLoaders } from '@/core/wordbook/registry';
import type { BookCatalog, BookDataFile, CatalogBookMeta } from '@/core/wordbook/types';

/**
 * data 分片单测：registry 的嵌套词书加载、打包词典两层懒加载，以及 public/data 产物的完整性与“常用词误报”回归。
 * 产物由 scripts/data/build-data.mjs 生成，改动构建规则后需重新生成并通过本测试。
 */

const DATA = path.resolve(__dirname, '../../public/data');
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')) as T;

const catalogMeta = (id: string, size = 0): CatalogBookMeta => ({ id, name: id, nameEn: id, short: id, category: 'level', level: 1, size });

function memoryLoaders(catalog: BookCatalog, files: Record<string, BookDataFile>): RegistryLoaders & { book: ReturnType<typeof vi.fn> } {
  return {
    catalog: async () => catalog,
    book: vi.fn(async (id: string) => {
      const f = files[id];
      if (!f) throw new Error('404 ' + id);
      return f;
    }),
    sourceIndex: async () => ({ books: {}, providers: {} }),
    sourceBook: async () => undefined,
    localIndex: async () => ({ books: {}, removed: {} }),
    localBook: async () => undefined,
  };
}

describe('DefaultWordBookRegistry 嵌套词书（extends）', () => {
  const files: Record<string, BookDataFile> = {
    c2: { id: 'c2', words: ['obfuscate'] },
    c1: { id: 'c1', words: ['scrutinize'], extends: ['c2'] },
    b2: { id: 'b2', words: ['vulnerable'], extends: ['c1'] },
    loop: { id: 'loop', words: ['x'], extends: ['loop'] },
  };
  const catalog: BookCatalog = { version: 2, books: ['c2', 'c1', 'b2', 'loop'].map((id) => catalogMeta(id)) };

  it('递归合并 extends 的词，共享文件只加载一次', async () => {
    const loaders = memoryLoaders(catalog, files);
    const reg = new DefaultWordBookRegistry(loaders);
    const [b2, c1] = await Promise.all([reg.load('b2'), reg.load('c1')]);
    expect([...b2!.words()].sort()).toEqual(['obfuscate', 'scrutinize', 'vulnerable']);
    expect(b2!.has('obfuscate')).toBe(true);
    expect(c1!.size).toBe(2);
    expect(loaders.book.mock.calls.map((c) => c[0]).filter((id) => id === 'c2')).toHaveLength(1);
  });

  it('循环引用不死循环', async () => {
    const reg = new DefaultWordBookRegistry(memoryLoaders(catalog, files));
    expect((await reg.load('loop'))!.size).toBe(1);
  });
});

describe('PackagedDictionary 两层分片', () => {
  const shards: Record<string, DictShardFile> = {
    w: { width: { p: 'widθ', s: '宽度', g: 'cet4 cet6', l: 4, r: 6752 } },
    'full/w': { width: { f: 'n. 宽度, 宽广', x: 's:widths' } },
    // 旧格式：f 直接在短表中
    o: { old: { s: '旧的', f: 'a. 旧的, 老的' } },
  };

  it('lookupMany 只读短表，lookup 补齐完整释义与词形', async () => {
    const load = vi.fn(async (p: string) => shards[p] ?? {});
    const dict = new PackagedDictionary(load);
    const many = await dict.lookupMany(['Width', 'nope']);
    expect(many.get('width')).toMatchObject({ short: '宽度', full: '宽度', tags: ['cet4', 'cet6'], level: 4, rank: 6752 });
    expect(many.has('nope')).toBe(false);
    expect(load.mock.calls.map((c) => c[0])).not.toContain('full/w');

    const one = await dict.lookup('width');
    expect(one).toMatchObject({ full: 'n. 宽度, 宽广', forms: [{ type: 's', word: 'widths' }] });
    expect((await dict.lookup('old'))?.full).toBe('a. 旧的, 老的');
  });

  it('parseForms 只保留屈折类型并展开多个词形', () => {
    expect(parseForms('p:went/d:gone/0:go/i:going,goin')).toEqual([
      { type: 'p', word: 'went' },
      { type: 'd', word: 'gone' },
      { type: 'i', word: 'going' },
      { type: 'i', word: 'goin' },
    ]);
    expect(parseForms('')).toBeUndefined();
  });

  it('CompositeDictionary.lookup：用户词书释义优先，打包词典补齐级别/词形', async () => {
    const packaged = new PackagedDictionary(async (p) => shards[p] ?? {});
    const meta = localBookMeta({ id: 'local:1', name: 't', format: 'txt', wordCount: 1, createdAt: 0, updatedAt: 0 });
    const user = new UserBooksDictionary([createUserWordBook(meta, { width: { word: 'width', trans: '宽' } })]);
    const e = await new CompositeDictionary([user, packaged]).lookup('width');
    expect(e).toMatchObject({ short: '宽', level: 4, forms: [{ type: 's', word: 'widths' }] });
  });
});

// ---------------------------------------------------------------------------
// 产物完整性
// ---------------------------------------------------------------------------

const catalog = readJson<BookCatalog>('books/index.json');
const fileCache = new Map<string, BookDataFile>();
const bookFile = (id: string) => {
  let f = fileCache.get(id);
  if (!f) {
    f = readJson<BookDataFile>(`books/${id}.json`);
    fileCache.set(id, f);
  }
  return f;
};
/** 与 registry 相同的合并规则 */
function bookWords(id: string): Set<string> {
  const f = bookFile(id);
  return new Set([...f.words, ...(f.extends ?? []).flatMap((p) => [...bookWords(p)])]);
}
const shortShard = (c: string) => readJson<DictShardFile>(`dict/${c}.json`);
const dictShort = new Map<string, DictShardFile>();
function dictEntry(w: string) {
  const c = w[0]!;
  if (!dictShort.has(c)) dictShort.set(c, shortShard(c));
  return dictShort.get(c)![w];
}

describe('public/data 产物', () => {
  it('目录：id 唯一、文件存在、size 与合并后词数一致、分类合法', () => {
    const ids = catalog.books.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of catalog.books) {
      expect(['level', 'exam', 'frequency', 'other']).toContain(b.category);
      expect(bookFile(b.id).id).toBe(b.id);
      expect(bookWords(b.id).size, b.id).toBe(b.size);
      expect(b.description, b.id).toBeTruthy();
    }
    // 默认启用的 cet6 必须存在；考试书覆盖需求列出的全部考试
    for (const id of ['zk', 'gk', 'cet4', 'cet6', 'kaoyan', 'toefl', 'ielts', 'gre', 'sat', 'cet6-new', 'cefr-b2', 'coca-5k']) expect(ids).toContain(id);
  });

  it('词书文件：小写纯字母、已排序、不重复，嵌套书只存差集', () => {
    for (const b of catalog.books) {
      const { words, extends: ext } = bookFile(b.id);
      expect(words.every((w) => /^[a-z]+$/.test(w)), b.id).toBe(true);
      expect([...words].sort(), b.id).toEqual(words);
      expect(new Set(words).size, b.id).toBe(words.length);
      for (const p of ext ?? []) {
        const parent = bookWords(p);
        expect(words.some((w) => parent.has(w)), `${b.id} 与 ${p} 重复存储`).toBe(false);
      }
    }
  });

  it('级别是包含体系：B2 ⊃ C1 ⊃ C2，B2 不含 A1–B1 词', () => {
    const b2 = bookWords('cefr-b2');
    const c1 = bookWords('cefr-c1');
    expect([...c1].every((w) => b2.has(w))).toBe(true);
    for (const w of ['vulnerable', 'infrastructure', 'pessimistic', 'dilemma']) expect(b2.has(w), w).toBe(true);
    for (const w of ['city', 'water', 'people', 'good', 'energy', 'year', 'because']) expect(b2.has(w), w).toBe(false);
  });

  it('增量词书与被减去的考试书不相交', () => {
    for (const b of catalog.books.filter((x) => x.delta)) {
      const words = bookWords(b.id);
      for (const m of b.delta!.minus) {
        const raw = bookWords(m);
        // minus 按原始考试词表（含基础词）计算，去基础词后的考试书是其子集，所以一定不相交
        expect([...words].filter((w) => raw.has(w)), `${b.id} ∩ ${m}`).toEqual([]);
      }
      expect([...words].every((w) => bookWords(b.delta!.of).has(w))).toBe(true);
    }
  });

  it('考试书去掉了基础常用词，且不含变形词/专有名词', () => {
    const cet6 = bookWords('cet6');
    for (const w of ['the', 'and', 'have', 'good', 'people', 'city', 'school', 'cities', 'levels', 'margaret']) expect(cet6.has(w), w).toBe(false);
    for (const w of ['vulnerable', 'premise', 'genuine', 'retreat']) expect(cet6.has(w), w).toBe(true);
    expect(bookWords('ielts').has('cities')).toBe(false);
  });

  it('词典覆盖所有内置词书的词，行内短释义 ≤ 8 字且不带词性', () => {
    const missing: string[] = [];
    let noShort = 0;
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    for (const w of all) {
      const e = dictEntry(w);
      if (!e) missing.push(w);
      else if (!e.s) noShort++;
      else {
        expect(e.s.length, w).toBeLessThanOrEqual(8);
        expect(e.s, w).not.toMatch(/^[a-z]+\./);
      }
    }
    expect(missing).toEqual([]);
    expect(noShort).toBeLessThan(10);
    expect(dictEntry('abandon')?.s).toBe('放弃');
    expect(dictEntry('scrutinize')).toMatchObject({ l: 5 });
  });
});

// ---------------------------------------------------------------------------
// 标杆回归：同一篇文章上的生词判定（对照 Relingo B2 级别在 tests/fixtures/article.html 上标出的词）
// ---------------------------------------------------------------------------

describe('文章生词判定回归（article.html）', () => {
  // 用词典全表的词形（x）反查原形，作为与 lemma 分片解耦的最小还原
  const formToLemma = new Map<string, string>();
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const full = readJson<DictShardFile>(`dict/full/${c}.json`);
    for (const [w, e] of Object.entries(full)) for (const f of parseForms(e.x) ?? []) if (!formToLemma.has(f.word)) formToLemma.set(f.word, w);
  }
  const html = fs.readFileSync(path.resolve(__dirname, '../fixtures/article.html'), 'utf8');
  const text = html.replace(/<(script|style|pre)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((m) => m[0].toLowerCase());
  const hits = (id: string) => {
    const words = bookWords(id);
    const out = new Set<string>();
    for (const t of tokens) {
      const l = words.has(t) ? t : formToLemma.get(t);
      if (l && words.has(l)) out.add(l);
    }
    return out;
  };
  // Relingo（B2）在该页标出的词中，我们的数据应当覆盖的部分（屈折/派生由 lemma 分片处理，这里只列原形出现在页面的）
  const RELINGO_B2 = ['surge', 'assumption', 'pessimistic', 'inspect', 'barrier', 'dilemma', 'vicious', 'retreat', 'revenue', 'ethical', 'reluctant', 'infrastructure', 'premise', 'vulnerable', 'hybrid', 'conventional', 'mature', 'quantify', 'genuine', 'skeptical', 'distinctive', 'urban', 'deliberate'];
  const COMMON = ['city', 'water', 'storm', 'year', 'people', 'family', 'price', 'money', 'home', 'children', 'trust', 'question'];

  it('cefr-b2：覆盖 Relingo B2 判定，常用词不高亮', () => {
    const h = hits('cefr-b2');
    const recall = RELINGO_B2.filter((w) => h.has(w)).length / RELINGO_B2.length;
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(COMMON.filter((w) => h.has(w))).toEqual([]);
  });

  it('cet6（默认词书）：高亮量与 Relingo 同量级，常用词不高亮', () => {
    const h = hits('cet6');
    expect(RELINGO_B2.filter((w) => h.has(w)).length / RELINGO_B2.length).toBeGreaterThanOrEqual(0.75);
    expect(COMMON.filter((w) => h.has(w))).toEqual([]);
    // Relingo 在此页标出约 75 个不同原形；默认词书不应过密（< 2 倍）
    expect(h.size).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// 行内短释义质量（第二阶段）：常用义项、词性一致、2–6 字
// ---------------------------------------------------------------------------

describe('行内短释义质量', () => {
  /**
   * 金标：常见多义词的可接受短释义（任一即可，比较时忽略形容词“的”/副词“地”/动词“使”）。
   * 依据有道词典网页首义项与 Relingo 在同一文章上的行内注解；只收“常用义 vs 冷僻义/专业义”区分明显的词。
   */
  const GOLD: Record<string, string[]> = {
    abandon: ['放弃'], accept: ['接受'], address: ['地址', '处理', '演讲'], apply: ['申请', '应用'], believe: ['相信'],
    explain: ['解释', '说明'], famous: ['著名的'], concrete: ['具体的'], minute: ['分钟'], present: ['现在的', '现在', '礼物', '呈现', '提出', '出席的'],
    premium: ['高级的', '优质的', '溢价', '保险费'], implement: ['实施', '执行'], multiple: ['多个', '多重的', '多样的', '许多的'],
    project: ['项目', '工程', '计划'], current: ['当前的', '现在的'], apartment: ['公寓'], area: ['区域', '地区', '面积'],
    loss: ['损失', '亏损'], observe: ['观察', '遵守'], deploy: ['部署'], merge: ['合并'], fix: ['修理', '固定', '修复'],
    scenario: ['情景', '场景', '方案', '设想'], convert: ['转换', '转变'], obsolete: ['过时的', '废弃的'], socket: ['插座', '插口'],
    serum: ['血清'], basin: ['盆地'], arbitration: ['仲裁'], impeachment: ['弹劾'], credential: ['证书', '凭据'],
    abstraction: ['抽象'], phase: ['阶段'], coup: ['政变'], boost: ['提高', '促进', '增加'], drain: ['排水', '耗尽', '消耗'],
    recruit: ['招募', '招聘', '新兵'], patch: ['补丁', '修补', '小块'], judicial: ['司法的'], odd: ['奇怪的'], integrate: ['整合', '使结合', '融入'],
    sustainable: ['可持续的'], removal: ['移除', '去除', '清除'], surge: ['激增', '汹涌', '浪涌'], assumption: ['假设', '假定'],
    barrier: ['障碍', '屏障', '障碍物'], revenue: ['收入', '税收'], infrastructure: ['基础设施'], vulnerable: ['脆弱的', '易受攻击的', '易受伤害的'],
    hybrid: ['混合的', '杂交', '混合物'], conventional: ['传统的', '常规的'], genuine: ['真正的'], dilemma: ['困境'], retreat: ['撤退'],
    ethical: ['伦理的', '道德的'], reluctant: ['不情愿的'], premise: ['前提'], pessimistic: ['悲观的'], inspect: ['检查'],
    quantify: ['量化'], mature: ['成熟的'], urban: ['城市的'], federal: ['联邦的'], medicine: ['药', '医学', '药物'],
    parent: ['父母', '家长', '父亲'], iodine: ['碘'], immunity: ['免疫力', '免疫'], screwdriver: ['螺丝刀'], adapter: ['适配器'],
    filter: ['过滤器', '过滤'], input: ['输入'], output: ['输出', '产量'], default: ['默认', '违约'], interface: ['界面', '接口'],
    release: ['发布', '释放'], file: ['文件', '档案'], user: ['用户'], domestic: ['国内的', '家庭的'], primary: ['主要的', '首要的'],
    technical: ['技术的'], chip: ['芯片', '碎片'], peer: ['同龄人', '同事', '同伴'], integration: ['整合', '一体化', '结合'],
    programming: ['编程', '程序设计'], array: ['一系列', '数组', '大量'], anxious: ['焦虑的', '担心的', '渴望的'],
  };
  const norm = (s: string) => s.replace(/^使(?=..)/, '').replace(/(?<=..)[的地]$/, '');

  it('常见多义词取常用义项（金标命中率 ≥ 95%）', () => {
    const miss: string[] = [];
    for (const [w, ok] of Object.entries(GOLD)) {
      const s = dictEntry(w)?.s ?? '';
      if (!ok.some((g) => norm(g) === norm(s))) miss.push(`${w}=${s}`);
    }
    expect(miss.length / Object.keys(GOLD).length, miss.join(' ')).toBeLessThanOrEqual(0.05);
  });

  it('常见网页/科技词与数量词：硬性回归（不允许任何一个回退）', () => {
    // 第 2 轮需求核对与盲评中出现的错误义项（括注为曾经的错误值）
    const MUST: Record<string, string> = {
      subscribe: '订阅', subscription: '订阅', quote: '引用', hover: '盘旋', token: '令牌', console: '控制台', crew: '工作人员',
      faculty: '教职员工', browser: '浏览器', server: '服务器', cache: '缓存', tutorial: '教程', printer: '打印机', widget: '小部件',
      dew: '露水', tabulate: '制成表格', email: '电子邮件', online: '在线的', sidebar: '侧边栏', avatar: '头像', module: '模块',
      // 数量词：million 不是“万”，billion 不是“亿”
      thousand: '千', million: '百万', billion: '十亿', trillion: '万亿',
      // 领域误义：utilities 不是“实用程序”，projections 不是“投影”
      utility: '公用事业', projection: '预测', stack: '堆', spectrum: '光谱', persist: '持续', soar: '飙升', bulk: '大部分',
    };
    const wrong = Object.entries(MUST).filter(([w, s]) => dictEntry(w)?.s !== s).map(([w]) => `${w}=${dictEntry(w)?.s}`);
    expect(wrong).toEqual([]);
  });

  it('动词短释义 v 精炼完整：≤ 6 字且不含“…”', () => {
    const bad: string[] = [];
    for (const c of 'abcdefghijklmnopqrstuvwxyz') for (const [w, e] of Object.entries(shortShard(c))) if (e.v && (e.v.length > 6 || e.v.includes('…'))) bad.push(`${w}=${e.v}`);
    expect(bad).toEqual([]);
  });

  it('词书词的短释义 ≥ 95% 为 2–6 字，且不含英文、括注与残留标点', () => {
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    let ok = 0;
    let total = 0;
    const dirty: string[] = [];
    for (const w of all) {
      const s = dictEntry(w)?.s;
      if (!s) continue;
      total++;
      if (s.length >= 2 && s.length <= 6) ok++;
      // 允许 DNA/OK 这类大写缩写，不允许小写英文、括号、分隔符与 & 残留
      if (/[a-z<>[\]()（）〔〕【】&，、；]/.test(s)) dirty.push(`${w}=${s}`);
    }
    expect(ok / total).toBeGreaterThanOrEqual(0.95);
    expect(dirty).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 误匹配：人名/地名/缩写/连字符前缀不进词书；用户词书中的短语与连字符词不造成误匹配
// ---------------------------------------------------------------------------

describe('误匹配防护', () => {
  it('内置词书不含人名地名同形词、缩写、罗马数字与连字符前缀', () => {
    const all = new Set(catalog.books.flatMap((b) => [...bookWords(b.id)]));
    const NOT = [
      'chelsea', 'oliver', 'marx', 'hong', 'kong', 'russell', 'newton', 'jordan', 'lee', 'tony', 'taylor', 'glasgow',
      'vs', 'etc', 'km', 'ft', 'ph', 'iii', 'xiv', 're', 'non', 'mid', 'micro', 'macro', 'mini', 'bio', 'alpha', 'beta',
    ];
    expect(NOT.filter((w) => all.has(w))).toEqual([]);
    // 英式拼写不受“只有 BNC 排名”规则误伤
    for (const w of ['emphasise', 'privatisation']) expect(all.has(w), w).toBe(true);
  });

  it('用户词书里的短语/连字符词：分词按连字符切开，只会漏标、不会把组成部分误标', async () => {
    const { tokenize } = await import('@/core/text/tokenize');
    const { WordMatcher } = await import('@/core/match/matcher');
    const meta = localBookMeta({ id: 'local:p', name: 'p', format: 'txt', wordCount: 3, createdAt: 0, updatedAt: 0 });
    const book = createUserWordBook(meta, { 'well-known': { word: 'well-known' }, 'give up': { word: 'give up' }, 'e-mail': { word: 'e-mail' } });
    const lemmatizer = { candidates: (s: string) => [s.toLowerCase()] };
    const m = new WordMatcher({ lemmatizer, books: [book], known: new Set() });
    const hits = tokenize('A well-known author will never give up; send an e-mail.').filter((t) => m.match(t.word));
    expect(hits).toEqual([]);
  });

  it('isHyphenPrefix：auto/vice/micro 等构词前缀', async () => {
    const { isHyphenPrefix } = await import('@/core/dict/hyphen');
    for (const w of ['auto', 'Vice', 'micro', 'self', 'non']) expect(isHyphenPrefix(w), w).toBe(true);
    for (const w of ['vulnerable', 'premise']) expect(isHyphenPrefix(w), w).toBe(false);
  });
});

describe('编程熟词（v8 代码块）', () => {
  it('收录常见关键字与缩写，大小写不敏感', async () => {
    const { isCodeKnownWord, CODE_KNOWN_WORDS } = await import('@/core/dict/code-words');
    for (const w of ['if', 'return', 'const', 'var', 'func', 'str', 'init', 'args', 'Ctx', 'impl', 'kwargs', 'async', 'Await', 'nullptr', 'stdout']) {
      expect(isCodeKnownWord(w), w).toBe(true);
    }
    // 正常词汇不应被当成编程熟词
    for (const w of ['vulnerable', 'element', 'infrastructure', 'premise']) expect(isCodeKnownWord(w), w).toBe(false);
    expect([...CODE_KNOWN_WORDS].every((w) => w === w.toLowerCase())).toBe(true);
  });
  it('标识符中的屈折形式按原形判断（defaults、modules、callbacks）', async () => {
    const { isCodeKnownWord } = await import('@/core/dict/code-words');
    for (const w of ['defaults', 'modules', 'imports', 'callbacks', 'Exported', 'returning', 'foo', 'tsx']) expect(isCodeKnownWord(w), w).toBe(true);
    for (const w of ['cases', 'element', 'premises']) expect(isCodeKnownWord(w), w).toBe(w === 'cases');
  });

});

describe('动词短释义 shortVerb（v）', () => {
  it('名词/形容词首选义项的词另给动词释义，打包产物与 unpack 一致', async () => {
    expect(dictEntry('advocate')).toMatchObject({ s: '提倡者', v: '提倡' });
    // 首选义项本身就是动词的词不重复提供
    expect(dictEntry('abandon')?.v).toBeUndefined();
    const dict = new PackagedDictionary(async (p) => (p.startsWith('full/') ? {} : shortShard(p)));
    expect((await dict.lookupMany(['advocate'])).get('advocate')).toMatchObject({ short: '提倡者', shortVerb: '提倡' });
  });

  it('CompositeDictionary：用户词书给了 short 时不混入打包词典的 shortVerb', async () => {
    const packaged = new PackagedDictionary(async (p): Promise<DictShardFile> => (p === 'a' ? { advocate: { s: '提倡者', v: '提倡' } } : {}));
    const meta = localBookMeta({ id: 'local:2', name: 't', format: 'txt', wordCount: 1, createdAt: 0, updatedAt: 0 });
    const user = new UserBooksDictionary([createUserWordBook(meta, { advocate: { word: 'advocate', trans: '拥护者' } })]);
    const many = await new CompositeDictionary([user, packaged]).lookupMany(['advocate']);
    expect(many.get('advocate')).toMatchObject({ short: '拥护者' });
    expect(many.get('advocate')?.shortVerb).toBeUndefined();
    expect((await new CompositeDictionary([packaged]).lookupMany(['advocate'])).get('advocate')?.shortVerb).toBe('提倡');
  });
});

describe('搭配义覆盖 collocationShort', () => {
  it('固定搭配改用搭配义，未命中回退', async () => {
    const { collocationShort } = await import('@/core/dict/collocation');
    expect(collocationShort('vicious', undefined, 'cycle')).toBe('恶性的');
    expect(collocationShort('concrete', 'the', 'structure')).toBe('混凝土');
    expect(collocationShort('surge', 'storm', 'flood')).toBe('风暴潮');
    expect(collocationShort('bulk', 'the', 'of')).toBe('大部分');
    expect(collocationShort('shed', 'to', 'light')).toBe('揭示');
    expect(collocationShort('vicious', 'a', 'dog')).toBeUndefined();
    expect(collocationShort('concrete')).toBeUndefined();
  });
});
