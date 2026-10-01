import { browser } from 'wxt/browser';
import { sendToTab } from '@/core/messaging';
import type { Lemmatizer } from '@/core/lemma/types';
import { getTabWords } from './badge';
import { badgeText } from './badge';
import { addWord, getLemmatizer, markKnown } from './known';

/**
 * 选中文本右键菜单（追加需求 v3 第 7 条“选中文本/右键菜单，可选”）：
 * “加入生词本：“%s”” 与 “标记为熟词：“%s””，按 settings.wordActions 的目标配置执行（与卡片按钮同一套逻辑）。
 *
 * - 只在有 contextMenus API 的浏览器启用（Edge/Chrome Android 没有右键菜单，API 不存在时整块跳过）
 * - 结果反馈：发 ContentProtocol.actionNotice 给被点的 frame（内容脚本可用 toast 展示，未实现时忽略），
 *   同时在该标签页徽章上闪一下 ✓ / !（2.5 秒后恢复高亮计数）
 * - markKnown 不带 confirmed：同形异义词形的远端删除不会执行（结果 message 中会说明），与卡片未确认时一致
 */

export const MENU_ADD = 'hnw-add-word';
export const MENU_KNOWN = 'hnw-mark-known';

/** 去掉首尾非字母（按 Unicode 字母判断，café 结尾的 é 不会被截掉成 caf） */
function trimSelection(text: string | undefined): string {
  return (text ?? '').trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/’/g, "'");
}

/** 选中文本 → 单个英文单词（去掉首尾标点/空白）；不是单个单词或含非英文字母（café、fiancé）时返回 undefined */
export function selectionToWord(text: string | undefined): string | undefined {
  const t = trimSelection(text);
  if (!t || t.length > 45) return undefined;
  return /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(t) ? t : undefined;
}

/** 页面词形 → 写入词书的原形：优先取屈折原形（running → run），不取派生词根（careless 仍是 careless） */
export function lemmaOf(word: string, lemmatizer: Lemmatizer): string {
  const a = lemmatizer.analyze?.(word);
  if (a) return a.inflections[0] ?? a.base;
  return lemmatizer.candidates(word)[1] ?? word.toLowerCase();
}

/** 创建菜单（先清空，避免 onInstalled/onStartup 重复创建报 duplicate id） */
async function createMenus(): Promise<void> {
  const menus = browser.contextMenus as typeof browser.contextMenus | undefined;
  if (!menus) return;
  await menus.removeAll();
  menus.create({ id: MENU_ADD, title: '加入生词本：“%s”', contexts: ['selection'] });
  menus.create({ id: MENU_KNOWN, title: '标记为熟词：“%s”', contexts: ['selection'] });
}

/** 徽章闪一下结果，2.5 秒后恢复该标签页的高亮计数 */
async function flashBadge(tabId: number, ok: boolean): Promise<void> {
  try {
    await browser.action.setBadgeText({ tabId, text: ok ? '✓' : '!' });
    setTimeout(() => {
      void getTabWords(tabId)
        .then((lemmas) => browser.action.setBadgeText({ tabId, text: badgeText(lemmas.length) }))
        .catch(() => {});
    }, 2500);
  } catch {
    // 标签页已关闭
  }
}

/** 执行菜单命令，返回结果（单测直接调用） */
export async function runMenuAction(
  action: 'add' | 'known',
  selection: string | undefined,
): Promise<{ ok: boolean; word: string; lemma: string; message: string }> {
  const word = selectionToWord(selection);
  if (!word) {
    const t = trimSelection(selection);
    // 带重音等非英文字母的拉丁词（café、naïve）：词库与原形还原都只覆盖英文字母，直接拒绝而不是截断后写入
    const message = /^[\p{Script=Latin}'-]+$/u.test(t) && /[^A-Za-z'-]/.test(t) ? `暂不支持含非英文字母的单词（${t}）` : '请只选中一个英文单词';
    return { ok: false, word: selection?.trim() ?? '', lemma: '', message };
  }
  const lemma = lemmaOf(word, await getLemmatizer());
  if (action === 'add') {
    const r = await addWord({ word, lemma });
    return { ok: r.ok, word, lemma, message: r.message };
  }
  const r = await markKnown(word, lemma);
  return { ok: r.ok, word, lemma, message: r.message };
}

/** 注册右键菜单（监听须在 SW 启动同步阶段注册；ready 为迁移完成的 Promise） */
export function setupContextMenus(ready: Promise<unknown>): void {
  // 移动端（Edge/Chrome Android）可能没有 contextMenus 或只有残缺对象：缺失时整块跳过，绝不能抛错拖垮 SW 其余初始化
  const menus = browser.contextMenus as typeof browser.contextMenus | undefined;
  if (!menus?.onClicked || typeof menus.create !== 'function') return;
  browser.runtime.onInstalled.addListener(() => void createMenus().catch((e) => console.warn('[hnw] 创建右键菜单失败', e)));
  browser.runtime.onStartup.addListener(() => void createMenus().catch(() => {}));
  menus.onClicked.addListener((info, tab) => {
    const action = info.menuItemId === MENU_ADD ? 'add' : info.menuItemId === MENU_KNOWN ? 'known' : undefined;
    if (!action) return;
    void (async () => {
      await ready;
      const res = await runMenuAction(action, info.selectionText).catch((e: unknown) => ({
        ok: false,
        word: info.selectionText ?? '',
        lemma: '',
        message: e instanceof Error ? e.message : String(e),
      }));
      if (tab?.id === undefined || tab.id < 0) return;
      await flashBadge(tab.id, res.ok);
      await sendToTab(tab.id, 'actionNotice', { action, ...res }, info.frameId ?? 0).catch(() => {});
    })();
  });
}
