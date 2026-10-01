import { browser } from 'wxt/browser';
import { handleBackgroundMessages } from '@/core/messaging';
import { runMigrationIfNeeded } from '@/core/settings/store';
import { StorageSyncService } from '@/core/sync/service';
import { getTabWords, reportFrameWords, setupBadge } from './badge';
import { getLemmatizer, markKnown, unmarkKnown } from './known';
import { autoSyncIfDue, deleteFromSources, recoverInterruptedSyncs, refreshSourceBooks, syncSourceBooks } from './sources/service';
import { speak } from './tts';

/**
 * 后台（MV3 service worker）：迁移旧数据、来源生词本同步/删词、熟词、storage.sync 跨设备同步、TTS、徽章计数。
 * 注意：所有监听器必须在 SW 启动的同步阶段注册，否则被唤醒时会丢事件。
 *
 * 启动顺序：迁移 -> 复位被中断的来源同步 -> storage.sync 首次同步 -> 到期的来源自动同步。
 * SW 每次被唤醒都会走一遍（旧版 v2 也是在 SW 顶层检查自动同步），各步骤在条件不满足时不发请求。
 */
export function setupBackground(): void {
  const ready = runMigrationIfNeeded()
    .then((migrated) => migrated && console.log('[hnw] 已从旧版存储迁移'))
    .catch((e) => console.error('[hnw] 迁移失败', e))
    .then(() => recoverInterruptedSyncs())
    .catch((e) => console.error('[hnw] 复位同步状态失败', e));

  const sync = new StorageSyncService();

  handleBackgroundMessages({
    tts: ({ text, force }) => speak(text, force),
    refreshSourceBooks: async ({ providerId }) => {
      await ready;
      return refreshSourceBooks(providerId);
    },
    syncSourceBooks: async (data) => {
      await ready;
      return syncSourceBooks(data);
    },
    deleteSourceWords: async ({ word, bookIds, forms }) => {
      await ready;
      return deleteFromSources(word, { bookIds, forms: !!forms, lemmatizer: await getLemmatizer() });
    },
    markKnown: async ({ word, lemma }) => {
      await ready;
      return markKnown(word, lemma);
    },
    unmarkKnown: async ({ lemma }) => {
      await ready;
      return unmarkKnown(lemma);
    },
    getSyncStatus: () => sync.getStatus(),
    syncNow: async () => {
      await ready;
      return sync.syncNow();
    },
    reportPageWords: async ({ lemmas }, sender) => {
      if (sender.tab?.id !== undefined) await reportFrameWords(sender.tab.id, sender.frameId ?? 0, lemmas, sender.url);
    },
    getTabWords: async ({ tabId }) => ({ lemmas: await getTabWords(tabId) }),
  });

  setupBadge();
  // storage.sync 监听须同步注册；首次同步等迁移完成后再执行
  sync.listen();
  void ready.then(() => sync.syncNow());
  void ready.then(() => autoSyncIfDue()).catch((e) => console.warn('[hnw] 自动同步失败', e));

  // 安装/启动事件只用于唤醒 SW（唤醒后上面的启动流程已执行），这里无需重复同步
  browser.runtime.onStartup.addListener(() => {});
  browser.runtime.onInstalled.addListener(() => {});
}
