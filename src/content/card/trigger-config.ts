import type { CardModifierKey, CardTrigger } from '@/core/settings/schema';

/**
 * 卡片触发方式的纯函数（无 DOM 依赖）：PC 端生效方式解析、修饰键文案、首次提示文案。
 * 供 card/trigger.ts 使用，options（设置 UI）与 floatball（YouTube）可直接 import 复用同一套文案与判断。
 */

/** PC 端（鼠标）实际生效的触发方式：auto 与 hover 同为悬停 */
export type DesktopCardTrigger = 'hover' | 'modifier' | 'click';

/** 卡片设置中与触发相关的部分（Settings['card'] 的子集；modifier 可缺省，按 alt 处理） */
export interface CardTriggerConfig {
  trigger: CardTrigger;
  modifier?: CardModifierKey;
}

/** 解析后的 PC 端触发配置 */
export interface ResolvedCardTrigger {
  mode: DesktopCardTrigger;
  /** mode='modifier' 时按住的键（已按平台换算，见 effectiveModifier） */
  modifier: CardModifierKey;
}

/** 当前是否 macOS（决定修饰键显示 ⌘⌥⇧⌃ 以及“新标签打开链接”的键是 ⌘ 还是 Ctrl） */
export function isMacPlatform(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  const uaPlatform = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /mac/i.test(uaPlatform || nav.platform || '');
}

/** 本平台可选的修饰键（options 设置 UI 用）：macOS 为 ⌘⌥⇧⌃，其他系统为 Alt / Ctrl / Shift（Win 键会弹出开始菜单，不提供） */
export function modifierChoices(mac: boolean): CardModifierKey[] {
  return mac ? ['meta', 'alt', 'shift', 'ctrl'] : ['alt', 'ctrl', 'shift'];
}

/**
 * 本平台实际使用的修饰键：非 macOS 收到 meta（多为 macOS 设备同步过来的设置）时按 Ctrl 处理（⌘ 在 Windows/Linux 上的对应键）。
 */
export function effectiveModifier(modifier: CardModifierKey | undefined, mac: boolean): CardModifierKey {
  const m = modifier ?? 'alt';
  return !mac && m === 'meta' ? 'ctrl' : m;
}

/** 修饰键显示名：macOS 用符号 + 名称（⌥ Option），其他系统用 Alt / Ctrl / Shift */
export function modifierLabel(modifier: CardModifierKey, mac: boolean): string {
  if (mac) return { meta: '⌘ Command', alt: '⌥ Option', shift: '⇧ Shift', ctrl: '⌃ Control' }[modifier];
  return { meta: 'Win', alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl' }[modifier];
}

/** 修饰键短名（提示文案中用）：macOS 用符号，其他系统用 Alt / Ctrl / Shift */
export function modifierShort(modifier: CardModifierKey, mac: boolean): string {
  if (mac) return { meta: '⌘', alt: '⌥', shift: '⇧', ctrl: '⌃' }[modifier];
  return modifierLabel(modifier, mac);
}

/** 解析 PC 端生效的触发方式 */
export function resolveCardTrigger(card: CardTriggerConfig, mac: boolean): ResolvedCardTrigger {
  const mode: DesktopCardTrigger = card.trigger === 'click' ? 'click' : card.trigger === 'modifier' ? 'modifier' : 'hover';
  return { mode, modifier: effectiveModifier(card.modifier, mac) };
}

/** 触发方式签名（存于 storage.local `cardTriggerHint`）：方式或修饰键变化后重新提示一次 */
export function triggerSignature(t: ResolvedCardTrigger): string {
  return t.mode === 'modifier' ? `modifier:${t.modifier}` : t.mode;
}

/** 卡片首次出现时的一行提示（只在 PC 端鼠标打开时显示，控制在两行内） */
export function cardTriggerHintText(t: ResolvedCardTrigger, mac: boolean): string {
  if (t.mode === 'click') return `点击单词显示卡片；链接需再点一次或 ${mac ? '⌘' : 'Ctrl'}+点击才打开。设置中可更改`;
  if (t.mode === 'modifier') return `按住 ${modifierShort(t.modifier, mac)} 指向单词才显示卡片。设置中可更改`;
  return '指向单词即显示卡片；设置中可改为按住修饰键或点击';
}

/** 触发方式的一句话说明（options 设置行描述可复用） */
export function cardTriggerDescription(t: ResolvedCardTrigger, mac: boolean): string {
  if (t.mode === 'click') return `点击单词显示卡片；链接里的单词再点一次或按住 ${mac ? '⌘' : 'Ctrl'} 点击才打开链接`;
  if (t.mode === 'modifier') return `按住 ${modifierShort(t.modifier, mac)} 并指向单词显示卡片；按下修饰键时指针已在单词上也会显示`;
  return '指向单词稍停即显示卡片';
}
