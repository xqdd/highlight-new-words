import { browser } from 'wxt/browser';
import { getKnownData, saveKnownData } from '../known/store';
import { mergeKnownWords } from '../known/merge';
import { getSettings, saveSettings } from '../settings/store';
import type { Settings, SyncDataKind } from '../settings/schema';
import { localBookKey, sourceBookKey } from '../storage/keys';
import { getLocalBook, getLocalIndex, getSourceBook, getSourceIndex, updateLocalIndex, updateSourceIndex } from '../wordbook/user-store';
import type { LocalBookData, SourceBookData, SourceBookState } from '../wordbook/types';
import { SyncConflictError, type RemoteSnapshot, type SyncBackend } from './backend';
import { decodeSyncValue, encodeSyncValue, stableStringify } from './codec';
import { credentialsFor, mergeRemoteCredentials, type CredentialBundle } from './credentials';
import { decodeKnownSegment, encodeKnownSegment } from './known-codec';
import {
  fromLocalBookSegment,
  mergeSyncedSettings,
  pickSyncedSettings,
  planLocalBooksMerge,
  toLocalBookSegment,
  type LocalBookSegment,
  type SyncedSettings,
} from './merge';
import type { SyncPlan } from './plan';
import type { ManifestSegment, SegmentCandidate, SyncBackendId, SyncSegmentKind } from './types';

/**
 * 快照的构造与合并（所有同步后端共用，见 backend.ts）。
 *
 * 段 id 约定：
 * - `settings`：pickSyncedSettings（去掉本机字段 sync 与 apiToken），LWW
 * - `known`：本地熟词本（含墓碑），紧凑编码 known-codec.ts，并集合并
 * - `lbr`：本地词书删除墓碑；`lb:<uuid>`：每本本地词书一段，LWW
 * - `sb:<bookId>`：来源词书缓存（仅 WebDAV / 备份可选；只增不删，较新者胜）
 * - `cred`：勾选随同步上传的凭据（credentials.ts）
 */
export const SEG_SETTINGS = 'settings';
export const SEG_KNOWN = 'known';
export const SEG_LOCAL_REMOVED = 'lbr';
export const SEG_LOCAL_PREFIX = 'lb:';
export const SEG_SOURCE_PREFIX = 'sb:';
export const SEG_CREDENTIALS = 'cred';

/** 同步范围：哪个后端（决定凭据排除）+ 启用的数据类别 */
export interface SnapshotScope {
  backend: SyncBackendId | 'backup';
  include: Record<SyncDataKind, boolean> & { sourceBooks?: boolean };
}

/** 段类别是否在本次同步范围内：凭据随“设置”类别；来源词书缓存需显式开启 */
export function scopeIncludes(scope: SnapshotScope, kind: SyncSegmentKind): boolean {
  if (kind === 'credentials') return scope.include.settings;
  if (kind === 'sourceBooks') return !!scope.include.sourceBooks;
  return scope.include[kind];
}

/** 来源词书缓存段内容 */
export interface SourceBookSegment {
  state: SourceBookState;
  data: SourceBookData;
}

/**
 * 段构造器：带编码缓存（本地词书/来源词书较大时避免每次推送都重新压缩，key = 段id@更新时间@级别）。
 * 每个后端的服务持有一个实例。
 */
export class SnapshotBuilder {
  private cache = new Map<string, string>();

  private async encodeCached(key: string, value: () => unknown): Promise<string> {
    let enc = this.cache.get(key);
    if (!enc) {
      enc = await encodeSyncValue(value());
      this.cache.set(key, enc);
    }
    return enc;
  }

  /** 按本机数据构造候选段（优先级：settings 0、cred 0.5、known 1、lbr 2、本地词书 10+ 小书优先、来源词书 100000+） */
  async build(settings: Settings, scope: SnapshotScope): Promise<SegmentCandidate[]> {
    const out: SegmentCandidate[] = [];
    if (scope.include.settings) {
      const encoded = await encodeSyncValue(pickSyncedSettings(settings));
      out.push({ id: SEG_SETTINGS, kind: 'settings', priority: 0, at: settings.updatedAt, label: '设置', variants: [{ level: 'full', encoded }] });
      const creds = await credentialsFor(settings, scope.backend);
      if (Object.keys(creds).length) {
        const at = Math.max(...Object.values(creds).map((c) => c.at));
        out.push({ id: SEG_CREDENTIALS, kind: 'credentials', priority: 0.5, at, label: '凭据', variants: [{ level: 'full', encoded: await encodeSyncValue(creds) }] });
      }
    }
    if (scope.include.knownWords) {
      const known = await getKnownData();
      // 熟词本/墓碑没有单一更新时间，at 记 0（at 参与 manifest 比较，不能用当前时间，否则每次都会重写 manifest）
      // 超配额时先降级为天精度时间（见 known-codec.ts）
      out.push({
        id: SEG_KNOWN,
        kind: 'knownWords',
        priority: 1,
        at: 0,
        label: '熟词本',
        variants: [
          { level: 'full', encoded: await encodeSyncValue(encodeKnownSegment(known, 'full')) },
          { level: 'reduced', encoded: await encodeSyncValue(encodeKnownSegment(known, 'reduced')) },
        ],
      });
    }
    if (scope.include.localBooks) {
      const index = await getLocalIndex();
      const encoded = await encodeSyncValue(index.removed);
      out.push({ id: SEG_LOCAL_REMOVED, kind: 'localBooks', priority: 2, at: 0, label: '已删除词书记录', variants: [{ level: 'full', encoded }] });
      // 小书优先：同样的配额下能同步更多本
      const metas = Object.values(index.books).sort((a, b) => a.wordCount - b.wordCount);
      for (const [i, meta] of metas.entries()) {
        const data = await getLocalBook(meta.id);
        if (!data) continue;
        const segId = SEG_LOCAL_PREFIX + meta.id.slice(meta.id.indexOf(':') + 1);
        out.push({
          id: segId,
          kind: 'localBooks',
          priority: 10 + i,
          at: meta.updatedAt,
          label: meta.name,
          variants: [
            { level: 'full', encoded: await this.encodeCached(`${segId}@${meta.updatedAt}@full`, () => toLocalBookSegment(meta, data, false)) },
            { level: 'reduced', encoded: await this.encodeCached(`${segId}@${meta.updatedAt}@reduced`, () => toLocalBookSegment(meta, data, true)) },
          ],
        });
      }
    }
    if (scope.include.sourceBooks) {
      const index = await getSourceIndex();
      for (const [i, state] of Object.values(index.books).entries()) {
        const data = await getSourceBook(state.id);
        if (!data) continue;
        const segId = SEG_SOURCE_PREFIX + state.id;
        // 状态中的同步进度字段不进快照（syncing/error 是本机瞬时状态）
        const { status: _s, error: _e, lastAttemptAt: _a, ...rest } = state;
        const seg: SourceBookSegment = { state: { ...rest, status: 'ok', lastAttemptAt: 0 }, data };
        out.push({
          id: segId,
          kind: 'sourceBooks',
          priority: 100_000 + i,
          at: data.updatedAt,
          label: state.name,
          variants: [{ level: 'full', encoded: await this.encodeCached(`${segId}@${data.updatedAt}@${stableStringify(rest)}`, () => seg) }],
        });
      }
    }
    return out;
  }
}

/** 一次拉取合并的摘要 */
export interface ApplySummary {
  settings: boolean;
  knownWords: boolean;
  localBooks: number;
  sourceBooks: number;
  credentials: string[];
}

/** 读取并解码一段；解码失败只跳过该段 */
async function readDecoded<T>(remote: RemoteSnapshot, id: string): Promise<T | undefined> {
  const encoded = await remote.readSegment(id);
  if (encoded === undefined) return undefined;
  try {
    return await decodeSyncValue<T>(encoded);
  } catch (e) {
    console.warn('[hnw] 同步段解码失败，跳过', id, e);
    return undefined;
  }
}

/**
 * 把远端快照合并到本机（只处理 scope 内的类别）；无变化的数据不写，避免触发多余的推送。
 * 设置先合并：凭据是否采用取决于合并后的 credentialSync 勾选。
 */
export async function applyRemoteSnapshot(remote: RemoteSnapshot, scope: SnapshotScope): Promise<ApplySummary> {
  const summary: ApplySummary = { settings: false, knownWords: false, localBooks: 0, sourceBooks: 0, credentials: [] };
  const settings = await getSettings();
  if (scope.include.settings) {
    const remoteSettings = await readDecoded<SyncedSettings>(remote, SEG_SETTINGS);
    const merged = remoteSettings && mergeSyncedSettings(settings, remoteSettings);
    if (merged) {
      await saveSettings(merged, { keepUpdatedAt: true });
      summary.settings = true;
    }
    const creds = await readDecoded<CredentialBundle>(remote, SEG_CREDENTIALS);
    if (creds) summary.credentials = await mergeRemoteCredentials(creds);
  }
  if (scope.include.knownWords) {
    const raw = await readDecoded<unknown>(remote, SEG_KNOWN);
    if (raw) {
      const local = await getKnownData();
      const merged = mergeKnownWords(local, decodeKnownSegment(raw));
      if (stableStringify(merged) !== stableStringify(local)) {
        await saveKnownData(merged);
        summary.knownWords = true;
      }
    }
  }
  if (scope.include.localBooks) {
    const remoteRemoved = (await readDecoded<Record<string, number>>(remote, SEG_LOCAL_REMOVED)) ?? {};
    const remoteBooks: LocalBookSegment[] = [];
    for (const id of Object.keys(remote.segs).filter((s) => s.startsWith(SEG_LOCAL_PREFIX))) {
      const seg = await readDecoded<LocalBookSegment>(remote, id);
      if (seg) remoteBooks.push(seg);
    }
    summary.localBooks = await applyLocalBooks(remoteBooks, remoteRemoved);
  }
  if (scope.include.sourceBooks) {
    for (const id of Object.keys(remote.segs).filter((s) => s.startsWith(SEG_SOURCE_PREFIX))) {
      const seg = await readDecoded<SourceBookSegment>(remote, id);
      if (seg && (await applySourceBook(seg))) summary.sourceBooks++;
    }
  }
  return summary;
}

/** 本地词书合并写回；返回变化的本数 */
export async function applyLocalBooks(remoteBooks: LocalBookSegment[], remoteRemoved: Record<string, number>): Promise<number> {
  const local = await getLocalIndex();
  const plan = planLocalBooksMerge(local, remoteBooks, remoteRemoved);
  if (plan.upsert.length === 0 && plan.remove.length === 0 && stableStringify(plan.removed) === stableStringify(local.removed)) return 0;
  const items: Record<string, LocalBookData> = {};
  for (const seg of plan.upsert) {
    // 远端为降级段（只有单词）而本机已有该书：保留本机同词的释义/音标，避免改名等小改动导致释义丢失
    const prev = 'list' in seg && local.books[seg.meta.id] ? await getLocalBook(seg.meta.id) : undefined;
    items[localBookKey(seg.meta.id)] = fromLocalBookSegment(seg, prev);
  }
  if (Object.keys(items).length > 0) await browser.storage.local.set(items);
  await browser.storage.local.remove(plan.remove.map(localBookKey));
  await updateLocalIndex((index) => {
    for (const seg of plan.upsert) index.books[seg.meta.id] = seg.meta;
    for (const id of plan.remove) delete index.books[id];
    index.removed = plan.removed;
  });
  return plan.upsert.length + plan.remove.length;
}

/**
 * 来源词书缓存：本机没有或远端缓存更新（data.updatedAt 更大）时采用远端；从不删除（缓存可以重新拉取）。
 * 状态只补齐/更新展示字段，本机正在同步的状态不覆盖。
 */
export async function applySourceBook(seg: SourceBookSegment): Promise<boolean> {
  const local = await getSourceBook(seg.data.id);
  if (local && local.updatedAt >= seg.data.updatedAt) return false;
  await browser.storage.local.set({ [sourceBookKey(seg.data.id)]: seg.data });
  await updateSourceIndex((index) => {
    const prev = index.books[seg.state.id];
    index.books[seg.state.id] = prev
      ? { ...prev, wordCount: seg.state.wordCount, entryCount: seg.state.entryCount, lastSyncAt: Math.max(prev.lastSyncAt, seg.state.lastSyncAt), ...(prev.status === 'syncing' ? {} : { status: 'ok', error: undefined }) }
      : { ...seg.state, status: 'ok' };
  });
  return true;
}

/** 远端已有、但本机未启用该类别的段：原样保留（可能是其他设备的数据） */
export function keptSegments(remote: RemoteSnapshot, scope: SnapshotScope): Record<string, ManifestSegment> {
  const kept: Record<string, ManifestSegment> = {};
  for (const [id, seg] of Object.entries(remote.segs)) if (!scopeIncludes(scope, seg.kind)) kept[id] = seg;
  return kept;
}

export interface SyncCycleResult {
  remote: RemoteSnapshot;
  plan: SyncPlan;
  wrote: boolean;
  writeOps: number;
  /** 因冲突重试的次数 */
  conflictRetries: number;
  applied: ApplySummary;
  /** 后端建议的复查同步延迟（见 BackendWriteResult.recheckAfterMs） */
  recheckAfterMs?: number;
}

/**
 * 通用同步一轮：read → 合并到本机 → 构造候选段 → 后端规划 → write；
 * write 报 SyncConflictError 时重新 read 合并后重试，最多 maxAttempts 次（之后抛出，由调用方显示错误、下次再试）。
 * scope 每轮按最新设置重新计算（合并远端设置后 include/凭据勾选可能变化）。
 */
export async function runSyncCycle(
  backend: SyncBackend,
  builder: SnapshotBuilder,
  opts: { deviceId: string; scopeOf: (s: Settings) => SnapshotScope; maxAttempts?: number; firstRemote?: RemoteSnapshot },
): Promise<SyncCycleResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let remote = opts.firstRemote;
  let applied: ApplySummary | undefined;
  for (let attempt = 0; ; attempt++) {
    if (!remote) {
      remote = await backend.read();
      applied = await applyRemoteSnapshot(remote, opts.scopeOf(await getSettings()));
    }
    const settings = await getSettings();
    const scope = opts.scopeOf(settings);
    const plan = backend.plan(await builder.build(settings, scope), remote, keptSegments(remote, scope));
    try {
      const res = await backend.write(plan, remote, opts.deviceId);
      return {
        remote,
        plan,
        wrote: res.wrote,
        writeOps: res.writeOps,
        conflictRetries: attempt,
        ...(res.recheckAfterMs ? { recheckAfterMs: res.recheckAfterMs } : {}),
        applied: applied ?? { settings: false, knownWords: false, localBooks: 0, sourceBooks: 0, credentials: [] },
      };
    } catch (e) {
      if (!(e instanceof SyncConflictError) || attempt + 1 >= maxAttempts) throw e;
      console.info('[hnw] 同步写入冲突，重新拉取合并后重试', backend.id, attempt + 1);
      remote = undefined;
    }
  }
}
