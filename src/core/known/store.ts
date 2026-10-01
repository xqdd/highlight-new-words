import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../storage/keys';
import { withStorageLock } from '../storage/lock';
import { applyKnownChange, normalizeKnown } from './merge';
import type { KnownExportFormat, KnownWordsData } from './types';

/**
 * 熟词本存储读写（任何上下文可读；写入请在 background 或扩展页面中进行，内容脚本通过 markKnown/unmarkKnown 消息）。
 * 标记熟词的完整流程（含 deleteOnKnown 删除来源词）由 background 的 markKnown 消息处理，见 background/known.ts。
 */

export async function getKnownData(): Promise<KnownWordsData> {
  const res = await browser.storage.local.get(STORAGE_KEYS.knownWords);
  return normalizeKnown(res[STORAGE_KEYS.knownWords]);
}

/** 当前熟词集合（小写原形），供 matcher 使用 */
export async function getKnownWords(): Promise<Set<string>> {
  return new Set(Object.keys((await getKnownData()).words));
}

export async function saveKnownData(data: KnownWordsData): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.knownWords]: data });
}

/** 加入（known=true）或撤销（false）熟词，带锁的读改写；返回最新熟词数 */
export function setKnownWords(words: Iterable<string>, known: boolean): Promise<number> {
  const list = [...words];
  return withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const next = applyKnownChange(await getKnownData(), list, known);
    await saveKnownData(next);
    return Object.keys(next.words).length;
  });
}

/** 用新列表整体替换熟词本（options 文本框编辑）：新增的记加入时间，删除的记墓碑 */
export function replaceKnownWords(list: Iterable<string>): Promise<number> {
  const target = new Set([...list].map((w) => w.trim().toLowerCase()).filter(Boolean));
  return withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const cur = await getKnownData();
    const removed = Object.keys(cur.words).filter((w) => !target.has(w));
    const added = [...target].filter((w) => !(w in cur.words));
    const next = applyKnownChange(applyKnownChange(cur, added, true), removed, false);
    await saveKnownData(next);
    return Object.keys(next.words).length;
  });
}

/** 导入熟词（与现有合并，不删除），返回新增数量。words 来自 core/import 的 parseWordList */
export function importKnownWords(words: Iterable<string>): Promise<number> {
  const list = [...words];
  return withStorageLock(STORAGE_KEYS.knownWords, async () => {
    const cur = await getKnownData();
    const added = list.map((w) => w.trim().toLowerCase()).filter((w) => w && !(w in cur.words));
    await saveKnownData(applyKnownChange(cur, added, true));
    return new Set(added).size;
  });
}

/** 导出熟词本文本：txt 一行一词；csv 含表头 word,addedAt（ISO 时间） */
export async function exportKnownWords(format: KnownExportFormat = 'txt'): Promise<string> {
  const entries = Object.entries((await getKnownData()).words).sort(([a], [b]) => a.localeCompare(b));
  if (format === 'txt') return entries.map(([w]) => w).join('\n') + '\n';
  return ['word,addedAt', ...entries.map(([w, t]) => `${w},${t ? new Date(t).toISOString() : ''}`)].join('\n') + '\n';
}
