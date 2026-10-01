import { effectiveBookRole } from '@/core/known/sources';
import { PackagedDictionary } from '@/core/dict/packaged';
import type { DictEntry } from '@/core/dict/types';
import { sendToBackground } from '@/core/messaging';
import type { AddWordResult, MarkKnownResult, RemoveWordResult, WordActionPreview } from '@/core/messaging/protocol';
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
  /**
   * 撤销熟词（直接调 background unmarkKnown，拿到“已加回/无法加回”结果做对称提示；
   * 入口注入的 CardActions.unmarkKnown 返回 void，不能用于展示详情）
   */
  unmarkKnown(lemma: string): Promise<{ ok: boolean; restored?: string[]; message?: string }>;
  /**
   * 打包词典的完整释义（可选）：单词加入用户生词本后，入口的组合词典会用生词本里的一行释义覆盖完整释义，
   * 卡片用它始终展示词典完整义项，生词本释义作为附加信息
   */
  lookupDict?(lemma: string): Promise<DictEntry | undefined>;
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

/** 卡片自用的打包词典（与入口的组合词典分开，不受用户生词本释义覆盖） */
let packagedDict: PackagedDictionary | undefined;

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
    unmarkKnown: (lemma) => sendToBackground('unmarkKnown', { lemma }),
    lookupDict: (lemma) => {
      // 懒创建：只在打开卡片时加载对应首字母的分片（浏览器对扩展资源有缓存）
      packagedDict ??= new PackagedDictionary();
      return packagedDict.lookup(lemma);
    },
  };
}

// ---------------- 结果文案（纯函数） ----------------

const names = (rs: { name: string }[]) => rs.map((r) => `“${r.name}”`).join('、');
/** 英文单词列表用半角逗号连接（中文顿号在西文字体中显示怪异） */
const wordList = (words: string[]) => words.join(', ');

/** 结果提示的级别：ok 成功（含只读跳过等说明）/ warn 部分失败 / err 全部失败 */
export type NoticeLevel = 'ok' | 'warn' | 'err';

/**
 * 结果提示：toast 只显示一行 title（主结论），details 折叠在“详情”里（逐项去向、跳过原因、撤销说明）。
 * 失败（warn/err）用独立的警示样式，首行写明“部分失败”/失败原因，不会与成功混淆。
 */
export interface Notice {
  level: NoticeLevel;
  title: string;
  details: string[];
}

/** background 的 message 按“；”分段（每段是一个目标的结果或一条说明） */
function messageParts(message: string | undefined): string[] {
  return (message || '')
    .split('；')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 标题后缀：“（1 处跳过）”“（2 处失败）” */
function countSuffix(failed: number, skipped: number): string {
  const parts = [failed ? `${failed} 处失败` : '', skipped ? `${skipped} 处跳过` : ''].filter(Boolean);
  return parts.length ? `（${parts.join('，')}）` : '';
}

/**
 * 标记熟词结果 -> 提示：标题写明记入了哪些熟词本，详情列出从哪些生词本删除了哪些词形、跳过/失败的原因、撤销限制。
 * background 的 message 第一段固定为“已标记为熟词”，其余段落原样作为详情。
 */
export function knownNotice(res: MarkKnownResult, fallbackLemma: string): Notice {
  const lemma = res.lemma || fallbackLemma;
  const written = res.written ?? [];
  const okWritten = written.filter((w) => w.ok);
  const failed = written.filter((w) => !w.ok && !w.skipped).length + res.deleted.reduce((n, r) => n + r.failed.length, 0);
  const skipped = written.filter((w) => w.skipped).length + (res.withheld?.length ?? 0);
  const where = okWritten.length ? `，记入${names(okWritten)}` : '，不再高亮';
  return {
    level: failed ? 'warn' : 'ok',
    title: `${failed ? '部分失败：' : ''}「${lemma}」已标为熟词${where}${countSuffix(failed, skipped)}`,
    details: messageParts(res.message).filter((s) => s !== '已标记为熟词'),
  };
}

/** 加入生词本结果 -> 提示：标题写明加到了哪些生词本；部分失败/全部失败用警示样式 */
export function addNotice(res: AddWordResult, fallbackLemma: string, prefix = ''): Notice {
  const lemma = res.lemma || fallbackLemma;
  const ok = res.added.filter((a) => a.ok);
  const failed = res.added.filter((a) => !a.ok && !a.skipped).length + res.removedKnown.filter((r) => !r.ok && !r.skipped).length;
  const skipped = res.added.filter((a) => a.skipped).length;
  const details = messageParts(res.message).filter((s) => s !== '加入失败' && !s.startsWith('已加入'));
  if (!res.ok) {
    // 全部失败：标题直接给出第一个原因，详情逐项列出
    const reason = res.added.find((a) => !a.ok)?.error ?? (res.added.length ? undefined : res.message);
    return { level: 'err', title: `${prefix}「${lemma}」未能加入生词本${reason ? `：${reason}` : ''}`, details };
  }
  return {
    level: failed ? 'warn' : 'ok',
    title: `${prefix}${failed ? '部分失败：' : ''}「${lemma}」已加入${names(ok)}${countSuffix(failed, skipped)}`,
    details,
  };
}

/** 移出生词本（取消收藏）结果 -> 提示 */
export function removeNotice(res: RemoveWordResult, lemma: string, prefix = ''): Notice {
  const ok = res.removed.filter((r) => r.ok && r.words.length);
  const failed = res.removed.filter((r) => !r.ok);
  const details = messageParts(res.message);
  if (!res.ok && !ok.length) return { level: 'err', title: `${prefix}「${lemma}」未能移出生词本${failed[0]?.error ? `：${failed[0].error}` : ''}`, details };
  if (!ok.length) return { level: 'ok', title: `${prefix}生词本中没有「${lemma}」`, details: [] };
  return {
    level: failed.length ? 'warn' : 'ok',
    title: `${prefix}${failed.length ? '部分失败：' : ''}「${lemma}」已移出${names(ok)}${countSuffix(failed.length, 0)}`,
    details,
  };
}

/**
 * 撤销熟词的提示（与原操作对称）：逐本说明认识时移除的词形哪些已加回、哪些没能加回；
 * 加回到其他分组、仍在来源熟词本中等情况沿用 background 的说明。
 * bookName 用于把来源删除报告里的 bookId 换成显示名。
 */
export function undoKnownNotice(
  known: MarkKnownResult,
  undo: { ok: boolean; restored?: string[]; message?: string },
  lemma: string,
  bookName: (id: BookId) => string,
): Notice {
  const restored = new Set(undo.restored ?? []);
  const removed: { name: string; words: string[] }[] = [
    ...(known.removedLocal ?? []).filter((r) => r.ok && r.words.length).map((r) => ({ name: r.name, words: r.words })),
    ...known.deleted.filter((r) => r.deleted.length).map((r) => ({ name: bookName(r.bookId), words: r.deleted })),
  ];
  const details: string[] = [];
  let lost = 0;
  for (const r of removed) {
    const back = r.words.filter((w) => restored.has(w));
    const miss = r.words.filter((w) => !restored.has(w));
    if (back.length) details.push(`已加回“${r.name}”：${wordList(back)}`);
    if (miss.length) {
      lost += miss.length;
      details.push(`未能加回“${r.name}”：${wordList(miss)}`);
    }
  }
  // background 的补充说明（加回到同来源其他分组、无法加回、仍在来源熟词本中）
  const notes = messageParts(undo.message).filter((s) => s !== '已撤销' && !s.startsWith('已加回'));
  details.push(...notes);
  const stillKnown = notes.some((s) => s.includes('依然不会高亮'));
  if (!undo.ok) return { level: 'err', title: `撤销失败：「${lemma}」仍是熟词`, details };
  const head = stillKnown ? `已撤销本地熟词标记，「${lemma}」仍在来源熟词本中` : `已撤销，「${lemma}」恢复高亮`;
  const backTo = removed.filter((r) => r.words.some((w) => restored.has(w)));
  const tail = lost ? `（${lost} 个词形未能加回）` : backTo.length === 1 ? `，已加回${names(backTo)}` : backTo.length ? `，已加回 ${backTo.length} 本生词本` : '';
  return { level: lost || stillKnown ? 'warn' : 'ok', title: head + tail, details };
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
