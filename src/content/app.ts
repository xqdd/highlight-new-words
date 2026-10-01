import { browser } from 'wxt/browser';
import { CompositeDictionary, PackagedDictionary } from '@/core/dict/packaged';
import type { Dictionary } from '@/core/dict/types';
import { createLemmatizer } from '@/core/lemma';
import { WordMatcher } from '@/core/match/matcher';
import { handleContentMessages, sendToBackground } from '@/core/messaging';
import { getKnownWords } from '@/core/known/store';
import type { Settings } from '@/core/settings/schema';
import { getSettings, isSiteDisabled } from '@/core/settings/store';
import { getProviderInfo } from '@/core/source/providers';
import { LOCAL_BOOK_KEY_PREFIX, SOURCE_BOOK_KEY_PREFIX, STORAGE_KEYS } from '@/core/storage/keys';
import { resolveCardStyle } from '@/core/theme/resolve';
import { bookKindOf } from '@/core/wordbook/ids';
import { DefaultWordBookRegistry, createExtensionLoaders } from '@/core/wordbook/registry';
import type { BookMeta, WordBook } from '@/core/wordbook/types';
import { UserBooksDictionary } from '@/core/wordbook/user-book';
import { ShadowCardView } from './card/card-view';
import { speakWord } from './card/speak';
import { bindCardTrigger } from './card/trigger';
import type { CardData, CardView } from './card/types';
import { ATTR_BOOKS, ATTR_LEMMA } from './engine/dom';
import { HighlightEngine } from './engine/engine';
import { markSurface } from './engine/highlighter';
import { layoutAffectingSettings } from './engine/prehide';
import { applyPageStyle, removePageStyle } from './engine/style';
import { startPageExtras } from './sites/context';

/**
 * 内容脚本应用：组装 设置 / 词书 / 词形还原 / 匹配 / 引擎 / 卡片，并响应存储变化。
 *
 * 状态切换：
 * - enabled 或站点禁用变化 -> 启停引擎
 * - 启用词书 / 熟词本 / 用户词书（来源、本地导入）变化 -> 重建 matcher 并重扫
 * - 样式 / 行内翻译模式变化 -> 只更新样式与翻译，不重扫
 */
/** 每个短释义分片取一个探针词（分片按首字母划分），lookupMany 会加载全部分片 */
const DICT_SHARD_PROBES = 'abcdefghijklmnopqrstuvwxyz'.split('');

export interface ContentAppOptions {
  /** 释放首屏预隐藏（可选功能，隐藏样式由 background 动态注册，见 engine/prehide.ts）；幂等 */
  releasePrehide?: () => void;
}

export async function startContentApp(appOpts: ContentAppOptions = {}): Promise<void> {
  const releasePrehide = appOpts.releasePrehide ?? (() => {});
  const doc = document;
  const lemmatizer = createLemmatizer();
  // 内容脚本在 document_start 注入：词形数据、设置、词书与页面解析并行加载，DOM 就绪时尽快处理首屏，
  // 争取在首次绘制/用户开始阅读前完成首屏标注（首屏插入词后译文造成的布局推移在首次绘制前不计入 CLS）
  const lemmaReady = Promise.resolve(lemmatizer.init?.());

  let settings = await getSettings();
  let registry: DefaultWordBookRegistry;
  const packagedDict = new PackagedDictionary();
  let dictionary: Dictionary = packagedDict;
  let loadedBooks: WordBook[] = [];
  /** 上次构建 matcher 时的熟词本与启用的用户词书词表，用于判断数据变化是否“只减少命中” */
  let knownSnapshot = new Set<string>();
  let userKeysSnapshot = new Set<string>();
  let engine: HighlightEngine | null = null;
  let card: CardView | null = null;
  const isTop = window.top === window;

  const active = () => settings.enabled && !isSiteDisabled(settings, location.hostname);
  // 未开启预隐藏、不标注、或标注不改变排版时不需要预隐藏：设置读到后立即释放（通常早于首次绘制；未开启时页面本来就没有隐藏）
  if (!settings.performance.prehide || !active() || !layoutAffectingSettings(settings)) releasePrehide();
  /** 短释义分片预载（after/ruby 模式）；首次启动 engine 前等它就绪，见 startEngine */
  let dictPreload: Promise<unknown> = Promise.resolve();
  if (active() && (settings.inlineTranslation.mode === 'after' || settings.inlineTranslation.mode === 'ruby')) {
    // 首屏要尽早写好译文（预隐藏时要在显示前写好）：读到设置后立即预载全部短释义分片（按首字母，共约 2MB），与词书、词形数据并行。
    // 页面解析繁忙后扩展资源请求会明显变慢（维基大页面首屏查释义要多等 200–300ms），趁解析刚开始时发出
    dictPreload = packagedDict.lookupMany(DICT_SHARD_PROBES).catch(() => {});
  }

  /** 加载启用的词书与熟词本，构造 matcher 与组合词典 */
  async function buildMatcher(): Promise<WordMatcher> {
    const loaders = createExtensionLoaders();
    // 内置词书文件与词书目录并行请求（registry 默认先等目录再取文件；页面解析繁忙时每次往返要几十毫秒，首屏要等它）
    const bookFiles = new Map(settings.books.enabled.filter((id) => bookKindOf(id) === 'builtin').map((id) => [id, loaders.book(id)]));
    registry = new DefaultWordBookRegistry({ ...loaders, book: (id) => bookFiles.get(id) ?? loaders.book(id) });
    const booksReady = Promise.all(settings.books.enabled.map((id) => registry.load(id)));
    const [books, known] = await Promise.all([
      booksReady,
      getKnownWords(),
      lemmaReady,
    ]);
    loadedBooks = books.filter((b): b is WordBook => !!b && b.size > 0);
    knownSnapshot = known;
    const userBooks = loadedBooks.filter((b) => b.meta.kind !== 'builtin');
    userKeysSnapshot = new Set(userBooks.flatMap((b) => [...b.words()].map((w) => `${b.meta.id}\n${w}`)));
    dictionary = new CompositeDictionary([new UserBooksDictionary(userBooks), packagedDict]);
    return new WordMatcher({ lemmatizer, books: loadedBooks, known });
  }

  function ensureCard(): CardView {
    if (card) return card;
    card = new ShadowCardView(doc, {
      // 后台返回 unavailable（无 chrome.tts）时在页面内兜底朗读，见 card/speak.ts
      speak: (text) => void speakWord(text, true, settings.tts),
      // 熟词/删词写入由 background 完成（需协调来源删除）；页面先乐观移除高亮，storage 变化后再复核
      markKnown: async (lemma, surface) => {
        engine?.removeLemma(lemma);
        return sendToBackground('markKnown', { word: surface, lemma });
      },
      // 返回 background 结果：卡片用其中的 message 显示“已加回 …/无法加回 …”
      unmarkKnown: (lemma) => sendToBackground('unmarkKnown', { lemma }),
      deleteFromSources: async (lemma, bookIds) => {
        const res = await sendToBackground('deleteSourceWords', { word: lemma, bookIds });
        engine?.removeLemma(lemma);
        return res;
      },
    });
    card.setStyle(resolveCardStyle(settings));
    bindCardTrigger({
      doc,
      view: card,
      getTrigger: () => settings.card.trigger,
      // v11：修饰键 + 悬停时按住的键（card 模块新增，只加这一行接线）
      getModifier: () => settings.card.modifier,
      // 悬停弹卡延迟（card 修复轮新增 settings.card.hoverDelay）
      getHoverDelay: () => settings.card.hoverDelay,
      onOpen: (mark) => void openCard(mark),
    });
    return card;
  }

  async function openCard(mark: HTMLElement): Promise<void> {
    const view = ensureCard();
    const lemma = mark.getAttribute(ATTR_LEMMA)!;
    const bookIds = (mark.getAttribute(ATTR_BOOKS) ?? '').split(' ').filter(Boolean);
    const metas = new Map<string, BookMeta>(loadedBooks.map((b) => [b.meta.id, b.meta]));
    const books = bookIds.map((id) => metas.get(id)).filter((m): m is BookMeta => !!m);
    const data: CardData = {
      surface: markSurface(mark),
      lemma,
      books,
      deletableBooks: books.filter((b) => b.kind === 'source' && !!getProviderInfo(b.providerId ?? '')?.capabilities.delete),
    };
    view.open(mark, data);
    // 自动发音（background 根据 settings.tts.enabled 决定是否朗读；unavailable 时页面内兜底）
    void speakWord(lemma, false, settings.tts);
    const entry = await dictionary.lookup(lemma);
    if (view.anchor === mark) view.update({ ...data, entry });
  }

  async function startEngine(): Promise<void> {
    const matcher = await buildMatcher();
    await firstScreenParsed(doc);
    // 等短释义分片就绪（最多 DICT_PRELOAD_MAX_WAIT_MS）：这样首屏 mark 与译文在同一任务内写入、一起首次绘制。
    // 否则 mark 先显示、译文下一帧才插入，mark 后面已显示的文字整体推移，“词后”模式 CLS 明显变大（兼容性测试 spring-boot +0.04）
    await Promise.race([dictPreload, new Promise((r) => setTimeout(r, DICT_PRELOAD_MAX_WAIT_MS))]);
    // frameset 等没有 body 的文档不处理
    if (!doc.body) {
      releasePrehide();
      return;
    }
    applyPageStyle(doc, settings);
    ensureCard();
    if (engine) {
      engine.setCode(settings.code);
      engine.rebuild(matcher, dictionary);
      return;
    }
    engine = new HighlightEngine({
      root: doc.body,
      matcher,
      dictionary,
      inlineTranslation: settings.inlineTranslation.mode,
      translationBlur: !!settings.inlineTranslation.blur,
      glossOncePerParagraph: settings.inlineTranslation.oncePerParagraph !== false,
      code: settings.code,
      onLemmasChanged: (lemmas) => void sendToBackground('reportPageWords', { lemmas }).catch(() => {}),
    });
    engine.start();
    // 首屏：同步标注视口内文本、写入视口内译文后再显示页面（预隐藏期间的排版变化不计入 CLS）
    try {
      await engine.primeFirstScreen();
    } finally {
      releasePrehide();
    }
  }

  function stopEngine(): void {
    engine?.stop();
    engine = null;
    card?.close();
    removePageStyle(doc);
  }

  // 站点适配层（YouTube 等）与悬浮球（floatball 模块）：须在首次扫描前启动，站点跳过规则才对首屏生效
  const extras = startPageExtras({
    doc,
    getSettings: () => settings,
    isActive: active,
    getCard: () => card,
    openCard: (anchor) => void openCard(anchor),
    getDictionary: () => dictionary,
    lemmatizer,
    getLoadedBooks: () => loadedBooks,
    getKnown: () => knownSnapshot,
    getPageLemmas: () => engine?.matchedLemmas ?? [],
    removeLemma: (lemma) => engine?.removeLemma(lemma),
    isTop,
  });

  // 首次启动
  if (active()) {
    try {
      await startEngine();
    } finally {
      releasePrehide();
    }
  }

  // 存储变化：设置 / 熟词本 / 用户词书
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    // 只处理与页面相关的键（忽略 syncState、索引等后台元数据写入）
    const relevant = Object.keys(changes).some(
      (k) => k === STORAGE_KEYS.settings || k === STORAGE_KEYS.knownWords || k.startsWith(SOURCE_BOOK_KEY_PREFIX) || k.startsWith(LOCAL_BOOK_KEY_PREFIX),
    );
    if (!relevant) return;
    const prev = settings;
    if (changes[STORAGE_KEYS.settings]) {
      settings = await getSettings();
      extras.settingsChanged();
    }
    const wasActive = prev.enabled && !isSiteDisabled(prev, location.hostname);
    if (!active()) {
      if (wasActive) stopEngine();
      return;
    }
    // 代码块开关/范围变化会改变扫描范围，需要重扫
    const booksChanged =
      prev.books.enabled.join() !== settings.books.enabled.join() || JSON.stringify(prev.code) !== JSON.stringify(settings.code);
    const knownChanged = !!changes[STORAGE_KEYS.knownWords];
    // 只关心启用的用户词书的数据键（索引键变化仅影响元数据，不必重扫）
    const userBooksChanged = settings.books.enabled.some(
      (id) => changes[SOURCE_BOOK_KEY_PREFIX + id] || changes[LOCAL_BOOK_KEY_PREFIX + id],
    );
    if (!wasActive || !engine || booksChanged) {
      await startEngine();
      return;
    }
    if (knownChanged || userBooksChanged) {
      const prevKnown = knownSnapshot;
      const prevUser = userKeysSnapshot;
      const matcher = await buildMatcher();
      // 熟词只增、用户词书词条只减 -> 只会减少命中，原地复核即可；否则需要全量重扫
      const onlyShrinks =
        [...prevKnown].every((w) => knownSnapshot.has(w)) && [...userKeysSnapshot].every((w) => prevUser.has(w));
      if (onlyShrinks) engine.refreshMatches(matcher, dictionary);
      else engine.rebuild(matcher, dictionary);
    }
    applyPageStyle(doc, settings);
    card?.setStyle(resolveCardStyle(settings));
    engine?.setInlineTranslation(settings.inlineTranslation.mode, !!settings.inlineTranslation.blur, settings.inlineTranslation.oncePerParagraph !== false);
  });

  if (isTop) {
    handleContentMessages({
      getPageState: () => ({
        active: active(),
        hostname: location.hostname,
        matchedCount: engine?.matchedLemmas.length ?? 0,
      }),
    });
  }

  // 右键菜单“加入生词本/标为熟词”的结果（后台发给被点击的 frame，顶层与子 frame 都注册）：用卡片 toast 显示，失败用错误样式
  handleContentMessages({
    actionNotice: ({ ok, message, lemma }) => ensureCard().showMessage?.(message, ok, lemma),
  });

  // 便于调试：控制台可查看当前实例（隔离世界中，不会暴露给页面脚本）
  (globalThis as Record<string, unknown>).__hnw = { get engine() { return engine; }, get settings(): Settings { return settings; } };
}

/** 判断“首屏已就绪”的轮询间隔（ms） */
const PARSE_POLL_MS = 25;
/** 最长等待（ms）：样式表一直加载不完等异常情况下也会启动（预隐藏有自己的兜底，见 prehide.ts） */
const FIRST_SCREEN_MAX_WAIT_MS = 1500;
/** 启动 engine 前等待短释义分片预载的上限：超过后照常先高亮，译文到达后再懒插入 */
const DICT_PRELOAD_MAX_WAIT_MS = 400;
/** 不参与布局的元素：判断解析进度时跳过 */
const NON_LAYOUT_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);

/**
 * 等到首屏内容就绪（document_start 注入时 body 尚不存在）：
 * 1. 页面样式表都已加载：样式表到达前的布局是无样式布局，按它判断“视口内”的单词会判错，
 *    首屏真正可见的单词拿不到译文，样式到达后再懒插入就会推移（冷缓存的维基即如此）；
 * 2. DOMContentLoaded，或解析器当前所在位置（body 中最深的最后一个可布局元素）已经越过视口底部——
 *    此时首屏内容都已在 DOM 中，可以先处理首屏，不必等整页解析完（大页面 DOMContentLoaded 可能晚于首次绘制数百毫秒），
 *    之后解析出来的内容由 engine 的 MutationObserver 增量处理。
 * 页面处于预隐藏中时，这里的位置读取不会造成可见影响。
 */
function firstScreenParsed(doc: Document): Promise<void> {
  const startedAt = performance.now();
  const ready = () => {
    // 超时兜底也要等 body 出现：冷启动直接打开 YouTube 视频页时 1.5s 内 body 可能还没解析出来，
    // 此时放行会让 startEngine 走“无 body”分支直接返回、整页不再标注（floatball r2 实测 1/3 复现）；frameset 页面最终 readyState=complete 放行
    if (doc.readyState === 'complete' || (performance.now() - startedAt > FIRST_SCREEN_MAX_WAIT_MS && !!doc.body)) return true;
    if (hasPendingStylesheet(doc)) return false;
    if (doc.readyState !== 'loading') return true;
    let el: Element | null = doc.body?.lastElementChild ?? null;
    let last: Element | null = null;
    while (el) {
      if (NON_LAYOUT_TAGS.has(el.tagName)) {
        el = el.previousElementSibling;
        continue;
      }
      last = el;
      el = el.lastElementChild;
    }
    return !!last && last.getBoundingClientRect().top > (doc.defaultView?.innerHeight ?? 0);
  };
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!ready()) return;
      clearInterval(timer);
      resolve();
    }, PARSE_POLL_MS);
  });
}

/** 是否还有生效中的样式表没加载完（`<link rel=stylesheet>` 加载完成前 sheet 为 null） */
function hasPendingStylesheet(doc: Document): boolean {
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')) {
    if (link.sheet || link.disabled) continue;
    if (link.media && doc.defaultView && !doc.defaultView.matchMedia(link.media).matches) continue;
    return true;
  }
  return false;
}
