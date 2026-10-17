import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import { STORAGE_KEYS } from '@/core/storage/keys';

/**
 * 升级后首次打开选项页时显示的“更新说明”：只写与旧版或直觉不同的行为，每条一句话，并给出去设置的位置。
 * 内容变化时递增 RELEASE_NOTES_VERSION，已读版本存在 storage.local `uiNotesSeen`，与当前版本相等才算已读（不是“不低于”，版本只递增；自动化脚本要跳过弹窗时写入当前版本号）。
 */
export const RELEASE_NOTES_VERSION = '3.1.0';

export interface ReleaseNote {
  title: string;
  body: string;
  /** 选项页 hash 路由（页面/锚点） */
  link?: { page: string; anchor?: string; label: string };
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    title: '阅读标记更集中于正文',
    body: '原文阅读与生词高亮可独立设置范围，分别跳过短文本、独立链接、辅助信息、标题、表格、按钮和导航；生词过滤默认关闭。正文行内链接保留标记，修复复合词连接符后部分漏标。',
    link: { page: 'reading', anchor: 'reading-scope', label: '去设置' },
  },
  {
    title: '新增原文阅读',
    body: '词首加粗、11 类词性与 4 类语义线索均在本地分析。81 套标记主题可选，开关、样式和颜色统一配置，自定义后切换预设仍可恢复。默认关闭，可按需开启。',
    link: { page: 'reading', label: '去设置' },
  },
  {
    title: '阅读样式与生词释义可以搭配',
    body: '可选择阅读或生词样式优先；仅显示译文时也能保留阅读标记。选中短语可查看内置词典释义，不需要翻译接口。',
    link: { page: 'reading', label: '查看' },
  },
  {
    title: '文章和评论的阅读标记更完整',
    body: '补充 YouTube 描述与动态评论、Medium 响应正文和表格的阅读标记，修复姓名紧接引号时首词漏标，并改进 someone、there、what 等词的本地词性分类。',
    link: { page: 'reading', label: '查看' },
  },
  {
    title: '长文滚动性能优化',
    body: '扩大正文与内层表格的预读范围，连续滚动期间分批补标，优先处理可见文字；保留近期标记，减少来回滚动的重复等待。',
    link: { page: 'reading', label: '查看' },
  },
  {
    title: '按网站控制阅读辅助',
    body: '黑白名单支持域名、通配符和受限正则。原文阅读可单独配置，未配置时继承全局规则；更多设置分组默认收起。',
    link: { page: 'sites', label: '去设置' },
  },
  {
    title: '任意词书都能作熟词本',
    body: '词书页每本书有“生词”“熟词”两个按钮：学过的考试书点“熟词”，其中的词不再高亮。难度/词频分级点“熟词”表示“低于该档”的词都已掌握，可与生词档同时选；计算机三档也可生词、熟词各选一档。组标题“全选”会跳过作熟词本的书。',
    link: { page: 'books', anchor: 'cat-exam', label: '去设置' },
  },
  {
    title: '新增通用核心词与专业领域词书',
    body: 'NGSL 通用核心词、口语核心词，以及学术科研、商务、职场、医学、计算机等领域词表；词书页顶部可搜索、按用法筛选，分组可折叠。',
    link: { page: 'books', anchor: 'cat-core', label: '查看' },
  },
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
