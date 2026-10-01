import type { CardHoverDelay, CardModifierKey } from '@/core/settings/schema';
import { modifierShort } from '@/content/card/trigger-config';

/**
 * 释义卡片“电脑上的打开方式”设置（CardTriggerSection）的文案与选项，纯函数便于单测。
 * 修饰键显示名复用 card 的 trigger-config（modifierShort），与卡片首次提示同一套写法。
 */

export type DesktopMode = 'hover' | 'modifier' | 'click';

/**
 * 三种方式的选项卡文案。副标题与具体修饰键无关（固定文案）：具体键只出现在下方的键选择区和说明里，
 * 否则切换修饰键时选项卡副标题跟着变，读起来像另一种方式（问题 f）。
 */
export const CARD_TRIGGER_MODES: readonly { value: DesktopMode; label: string; desc: string }[] = [
  { value: 'hover', label: '鼠标悬停', desc: '指针停在生词上片刻即弹出，默认方式' },
  { value: 'modifier', label: '按住修饰键 + 悬停', desc: '按住所选修饰键时才弹出，平时移动鼠标不打扰阅读' },
  { value: 'click', label: '点击', desc: '点一下生词才弹出，适合不想被悬停打断的场景' },
];

/** 悬停延迟三档（settings.card.hoverDelay，档位与 schema 的 CARD_HOVER_DELAYS 一致） */
export const HOVER_DELAY_OPTIONS: readonly { value: CardHoverDelay; label: string }[] = [
  { value: 100, label: '快 100ms' },
  { value: 250, label: '标准 250ms（默认）' },
  { value: 400, label: '慢 400ms' },
];

/** 悬停延迟只对“悬停”和“修饰键 + 悬停”（按着键移入单词）生效，点击方式不显示 */
export function showsHoverDelay(mode: DesktopMode): boolean {
  return mode !== 'click';
}

/**
 * 所选修饰键与浏览器常用操作的关系说明。查词只需“按住 + 悬停”、不必点击，所以每个键都提醒“不要点击”，并写明点击会触发什么：
 * - macOS ⌃+点击 = 右键菜单（新标签是 ⌘+点击），所以 mac 的 ctrl 单独给文案；
 * - Alt/⌥+点击链接在 Chrome 中会下载链接，不再标“推荐”；Win/Linux 单按 Alt 松开会聚焦浏览器菜单（查过词的那次按住由 card 拦下 keyup）；
 * - mac 的 Shift 用 ⇧ 显示。
 */
export function modifierKeyNote(k: CardModifierKey, mac: boolean): string {
  const key = modifierShort(k, mac);
  if (k === 'ctrl' && mac) return '⌃+点击会弹出右键菜单，查词只需按住 ⌃ 悬停、不要点击。';
  if (k === 'ctrl' || k === 'meta') return `${key}+点击链接会在新标签打开。查词只需按住 ${key} 悬停、不要点击，链接不受影响。`;
  if (k === 'shift') return `${key}+点击链接会在新窗口打开，拖选文字时按住 ${key} 会扩展选区；查词只需按住 ${key} 悬停、不要点击。`;
  const altNote = `按住 ${key} 悬停即可，不要点击（${key}+点击链接会下载）。`;
  return mac ? altNote : `${altNote}单按 Alt 不查词就松开，浏览器可能会聚焦菜单栏。`;
}

/** 悬停延迟的口语化时长，用于方式说明（250 → “0.25 秒”） */
export function delaySeconds(ms: number): string {
  return `${ms / 1000} 秒`;
}
