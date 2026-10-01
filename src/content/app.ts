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
import { DefaultWordBookRegistry, createExtensionLoaders } from '@/core/wordbook/registry';
import type { BookMeta, WordBook } from '@/core/wordbook/types';
import { UserBooksDictionary } from '@/core/wordbook/user-book';
import { ShadowCardView } from './card/card-view';
import { bindCardTrigger } from './card/trigger';
import type { CardData, CardView } from './card/types';
import { ATTR_BOOKS, ATTR_LEMMA } from './engine/dom';
import { HighlightEngine } from './engine/engine';
import { markSurface } from './engine/highlighter';
import { applyPageStyle, removePageStyle } from './engine/style';

/**
 * 内容脚本应用：组装 设置 / 词书 / 词形还原 / 匹配 / 引擎 / 卡片，并响应存储变化。
 *
 * 状态切换：
 * - enabled 或站点禁用变化 -> 启停引擎
 * - 启用词书 / 熟词本 / 用户词书（来源、本地导入）变化 -> 重建 matcher 并重扫
 * - 样式 / 行内翻译模式变化 -> 只更新样式与翻译，不重扫
 */
export async function startContentApp(): Promise<void> {
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

  /** 加载启用的词书与熟词本，构造 matcher 与组合词典 */
  async function buildMatcher(): Promise<WordMatcher> {
    registry = new DefaultWordBookRegistry(createExtensionLoaders());
    const [books, known] = await Promise.all([
      Promise.all(settings.books.enabled.map((id) => registry.load(id))),
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
      speak: (text) => void sendToBackground('tts', { text, force: true }),
      // 熟词/删词写入由 background 完成（需协调来源删除）；页面先乐观移除高亮，storage 变化后再复核
      markKnown: async (lemma, surface) => {
        engine?.removeLemma(lemma);
        return sendToBackground('markKnown', { word: surface, lemma });
      },
      unmarkKnown: async (lemma) => {
        await sendToBackground('unmarkKnown', { lemma });
      },
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
    // 自动发音（background 根据 settings.tts.enabled 决定是否朗读）
    void sendToBackground('tts', { text: lemma });
    const entry = await dictionary.lookup(lemma);
    if (view.anchor === mark) view.update({ ...data, entry });
  }

  async function startEngine(): Promise<void> {
    const matcher = await buildMatcher();
    await domReady(doc);
    // frameset 等没有 body 的文档不处理
    if (!doc.body) return;
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
      code: settings.code,
      onLemmasChanged: (lemmas) => void sendToBackground('reportPageWords', { lemmas }).catch(() => {}),
    });
    engine.start();
  }

  function stopEngine(): void {
    engine?.stop();
    engine = null;
    card?.close();
    removePageStyle(doc);
  }

  // 首次启动
  if (active()) await startEngine();

  // 存储变化：设置 / 熟词本 / 用户词书
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    // 只处理与页面相关的键（忽略 syncState、索引等后台元数据写入）
    const relevant = Object.keys(changes).some(
      (k) => k === STORAGE_KEYS.settings || k === STORAGE_KEYS.knownWords || k.startsWith(SOURCE_BOOK_KEY_PREFIX) || k.startsWith(LOCAL_BOOK_KEY_PREFIX),
    );
    if (!relevant) return;
    const prev = settings;
    if (changes[STORAGE_KEYS.settings]) settings = await getSettings();
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
    engine?.setInlineTranslation(settings.inlineTranslation.mode, !!settings.inlineTranslation.blur);
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

  // 便于调试：控制台可查看当前实例（隔离世界中，不会暴露给页面脚本）
  (globalThis as Record<string, unknown>).__hnw = { get engine() { return engine; }, get settings(): Settings { return settings; } };
}

/** 等待 DOM 解析完成（document_start 注入时 body 尚不存在） */
function domReady(doc: Document): Promise<void> {
  if (doc.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => doc.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
}
