import { effectiveBookRole } from '@/core/known/sources';
import { sendToBackground } from '@/core/messaging';
import type { AddWordResult, MarkKnownResult, RemoveWordResult, WordActionPreview, WordTargetResult } from '@/core/messaging/protocol';
import { MY_WORDS_BOOK_ID, type BookId, type Settings } from '@/core/settings/schema';
import { getSettings } from '@/core/settings/store';
import { getProviderInfo } from '@/core/source/providers';
import { getLocalIndex, getSourceIndex } from '@/core/wordbook/user-store';
import type { LocalBookIndex, SourceBookIndex, SourceBookState } from '@/core/wordbook/types';

/**
 * 卡片的“单词操作”后端：加入生词本 / 标记熟词 / 撤销 / 预览，全部转发 background 消息（background/known.ts），
 * 目标候选列表只读 storage.local（设置、来源词书索引、本地词书索引），不发网络请求。
 *
 * 入口（app.ts）只注入 CardActions 的基础能力（发音、认识、撤销、来源删除）；这里的能力由卡片自己持有，
 * 这样“加入生词本”等新交互不依赖入口改动。单测可注入假实现。
 */
export interface CardBackend {
  /** 收藏状态：是否已在 addTargets 的某本生词本中 */
  getWordState(lemma: string): Promise<{ collected: boolean; collectedIn: BookId[]; known: boolean }>;
  /** 执行前预览（只读本地缓存）：写入目标、各书将移除的词形、是否含不可撤销的远端删除 */
  preview(action: 'add' | 'known', word: string, lemma: string): Promise<WordActionPreview>;
  /** “加入生词本”可选的目标（本地词书 + 角色为生词本的来源词书），含默认勾选与不可用原因 */
  listAddTargets(): Promise<AddTargetOption[]>;
  /** 加入生词本；targets 为卡片上临时选择的目标（不传 = 设置中的默认目标） */
  addWord(data: { word: string; lemma: string; trans?: string; phonetic?: string; targets?: BookId[] }): Promise<AddWordResult>;
  /** 移出生词本（取消收藏 / 撤销加入） */
  removeWord(lemma: string, bookIds?: BookId[]): Promise<RemoveWordResult>;
  /** 用户确认后再次标记熟词（confirmed=true：同形异义词形也从来源删除；background 侧幂等） */
  confirmKnown(word: string, lemma: string): Promise<MarkKnownResult>;
  /** 读取若干来源词书的状态（判断能否删除、只读原因） */
  sourceStates(ids: BookId[]): Promise<Record<BookId, SourceBookState | undefined>>;
}

/** “加入生词本”的一个候选目标 */
export interface AddTargetOption {
  id: BookId;
  /** 显示名：本地词书名称；来源词书“有道词典 · 无标签” */
  name: string;
  /** 来源词书（写入会同步到远端） */
  remote: boolean;
  /** 设置中的默认目标 */
  isDefault: boolean;
  /** 不能写入的原因；有值时卡片置灰并展示 */
  disabledReason?: string;
  /** 补充说明（如“首次加入时自动创建”） */
  note?: string;
}

/** “我的生词本”的显示名（与 background/known.ts 一致） */
export const MY_WORDS_NAME = '我的生词本';

/** 设置中的默认加入目标；为空时 background 退回“我的生词本” */
export function defaultAddTargets(settings: Pick<Settings, 'wordActions'>): BookId[] {
  const ids = [...new Set(settings.wordActions.addTargets)];
  return ids.length ? ids : [MY_WORDS_BOOK_ID];
}

/** 来源词书显示名 */
export function sourceBookName(state: Pick<SourceBookState, 'providerId' | 'name' | 'remoteId'>): string {
  return `${getProviderInfo(state.providerId)?.name ?? state.providerId} · ${state.name || state.remoteId}`;
}

/** 来源词书不能加词的原因（可加时返回 undefined） */
function addBlockReason(state: SourceBookState | undefined, settings: Settings): string | undefined {
  if (!state) return '该生词本已不存在';
  if (state.orphaned) return '远端已没有该生词本';
  if (!settings.sources[state.providerId]?.enabled) return '该来源未启用';
  if (!state.canAdd) return state.readOnlyReason ?? '该生词本不支持加词';
  return undefined;
}

/**
 * 组装“加入生词本”候选目标（纯函数，便于单测）：
 * 本地词书（含尚未创建的“我的生词本”）在前，来源生词本在后；默认目标即使不可用也列出（置灰并说明原因），
 * 来源熟词本（如欧路“已掌握”）不作为加入目标。
 */
export function buildAddTargets(settings: Settings, sources: SourceBookIndex, locals: LocalBookIndex): AddTargetOption[] {
  const defaults = new Set(defaultAddTargets(settings));
  const out: AddTargetOption[] = [];
  const localIds = Object.keys(locals.books);
  if (!localIds.includes(MY_WORDS_BOOK_ID)) {
    out.push({ id: MY_WORDS_BOOK_ID, name: MY_WORDS_NAME, remote: false, isDefault: defaults.has(MY_WORDS_BOOK_ID), note: '首次加入时自动创建' });
  }
  for (const id of localIds) {
    out.push({ id, name: locals.books[id]!.name, remote: false, isDefault: defaults.has(id) });
  }
  // 默认目标中已删除的本地词书也列出，说明为什么没写进去
  for (const id of defaults) {
    if (id.startsWith('local:') && id !== MY_WORDS_BOOK_ID && !locals.books[id]) {
      out.push({ id, name: '已删除的本地词书', remote: false, isDefault: true, disabledReason: '该本地词书已删除' });
    }
  }
  for (const state of Object.values(sources.books)) {
    if (effectiveBookRole(state, settings) !== 'new') continue;
    const isDefault = defaults.has(state.id);
    // 未启用来源、远端已消失的书只在它是默认目标时列出（解释为什么没写进去）
    if (!isDefault && (state.orphaned || !settings.sources[state.providerId]?.enabled)) continue;
    const reason = addBlockReason(state, settings);
    out.push({ id: state.id, name: sourceBookName(state), remote: true, isDefault, ...(reason ? { disabledReason: reason } : {}) });
  }
  return out;
}

/** 运行时实现：消息转发 background，候选目标读 storage */
export function createCardBackend(): CardBackend {
  return {
    getWordState: (lemma) => sendToBackground('getWordState', { lemma }),
    preview: (action, word, lemma) => sendToBackground('previewWordAction', { action, word, lemma }),
    listAddTargets: async () => {
      const [settings, sources, locals] = await Promise.all([getSettings(), getSourceIndex(), getLocalIndex()]);
      return buildAddTargets(settings, sources, locals);
    },
    addWord: (data) => sendToBackground('addWord', data),
    removeWord: (lemma, bookIds) => sendToBackground('removeWord', { lemma, ...(bookIds ? { bookIds } : {}) }),
    confirmKnown: (word, lemma) => sendToBackground('markKnown', { word, lemma, confirmed: true }),
    sourceStates: async (ids) => {
      const index = await getSourceIndex();
      return Object.fromEntries(ids.map((id) => [id, index.books[id]]));
    },
  };
}

// ---------------- 结果文案（纯函数） ----------------

const names = (rs: WordTargetResult[]) => rs.map((r) => `“${r.name}”`).join('、');

/**
 * 标记熟词结果 -> toast 文案：先说写进了哪里，再列出从哪些生词本删除了哪些词形、跳过/失败的原因、撤销说明。
 * background 的 message 第一段固定为“已标记为熟词”，其余段落原样保留（包含删除、只读跳过、撤销限制）。
 */
export function describeKnownResult(res: MarkKnownResult, fallbackLemma: string): string {
  const lemma = res.lemma || fallbackLemma;
  const written = (res.written ?? []).filter((w) => w.ok);
  const head = written.length ? `「${lemma}」已标为熟词，记入${names(written)}` : `「${lemma}」已标为熟词，不再高亮`;
  const rest = (res.message || '')
    .split('；')
    .map((s) => s.trim())
    .filter((s) => s && s !== '已标记为熟词');
  return [head, ...rest].join('；');
}

/** 加入生词本结果 -> toast 文案；请求了临时目标但后台按默认目标写入时补充说明 */
export function describeAddResult(res: AddWordResult, requested?: BookId[]): string {
  let msg = res.message || (res.ok ? `已加入${names(res.added.filter((a) => a.ok))}` : '加入失败');
  if (requested?.length) {
    const want = new Set(requested);
    const ignored = res.added.some((a) => !want.has(a.bookId));
    if (ignored) msg += '；当前版本暂不支持临时目标，已按设置中的默认目标加入';
  }
  return msg;
}

/** 说明行的一段文字；warn=true 的段落（跳过/不支持的原因）用警示色显示 */
export interface HintSegment {
  text: string;
  warn: boolean;
}

/** 预览 -> 卡片底部的说明行（写到哪里、会移除什么、哪些目标被跳过及原因） */
export function describePreview(p: WordActionPreview): { text: string; warn: boolean; segments: HintSegment[] } {
  const ok = p.write.filter((w) => w.ok);
  const skipped = p.write.filter((w) => !w.ok);
  const segments: HintSegment[] = [];
  if (p.action === 'known') {
    // background 在没有任何目标写入成功时兜底写本地熟词本
    segments.push({ text: `记入 ${ok.length ? ok.map((w) => w.name).join('、') : '本地熟词本'}`, warn: false });
  } else {
    segments.push(ok.length ? { text: `写入 ${ok.map((w) => w.name).join('、')}`, warn: false } : { text: '没有可写入的生词本', warn: true });
  }
  const removing = p.remove.filter((r) => r.ok && r.words.length);
  if (removing.length) segments.push({ text: `并从 ${removing.map((r) => `${r.name}（${r.words.join('、')}）`).join('、')} 移除`, warn: false });
  for (const s of skipped) segments.push({ text: `${s.name}：${s.error ?? '不支持'}，已跳过`, warn: true });
  for (const r of p.remove.filter((r) => !r.ok)) segments.push({ text: `${r.name}：${r.error ?? '不支持删除'}，不会移除`, warn: true });
  return { text: segments.map((x) => x.text).join('；'), warn: segments.some((x) => x.warn), segments };
}
