import type { Dictionary } from '@/core/dict/types';
import type { Lemmatizer } from '@/core/lemma/types';
import { WordMatcher } from '@/core/match/matcher';
import { sendToBackground } from '@/core/messaging';
import type { Settings } from '@/core/settings/schema';
import type { WordBook } from '@/core/wordbook/types';
import type { CardView } from '../card/types';
import { startFloatBall } from '../floatball';
import { startSiteAdapters } from './index';
import type { SiteContext } from './types';

/**
 * app.ts 传入的依赖：全部为 getter，读到的是 app 当前的实时状态（设置、词书、熟词、引擎在运行中会被整体替换）。
 */
export interface PageExtrasDeps {
  doc: Document;
  getSettings(): Settings;
  isActive(): boolean;
  getCard(): CardView | null;
  openCard(anchor: HTMLElement): void;
  getDictionary(): Dictionary;
  lemmatizer: Lemmatizer;
  getLoadedBooks(): WordBook[];
  getKnown(): ReadonlySet<string>;
  /** 本页高亮词条（engine.matchedLemmas；引擎未运行时为空） */
  getPageLemmas(): string[];
  /** 乐观移除页面高亮（engine.removeLemma） */
  removeLemma(lemma: string): void;
  /** 是否顶层 frame：悬浮球只在顶层显示 */
  isTop: boolean;
}

export interface PageExtras {
  readonly ctx: SiteContext;
  /** app 读到新设置后调用 */
  settingsChanged(): void;
  stop(): void;
}

/**
 * 组装站点适配层与悬浮球（app.ts 唯一的接入点，在引擎首次扫描前调用，站点跳过规则才能对首屏生效）。
 */
export function startPageExtras(deps: PageExtrasDeps): PageExtras {
  const listeners = new Set<(next: Settings) => void>();
  const ctx: SiteContext = {
    doc: deps.doc,
    getSettings: deps.getSettings,
    isActive: deps.isActive,
    getCard: deps.getCard,
    openCard: deps.openCard,
    lookupMany: (words) => deps.getDictionary().lookupMany(words),
    createMatcher: () => new WordMatcher({ lemmatizer: deps.lemmatizer, books: deps.getLoadedBooks(), known: deps.getKnown() }),
    lemmaCandidates: (word) => deps.lemmatizer.candidates(word),
    pageLemmas: deps.getPageLemmas,
    markKnown: async (lemma, surface) => {
      deps.removeLemma(lemma);
      return sendToBackground('markKnown', { word: surface, lemma });
    },
    unmarkKnown: (lemma) => sendToBackground('unmarkKnown', { lemma }),
    onSettingsChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  // 子 frame（如嵌入的 YouTube 播放器 iframe）只做站点跳过规则与字幕标注，不显示悬浮球
  const stops = [startSiteAdapters(ctx, deps.doc.location?.hostname ?? location.hostname)];
  if (deps.isTop) stops.push(startFloatBall(ctx));
  return {
    ctx,
    settingsChanged: () => {
      const s = deps.getSettings();
      for (const cb of listeners) cb(s);
    },
    stop: () => stops.forEach((stop) => stop()),
  };
}
