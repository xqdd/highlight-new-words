import { effectiveBookRole } from '@/core/known/sources';
import { LOCAL_KNOWN_BOOK_ID, MY_WORDS_BOOK_ID, type BookId, type BookRole, type Settings } from '@/core/settings/schema';
import { getProviderInfo } from '@/core/source/providers';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';

/**
 * “加入生词本 / 认识”目标配置（settings.wordActions）与来源熟词本的选项计算，纯函数便于单测。
 *
 * 选项来自三类：本地词书（local:…，含尚未创建的“我的生词本”）、来源词书（src:…，按生效角色分生词本/熟词本）、
 * 本地熟词本（known:local，虚拟 id）。来源词书能否写入/删除看 SourceBookState.canAdd/canDelete（provider 声明），
 * 不支持的项仍列出但置灰并给出原因（追加需求“行为说明”：欧路“已掌握”只读要置灰并注明）。
 */

export interface TargetOption {
  id: BookId;
  name: string;
  /** 归属说明，如“本地”“欧路词典” */
  group: string;
  disabled: boolean;
  /** 置灰原因或补充说明 */
  note?: string;
}

function providerName(providerId: string): string {
  return getProviderInfo(providerId)?.name ?? providerId;
}

/** 来源词书是否能删词（与 background canDeleteFrom 一致：未孤立且未声明不可删，且 provider 支持删除） */
export function canDeleteSourceBook(state: SourceBookState): boolean {
  if (state.orphaned || state.canDelete === false) return false;
  return getProviderInfo(state.providerId)?.capabilities.delete ?? false;
}

/** 来源词书是否能加词 */
export function canAddSourceBook(state: SourceBookState): boolean {
  return !!state.canAdd && !state.orphaned;
}

/** 所属来源已关闭时的说明（写入类 / 移除类目标） */
export const SOURCE_OFF_WRITE_NOTE = '来源已关闭，不会写入';
export const SOURCE_OFF_REMOVE_NOTE = '来源已关闭，不会从中移除';

/**
 * 来源词书的一个选项。所属来源关闭（settings.sources[id].enabled=false）时优先置灰并注明“来源已关闭”：
 * 关闭来源后 sourceBooks 索引仍保留缓存分组，不提示的话用户会以为仍会写入（#52）。已勾选的项由 TargetChecklist 保留勾选、可取消。
 */
function sourceOption(settings: Settings, state: SourceBookState, ok: boolean, fallbackReason: string, offNote: string): TargetOption {
  const sourceOff = !settings.sources[state.providerId]?.enabled;
  const usable = ok && !sourceOff;
  return {
    id: state.id,
    name: state.name,
    group: providerName(state.providerId),
    disabled: !usable,
    note: usable ? undefined : sourceOff ? offNote : state.orphaned ? '远端已删除这个分组' : (state.readOnlyReason ?? fallbackReason),
  };
}

const LOCAL_KNOWN_OPTION: TargetOption = { id: LOCAL_KNOWN_BOOK_ID, name: '本地熟词本', group: '本地', disabled: false, note: '随浏览器账号 / WebDAV 同步' };

/** 本地词书选项；“我的生词本”不存在时也列出（background 首次加入时自动创建） */
function localBookOptions(books: BookMeta[]): TargetOption[] {
  const locals = books.filter((b) => b.kind === 'local').map((b) => ({ id: b.id, name: b.name, group: '本地', disabled: false }) as TargetOption);
  if (!locals.some((o) => o.id === MY_WORDS_BOOK_ID)) {
    locals.unshift({ id: MY_WORDS_BOOK_ID, name: '我的生词本', group: '本地', disabled: false, note: '首次加入单词时自动创建' });
  }
  return locals;
}

function sourcesByRole(settings: Settings, states: SourceBookState[], role: BookRole): SourceBookState[] {
  return states.filter((s) => effectiveBookRole(s, settings) === role);
}

/** 四组目标的可选项 */
export function wordActionOptions(settings: Settings, books: BookMeta[], states: SourceBookState[]) {
  const newBooks = sourcesByRole(settings, states, 'new');
  const knownBooks = sourcesByRole(settings, states, 'known');
  return {
    /** 加入生词本：写入哪些生词本 */
    addTargets: [...localBookOptions(books), ...newBooks.map((s) => sourceOption(settings, s, canAddSourceBook(s), '该来源不支持加词', SOURCE_OFF_WRITE_NOTE))],
    /** 加入生词本时：从哪些熟词本移除 */
    addRemoveFromKnown: [
      LOCAL_KNOWN_OPTION,
      ...knownBooks.map((s) => sourceOption(settings, s, canDeleteSourceBook(s), '该熟词本只读，不能移除单词', SOURCE_OFF_REMOVE_NOTE)),
    ],
    /** 认识：写入哪些熟词本 */
    knownTargets: [LOCAL_KNOWN_OPTION, ...knownBooks.map((s) => sourceOption(settings, s, canAddSourceBook(s), '该熟词本只读，不能写入', SOURCE_OFF_WRITE_NOTE))],
    /** 认识时：从哪些生词本移除 */
    knownRemoveFrom: [...localBookOptions(books), ...newBooks.map((s) => sourceOption(settings, s, canDeleteSourceBook(s), '该来源不支持删词', SOURCE_OFF_REMOVE_NOTE))],
  };
}

/**
 * knownRemoveFrom='auto' 时实际生效的移除目标（与 background known.ts 的解析一致，仅用于 UI 展示与“改为自定义”时的初始值）：
 * “加入生词本”的本地目标 + 启用且开启 deleteOnKnown 的来源中可删除的生词本。
 */
export function resolveAutoKnownRemoveFrom(settings: Settings, states: SourceBookState[]): BookId[] {
  const locals = settings.wordActions.addTargets.filter((id) => id.startsWith('local:'));
  const sources = states
    .filter((s) => {
      const src = settings.sources[s.providerId];
      return !!src?.enabled && src.deleteOnKnown && canDeleteSourceBook(s) && effectiveBookRole(s, settings) === 'new';
    })
    .map((s) => s.id);
  return [...new Set([...locals, ...sources])];
}

/** 勾选/取消某个目标（保持原有顺序，新项追加在末尾） */
export function toggleTarget(list: BookId[], id: BookId, on: boolean): BookId[] {
  const rest = list.filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

/**
 * 设置来源词书的角色（用户覆盖 provider 声明）：
 * - 与 provider 声明相同则删除覆盖项；
 * - 改为熟词本时从高亮词书中移除、加入 knownBooks.enabled；改回生词本时反之：移出熟词本、重新加入高亮词书（不重复）
 *   （保持“熟词本绝不进高亮词书”，也避免改回后既不高亮也不算熟词）。
 * - 另一角色才有意义的单词操作目标会被移除，返回被移除的目标名称（如“加入生词本时写入”），由界面在提示中说明，
 *   不自动恢复：用户改回用途后按提示去“单词操作”重新勾选。
 */
export function setSourceBookRole(settings: Settings, state: SourceBookState, role: BookRole): { removedTargets: string[] } {
  const roles = { ...settings.knownBooks.roles };
  if ((state.role ?? 'new') === role) delete roles[state.id];
  else roles[state.id] = role;
  settings.knownBooks.roles = roles;
  // 角色变化后，从另一角色才有意义的单词操作目标中移除该书（如改为熟词本后不再作为“加入生词本”的目标）
  const wa = settings.wordActions;
  const removedTargets: string[] = [];
  const drop = (list: BookId[], label: string) => {
    if (!list.includes(state.id)) return list;
    removedTargets.push(label);
    return list.filter((id) => id !== state.id);
  };
  if (role === 'known') {
    wa.addTargets = drop(wa.addTargets, '加入生词本时写入');
    if (Array.isArray(wa.knownRemoveFrom)) wa.knownRemoveFrom = drop(wa.knownRemoveFrom, '标记熟词时移除');
    settings.books.enabled = settings.books.enabled.filter((id) => id !== state.id);
    if (!settings.knownBooks.enabled.includes(state.id)) settings.knownBooks.enabled = [...settings.knownBooks.enabled, state.id];
  } else {
    wa.knownTargets = drop(wa.knownTargets, '标记熟词时写入');
    wa.addRemoveFromKnown = drop(wa.addRemoveFromKnown, '加入生词本时从熟词本移除');
    settings.knownBooks.enabled = settings.knownBooks.enabled.filter((id) => id !== state.id);
    if (!settings.books.enabled.includes(state.id)) settings.books.enabled = [...settings.books.enabled, state.id];
  }
  return { removedTargets };
}

/** 启用/停用来源熟词本 */
export function toggleSourceKnownBook(settings: Settings, id: BookId, on: boolean) {
  settings.knownBooks.enabled = toggleTarget(settings.knownBooks.enabled, id, on);
}
