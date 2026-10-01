import { normalizeSettings } from '../settings/migrate';
import type { Settings } from '../settings/schema';
import type { LocalBookData, LocalBookIndex, LocalBookMeta, UserWordMap } from '../wordbook/types';

/**
 * 多设备合并规则（纯函数，便于单测）：
 * - 设置：整体按 updatedAt LWW；本机字段（sync 开关、各来源 apiToken）永远保留本机值
 * - 熟词：见 core/known/merge.ts 的 mergeKnownWords（并集 + 墓碑）
 * - 本地词书：每本按 meta.updatedAt LWW；删除墓碑时间 >= 词书更新时间则删除
 */

/** 参与同步的设置：去掉本机字段 */
export type SyncedSettings = Omit<Settings, 'sync'>;

export function pickSyncedSettings(s: Settings): SyncedSettings {
  const { sync: _sync, ...rest } = structuredClone(s);
  for (const src of Object.values(rest.sources)) delete src.apiToken;
  return rest;
}

/**
 * 远端设置较新时返回应写入本机的设置（保留本机字段）；否则返回 undefined（无需写入）。
 */
export function mergeSyncedSettings(local: Settings, remote: SyncedSettings): Settings | undefined {
  if (!(remote.updatedAt > local.updatedAt)) return undefined;
  const next = normalizeSettings(remote);
  next.updatedAt = remote.updatedAt;
  next.sync = structuredClone(local.sync);
  for (const [id, src] of Object.entries(next.sources)) {
    const token = local.sources[id]?.apiToken;
    if (token) src.apiToken = token;
  }
  return next;
}

/** 本地词书同步段内容：full 带释义；reduced 只有单词列表 */
export type LocalBookSegment =
  | { meta: LocalBookMeta; words: UserWordMap }
  | { meta: LocalBookMeta; list: string[] };

export function toLocalBookSegment(meta: LocalBookMeta, data: LocalBookData, reduced: boolean): LocalBookSegment {
  return reduced ? { meta, list: Object.values(data.words).map((w) => w.word) } : { meta, words: data.words };
}

/** 段 -> 本地词书数据；降级段（只有单词）可传本机旧数据 prev，保留同词的释义/音标 */
export function fromLocalBookSegment(seg: LocalBookSegment, prev?: LocalBookData): LocalBookData {
  if ('words' in seg) return { id: seg.meta.id, words: seg.words };
  return {
    id: seg.meta.id,
    words: Object.fromEntries(seg.list.map((w) => [w.toLowerCase(), prev?.words[w.toLowerCase()] ?? { word: w }])),
  };
}

/** 本地词书合并决策 */
export interface LocalBooksMergePlan {
  /** 需要写入（新增或远端较新）的词书 */
  upsert: LocalBookSegment[];
  /** 需要在本机删除的词书 id */
  remove: string[];
  /** 合并后的墓碑 */
  removed: Record<string, number>;
}

/**
 * 本地词书合并：remoteBooks 为远端各段，remoteRemoved 为远端墓碑。
 * 远端被跳过（超配额）的书不会出现在 remoteBooks 中，本机保留，不视为删除。
 */
export function planLocalBooksMerge(
  local: LocalBookIndex,
  remoteBooks: LocalBookSegment[],
  remoteRemoved: Record<string, number>,
): LocalBooksMergePlan {
  const removed: Record<string, number> = { ...local.removed };
  for (const [id, t] of Object.entries(remoteRemoved)) removed[id] = Math.max(removed[id] ?? 0, t);
  const upsert: LocalBookSegment[] = [];
  for (const seg of remoteBooks) {
    const id = seg.meta.id;
    if ((removed[id] ?? -1) >= seg.meta.updatedAt) continue;
    const mine = local.books[id];
    if (!mine || seg.meta.updatedAt > mine.updatedAt) upsert.push(seg);
  }
  const remove = Object.values(local.books)
    .filter((m) => (removed[m.id] ?? -1) >= m.updatedAt)
    .map((m) => m.id);
  return { upsert, remove, removed };
}
