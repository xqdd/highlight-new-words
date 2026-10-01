import { browser } from 'wxt/browser';
import { getProviderInfo } from '../source/providers';
import type { CredentialId, Settings } from '../settings/schema';
import { getSettings, saveSettings } from '../settings/store';
import { STORAGE_KEYS } from '../storage/keys';
import { withStorageLock } from '../storage/lock';
import { stableStringify } from './codec';

/**
 * 凭据随同步上传（追加需求 v4 第 12 条）。
 *
 * - 凭据默认不上传；用户在 options 按凭据逐项勾选 `settings.credentialSync[id]`（该开关本身参与设置同步，各设备一致）。
 * - 同步后端自身的凭据不写进它自己的数据：WebDAV 连接信息（含密码）只会随 chrome.storage.sync 或手动备份上传，
 *   永远不会写到 WebDAV 上（见 credentialsFor 的 exclude）。
 * - 凭据段 `cred` = { [id]: { v: 值, at: 本机最近修改时间 } }，合并规则见 mergeRemoteCredentials：
 *   本机为空、或远端修改时间更新时采用远端值；本机未勾选的凭据一律不采用。
 * - 修改时间戳存在 storage.local `syncCredStamps`（{ at, h 值摘要 }），由 background 在 settings 变化时维护（watchCredentialChanges）。
 *   拉取采用远端值时先写戳（h=远端值摘要），随后 settings 变化不会被误判为本机修改。
 */

/** 凭据段中的一项 */
export interface CredentialEntry {
  v: unknown;
  at: number;
}
export type CredentialBundle = Record<CredentialId, CredentialEntry>;

/** WebDAV 连接信息凭据的值（启用开关、自动同步等不随凭据上传） */
export interface WebDavCredential {
  url: string;
  username: string;
  password: string;
  dir: string;
}

export const WEBDAV_CREDENTIAL_ID = 'webdav';
export const tokenCredentialId = (providerId: string): CredentialId => `token:${providerId}`;

/** options 渲染“随同步上传”勾选项用的说明 */
export interface SyncCredentialInfo {
  id: CredentialId;
  /** 显示名，如“欧路 OpenAPI token” */
  label: string;
  /** 本机是否已填写 */
  present: boolean;
  /** 是否勾选随同步上传 */
  upload: boolean;
  /** 勾选时的风险说明 */
  risk: string;
  /** 不会上传到的后端（避免循环依赖：WebDAV 密码不会写到 WebDAV 自身） */
  excludedBackends: ('storage-sync' | 'webdav')[];
}

/** 本机全部可上传凭据：每个声明了 apiToken 能力的来源 + WebDAV 连接信息 */
export function listSyncCredentials(settings: Settings): SyncCredentialInfo[] {
  const out: SyncCredentialInfo[] = [];
  for (const [pid, src] of Object.entries(settings.sources)) {
    const info = getProviderInfo(pid);
    if (!info?.capabilities.apiToken) continue;
    const id = tokenCredentialId(pid);
    out.push({
      id,
      label: `${info.name} API token`,
      present: !!src.apiToken,
      upload: !!settings.credentialSync[id],
      risk: 'token 会以可还原的形式存进你的浏览器账号同步数据（chrome.storage.sync）和 WebDAV 服务器上的同步文件；拿到这些数据的人可以读写你的生词本。',
      excludedBackends: [],
    });
  }
  const dav = settings.sync.webdav;
  out.push({
    id: WEBDAV_CREDENTIAL_ID,
    label: 'WebDAV 连接信息（地址、用户名、密码）',
    present: !!(dav.url && dav.password),
    upload: !!settings.credentialSync[WEBDAV_CREDENTIAL_ID],
    risk: '密码会存进你的浏览器账号同步数据（chrome.storage.sync），其他登录同一浏览器账号的设备会自动填入；不会写到 WebDAV 服务器本身。',
    excludedBackends: ['webdav'],
  });
  return out;
}

/** 读取本机凭据值；未填写时返回 undefined */
export function readCredential(settings: Settings, id: CredentialId): unknown {
  if (id === WEBDAV_CREDENTIAL_ID) {
    // 来自 storage.onChanged 的旧设置可能是升级前结构（没有 webdav），不能假设字段存在
    const dav = settings.sync?.webdav;
    if (!dav) return undefined;
    const { url, username, password, dir } = dav;
    return url && password ? ({ url, username, password, dir } satisfies WebDavCredential) : undefined;
  }
  if (id.startsWith('token:')) return settings.sources[id.slice(6)]?.apiToken || undefined;
  return undefined;
}

/** 把凭据值写入设置对象（就地修改）；不认识的 id 忽略 */
function writeCredential(settings: Settings, id: CredentialId, value: unknown): void {
  if (id === WEBDAV_CREDENTIAL_ID) {
    const v = value as Partial<WebDavCredential>;
    Object.assign(settings.sync.webdav, { url: v.url ?? '', username: v.username ?? '', password: v.password ?? '', dir: v.dir ?? settings.sync.webdav.dir });
  } else if (id.startsWith('token:')) {
    const src = settings.sources[id.slice(6)];
    if (src && typeof value === 'string') src.apiToken = value;
  }
}

/** 值摘要（FNV-1a 32 位，只用于判断值是否变化，不用于安全目的） */
export function credentialDigest(value: unknown): string {
  const s = stableStringify(value ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

type Stamps = Record<CredentialId, { at: number; h: string }>;

async function getStamps(): Promise<Stamps> {
  return ((await browser.storage.local.get(STORAGE_KEYS.syncCredStamps))[STORAGE_KEYS.syncCredStamps] as Stamps | undefined) ?? {};
}

function updateStamps(mutate: (s: Stamps) => void): Promise<void> {
  return withStorageLock(STORAGE_KEYS.syncCredStamps, async () => {
    const s = await getStamps();
    mutate(s);
    await browser.storage.local.set({ [STORAGE_KEYS.syncCredStamps]: s });
  });
}

/**
 * 某后端要上传的凭据：勾选了上传、本机已填写、且不是该后端自身的凭据。
 * 时间戳缺失（升级前就填好的凭据）时记 1：任何真实修改都比它新。
 */
export async function credentialsFor(settings: Settings, backend: 'storage-sync' | 'webdav' | 'backup'): Promise<CredentialBundle> {
  const stamps = await getStamps();
  const out: CredentialBundle = {};
  for (const info of listSyncCredentials(settings)) {
    if (!info.upload || (backend !== 'backup' && info.excludedBackends.includes(backend))) continue;
    const v = readCredential(settings, info.id);
    if (v === undefined) continue;
    const stamp = stamps[info.id];
    out[info.id] = { v, at: stamp && stamp.h === credentialDigest(v) ? stamp.at : 1 };
  }
  return out;
}

/**
 * 把远端凭据合并进本机（只处理本机勾选上传的凭据）：本机为空或远端修改时间更新且值不同 -> 采用远端值。
 * 返回采用的凭据 id；有变化时写设置（不刷新 updatedAt：凭据不参与设置 LWW，避免两台设备互相覆盖设置）。
 */
export async function mergeRemoteCredentials(remote: CredentialBundle, opts: { dryRun?: boolean } = {}): Promise<CredentialId[]> {
  const settings = await getSettings();
  const stamps = await getStamps();
  const applied: CredentialId[] = [];
  for (const [id, entry] of Object.entries(remote)) {
    if (!settings.credentialSync[id] || !entry || entry.v === undefined) continue;
    const local = readCredential(settings, id);
    const localAt = local === undefined ? -1 : stamps[id]?.h === credentialDigest(local) ? stamps[id]!.at : 1;
    if (local !== undefined && (entry.at <= localAt || credentialDigest(local) === credentialDigest(entry.v))) continue;
    writeCredential(settings, id, entry.v);
    applied.push(id);
  }
  if (applied.length && !opts.dryRun) {
    // 先写戳再写设置：watchCredentialChanges 看到值摘要与戳一致，不会把它当作本机修改
    await updateStamps((s) => {
      for (const id of applied) s[id] = { at: remote[id]!.at, h: credentialDigest(remote[id]!.v) };
    });
    await saveSettings(settings, { keepUpdatedAt: true });
  }
  return applied;
}

/**
 * background 启动时注册：settings 中凭据值变化（用户在 options 修改 token / WebDAV 密码）时记录修改时间。
 * 必须在 SW 启动同步阶段调用（监听器注册规则）。
 */
export function watchCredentialChanges(): void {
  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[STORAGE_KEYS.settings];
    if (area !== 'local' || !change?.newValue) return;
    void stampChangedCredentials(change.oldValue as Settings | undefined, change.newValue as Settings);
  });
}

/** 比较新旧设置中的凭据值，变化的记录修改时间（导出供单测） */
export async function stampChangedCredentials(prev: Settings | undefined, next: Settings): Promise<void> {
  const ids = new Set([WEBDAV_CREDENTIAL_ID, ...Object.keys(next.sources ?? {}).map(tokenCredentialId)]);
  const changed: { id: CredentialId; h: string }[] = [];
  for (const id of ids) {
    const before = prev?.sources ? readCredential(prev, id) : undefined;
    const after = next.sources ? readCredential(next, id) : undefined;
    if (after !== undefined && credentialDigest(before) !== credentialDigest(after)) changed.push({ id, h: credentialDigest(after) });
  }
  if (!changed.length) return;
  const now = Date.now();
  await updateStamps((s) => {
    for (const c of changed) if (s[c.id]?.h !== c.h) s[c.id] = { at: now, h: c.h };
  });
}
