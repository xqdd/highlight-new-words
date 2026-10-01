import { browser } from 'wxt/browser';
import { setKnownWords } from '@/core/known/store';
import { createLemmatizer } from '@/core/lemma';
import type { Lemmatizer } from '@/core/lemma/types';
import type { MarkKnownResult } from '@/core/messaging/protocol';
import { getSettings } from '@/core/settings/store';
import { SESSION_KEYS } from '@/core/storage/keys';
import { getSourceIndex } from '@/core/wordbook/user-store';
import { getSourceProvider } from './sources';
import { deleteFromSources, restoreSourceWords, type RemovedSourceWords } from './sources/service';

/** background 共享的词形还原器（懒加载数据，init 幂等；init 失败时下次调用重试） */
let lemmatizerPromise: Promise<Lemmatizer> | undefined;
export function getLemmatizer(): Promise<Lemmatizer> {
  lemmatizerPromise ??= (async () => {
    const l = createLemmatizer();
    await l.init?.();
    return l;
  })().catch((e) => {
    lemmatizerPromise = undefined;
    throw e;
  });
  return lemmatizerPromise;
}

/** 撤销记录有效期：卡片上的“撤销”通常在几秒内点击，10 分钟足够且避免误恢复很久以前删除的词 */
export const KNOWN_UNDO_TTL_MS = 10 * 60 * 1000;

interface UndoRecord {
  at: number;
  removed: RemovedSourceWords[];
}
type UndoStore = Record<string, UndoRecord>;

/** 撤销记录存在 storage.session：SW 被回收后仍在，浏览器关闭即清空 */
async function loadUndo(): Promise<UndoStore> {
  const res = await browser.storage.session.get(SESSION_KEYS.knownUndo);
  return (res[SESSION_KEYS.knownUndo] as UndoStore | undefined) ?? {};
}

async function saveUndo(store: UndoStore): Promise<void> {
  const now = Date.now();
  for (const [k, v] of Object.entries(store)) if (now - v.at > KNOWN_UNDO_TTL_MS) delete store[k];
  await browser.storage.session.set({ [SESSION_KEYS.knownUndo]: store });
}

/**
 * 标记熟词：
 * 1. 写入熟词本（lemma）
 * 2. 对开启 deleteOnKnown 且支持删除的来源，删除其各生词本中与 lemma 原形相同的所有词形（running/ran -> run）
 * 3. 记录被删除的词条，供撤销时加回
 */
export async function markKnown(word: string, lemma: string): Promise<MarkKnownResult> {
  const target = lemma.trim().toLowerCase();
  await setKnownWords([target], true);
  const settings = await getSettings();
  const bookIds = Object.values((await getSourceIndex()).books)
    .filter((b) => {
      const src = settings.sources[b.providerId];
      return src?.enabled && src.deleteOnKnown && getSourceProvider(b.providerId)?.capabilities.delete;
    })
    .map((b) => b.id);
  if (bookIds.length === 0) return { ok: true, lemma: target, deleted: [], message: '已标记为熟词' };

  const removed: RemovedSourceWords[] = [];
  const res = await deleteFromSources(target, { bookIds, forms: true, lemmatizer: await getLemmatizer(), removed });
  if (removed.length > 0) {
    const store = await loadUndo();
    store[target] = { at: Date.now(), removed };
    await saveUndo(store);
  }
  const deletedWords = [...new Set(res.reports.flatMap((r) => r.deleted))];
  const failed = res.reports.flatMap((r) => r.failed);
  console.log('[hnw] 标记熟词', word, '->', target, '删除来源词形', deletedWords, '失败', failed);
  let message = '已标记为熟词';
  if (deletedWords.length) message += `，并从生词本删除 ${deletedWords.join('、')}`;
  // 熟词已写入，来源删除失败只作提示（ok 仍为 true）
  if (failed.length) message += `；${failed.length} 个词从生词本删除失败：${failed[0]!.error}`;
  return { ok: true, lemma: target, deleted: res.reports, message };
}

/** 撤销熟词：移出熟词本（记墓碑），并在有效期内把 deleteOnKnown 删除的来源词加回 */
export async function unmarkKnown(lemma: string): Promise<{ ok: boolean; restored?: string[]; message?: string }> {
  const target = lemma.trim().toLowerCase();
  await setKnownWords([target], false);
  const store = await loadUndo();
  const record = store[target];
  if (!record) return { ok: true };
  delete store[target];
  await saveUndo(store);
  if (Date.now() - record.at > KNOWN_UNDO_TTL_MS) return { ok: true };
  const restored = await restoreSourceWords(record.removed);
  const total = record.removed.reduce((n, r) => n + r.words.length, 0);
  const message = restored.length
    ? `已撤销，并把 ${restored.join('、')} 加回生词本${restored.length < total ? '（部分来源不支持加回）' : ''}`
    : '已撤销（来源生词本中已删除的单词无法自动加回）';
  return { ok: true, restored, message };
}
