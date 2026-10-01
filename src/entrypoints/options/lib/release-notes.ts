import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import { STORAGE_KEYS } from '@/core/storage/keys';

/**
 * 升级后首次打开选项页时显示的“更新说明”：只写与旧版或直觉不同的行为，每条一句话，并给出去设置的位置。
 * 内容变化时递增 RELEASE_NOTES_VERSION，已读版本存在 storage.local `uiNotesSeen`。
 */
export const RELEASE_NOTES_VERSION = '3.0';

export interface ReleaseNote {
  title: string;
  body: string;
  /** 选项页 hash 路由（页面/锚点） */
  link?: { page: string; anchor?: string; label: string };
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    title: '欧路词典改用 OpenAPI token',
    body: '填写 token 后可按分类同步、加词删词，并把“已掌握单词”作为熟词本。不填时仍按旧方式只同步“全部生词”。',
    link: { page: 'sources', anchor: 'providers', label: '去填写' },
  },
  {
    title: '熟词本可以有多个来源',
    body: '本地熟词本之外，欧路“已掌握单词”等远端分组也能作为熟词本。“已掌握单词”是只读的，点“认识”不会写入它。',
    link: { page: 'known', anchor: 'known-sources', label: '查看' },
  },
  {
    title: '加入生词本 / 认识 可以选目标',
    body: '默认加入“我的生词本”；可同时写入有道、欧路分组。认识时从来源删除失败，本地会保留；撤销不一定能恢复已从来源删除的词。',
    link: { page: 'sources', anchor: 'word-actions', label: '去设置' },
  },
  {
    title: '同步方式更多了',
    body: '新增 WebDAV（坚果云等）和手动备份。浏览器账号同步只有约 100 KB，放不下时词书先只同步单词，再跳过。token、密码默认不上传。',
    link: { page: 'sync', label: '去设置' },
  },
  {
    title: '高亮样式可以自由组合',
    body: '新增荧光笔、胶囊、虚线框、双下划线等预设，线型、文字、背景、边框可分别调整，每本词书也能用不同样式；行内译文可悬停显示或模糊自测。',
    link: { page: 'appearance', label: '去看看' },
  },
];

/**
 * 是否需要显示更新说明：
 * - background 在升级时写入的 `updateNotice` 存在 → 显示（最可靠的升级信号）；
 * - 否则未读当前版本、且不是全新安装（全新安装走 #welcome 引导，默认设置 updatedAt=0）→ 显示。
 */
export async function shouldShowReleaseNotes(settingsUpdatedAt: number, onWelcome: boolean): Promise<boolean> {
  const got = await browser.storage.local.get([STORAGE_KEYS.uiNotesSeen, STORAGE_KEYS.updateNotice]);
  if (got[STORAGE_KEYS.updateNotice] && !onWelcome) return true;
  if (got[STORAGE_KEYS.uiNotesSeen] === RELEASE_NOTES_VERSION) return false;
  if (onWelcome || settingsUpdatedAt === 0) {
    await markReleaseNotesSeen();
    return false;
  }
  return true;
}

/** 记为已读，并清除 background 的升级提示（popup 不再重复提示） */
export async function markReleaseNotesSeen(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.uiNotesSeen]: RELEASE_NOTES_VERSION });
  await sendToBackground('dismissUpdateNotice', {}).catch(() => undefined);
}
