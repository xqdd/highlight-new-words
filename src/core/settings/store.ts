import { browser } from 'wxt/browser';
import { DEV_LEGACY_KEYS, LEGACY_KEYS, STORAGE_KEYS, localBookKey, sourceBookKey } from '../storage/keys';
import { SETTINGS_SCHEMA_VERSION, type Settings } from './schema';
import { createDefaultSettings } from './defaults';
import {
  deepMerge,
  hasLegacyData,
  migrateLegacy,
  migrateSettingsV2,
  normalizeSettings,
  type DevV2CloudBook,
  type LegacyStorage,
  type MigrationResult,
} from './migrate';
import type { LocalBookIndex, SourceBookIndex } from '../wordbook/types';

/**
 * 设置的存储读写与迁移。所有上下文（background/content/popup/options）通用。
 * 各上下文通过 watchSettings / chrome.storage.onChanged 感知变化，无需额外消息广播。
 * 熟词本读写见 core/known/store.ts，用户词书见 core/wordbook/user-store.ts。
 */

/** 深层可选，用于 patchSettings */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export async function getSettings(): Promise<Settings> {
  const res = await browser.storage.local.get(STORAGE_KEYS.settings);
  return normalizeSettings(res[STORAGE_KEYS.settings]);
}

/**
 * 保存设置并刷新 updatedAt（多设备同步按此 LWW）。
 * keepUpdatedAt=true 仅供 sync 层写入远端合并结果时使用，保留远端的时间戳。
 */
export async function saveSettings(settings: Settings, opts: { keepUpdatedAt?: boolean } = {}): Promise<void> {
  const value = opts.keepUpdatedAt ? settings : { ...settings, updatedAt: Date.now() };
  await browser.storage.local.set({ [STORAGE_KEYS.settings]: value });
}

/** 局部更新（深合并，数组整体替换），返回更新后的完整设置 */
export async function patchSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const next = deepMerge(await getSettings(), patch);
  await saveSettings(next);
  return next;
}

/** 恢复默认设置（旧版 resetSettings）；不清空用户词书与熟词本 */
export async function resetSettings(): Promise<Settings> {
  const defaults = createDefaultSettings();
  await saveSettings(defaults);
  return defaults;
}

/** 监听设置变化，返回取消函数 */
export function watchSettings(cb: (next: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[STORAGE_KEYS.settings]) {
      cb(normalizeSettings(changes[STORAGE_KEYS.settings]!.newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------- 站点禁用 ----------------

/** hostname 是否被禁用：精确匹配，或匹配其父域（禁用 example.com 同时禁用 www.example.com） */
export function isSiteDisabled(settings: Settings, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return settings.sites.disabled.some((d) => {
    const rule = d.trim().toLowerCase();
    return !!rule && (host === rule || host.endsWith('.' + rule));
  });
}

// ---------------- 迁移 ----------------

/** 迁移写入的 settings.updatedAt（见 writeMigration） */
export const MIGRATED_SETTINGS_UPDATED_AT = 1;

/** 写入迁移结果：settings + 来源词书/本地词书（索引与数据键） */
async function writeMigration({ settings, sourceBook, localBook }: MigrationResult): Promise<void> {
  // updatedAt 取极小值 1：迁移结果只应覆盖“全新默认设置”(0)，不应覆盖其他设备经 storage.sync 同步来的真实修改
  const items: Record<string, unknown> = { [STORAGE_KEYS.settings]: { ...settings, updatedAt: MIGRATED_SETTINGS_UPDATED_AT } };
  if (sourceBook) {
    const index: SourceBookIndex = { books: { [sourceBook.state.id]: sourceBook.state }, providers: {} };
    items[STORAGE_KEYS.sourceBooks] = index;
    items[sourceBookKey(sourceBook.state.id)] = { id: sourceBook.state.id, words: sourceBook.words, updatedAt: sourceBook.state.lastSyncAt };
  }
  if (localBook) {
    const index: LocalBookIndex = { books: { [localBook.meta.id]: localBook.meta }, removed: {} };
    items[STORAGE_KEYS.localBooks] = index;
    items[localBookKey(localBook.meta.id)] = { id: localBook.meta.id, words: localBook.words };
  }
  await browser.storage.local.set(items);
}

/**
 * 启动迁移（仅 background 在 SW 启动时调用一次）：
 * 1. 已有 settings 且 schemaVersion < 3（v3 开发期结构）：settings.cloud + cloudBook -> 来源词书/本地词书
 * 2. 无 settings 且存在 v2.x 旧键：migrateLegacy，迁移后删除旧键释放空间
 * 3. 全新安装：写入默认设置
 * @returns 是否执行了迁移
 */
export async function runMigrationIfNeeded(): Promise<boolean> {
  const all = await browser.storage.local.get([STORAGE_KEYS.settings, DEV_LEGACY_KEYS.cloudBook, ...LEGACY_KEYS]);
  const raw = all[STORAGE_KEYS.settings] as { schemaVersion?: number } | undefined;
  if (raw) {
    if ((raw.schemaVersion ?? 0) >= SETTINGS_SCHEMA_VERSION) return false;
    await writeMigration(migrateSettingsV2(raw, all[DEV_LEGACY_KEYS.cloudBook] as DevV2CloudBook | undefined));
    await browser.storage.local.remove(DEV_LEGACY_KEYS.cloudBook);
    return true;
  }
  const legacy = all as LegacyStorage;
  if (!hasLegacyData(legacy)) {
    // 全新安装写默认设置时保持 updatedAt=0：新设备首次 storage.sync 拉取时远端设置必然胜出，不会被默认值覆盖
    await saveSettings(createDefaultSettings(), { keepUpdatedAt: true });
    return false;
  }
  await writeMigration(migrateLegacy(legacy));
  await browser.storage.local.remove([...LEGACY_KEYS]);
  return true;
}
