<script setup lang="ts">
import { ref } from 'vue';
import { syncFixVerb, type SyncChannel } from '../model';
import PopupIcon from './PopupIcon.vue';

/**
 * 同步方式列表（同步卡片与“同步状态”底部面板共用）：每行一种方式 + 状态短句 + 操作。
 * 出错行按钮写具体修复动作（重新登录 / 检查服务器…）跳设置页；后台原始错误收在“详情”里，按需展开。
 */
defineProps<{ channels: SyncChannel[]; isBusy: (id: string) => boolean }>();
const emit = defineEmits<{ sync: [c: SyncChannel]; fix: [c: SyncChannel] }>();

const CHANNEL_ICON = { source: 'book', 'storage-sync': 'cloud', webdav: 'server' } as const;
/** 展开了原始错误的行 */
const openDetail = ref(new Set<string>());
function toggleDetail(id: string) {
  const next = new Set(openDetail.value);
  if (!next.delete(id)) next.add(id);
  openDetail.value = next;
}
</script>

<template>
  <ul class="sync-list">
    <li v-for="c in channels" :key="c.id" class="sync-row">
      <div class="sync-main">
        <PopupIcon :name="CHANNEL_ICON[c.kind]" class="sync-ic" />
        <span class="sync-text">
          <span class="sync-label">{{ c.label }}</span>
          <span class="sync-status" :class="`tone-${c.status.tone}`">
            {{ c.status.text }}<span v-if="c.since" class="since"> · {{ c.since }}</span>
            <button v-if="c.detail" type="button" class="detail-btn" :aria-expanded="openDetail.has(c.id)" @click="toggleDetail(c.id)">
              {{ openDetail.has(c.id) ? '收起' : '详情' }}
            </button>
          </span>
        </span>
        <button v-if="c.action === 'fix'" type="button" class="btn small fix" :class="{ warn: c.status.tone === 'warn', muted: c.status.tone === 'muted' }" @click="emit('fix', c)">
          {{ syncFixVerb(c) }}<PopupIcon name="chevron" :size="14" />
        </button>
        <button
          v-else
          type="button"
          class="btn small"
          :disabled="isBusy(c.id) || c.running"
          :aria-label="`立即同步${c.label}`"
          @click="emit('sync', c)"
        >
          <PopupIcon name="refresh" :size="14" :class="{ spin: isBusy(c.id) || c.running }" />同步
        </button>
      </div>
      <p v-if="c.detail && openDetail.has(c.id)" class="raw">{{ c.detail }}</p>
    </li>
  </ul>
</template>

<style scoped>
.sync-list { list-style: none; margin: 0; padding: 0; }
.sync-row { padding: 3px 0; }
.sync-row + .sync-row { border-top: 1px solid var(--border); }
.sync-main { display: flex; align-items: center; gap: 10px; min-height: 40px; }
.sync-ic { color: var(--text-2); flex: none; }
.sync-text { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
.sync-label { font-size: 13px; font-weight: 600; }
.sync-status { font-size: 12px; word-break: break-word; }
.sync-status.tone-ok, .sync-status.tone-muted { color: var(--text-2); }
.tone-warn { color: var(--warn); }
.tone-error { color: var(--danger); }
.tone-busy { color: var(--accent); }
.detail-btn {
  border: 0; background: none; padding: 0 2px; margin-left: 4px; font: inherit; font-size: 12px; color: var(--text-2);
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
.raw {
  margin: 2px 0 6px 28px; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--surface-2);
  font-size: 11.5px; line-height: 1.5; color: var(--text-2); word-break: break-all; user-select: text;
}
.btn.small { min-height: 30px; padding: 3px 10px; font-size: 12.5px; gap: 4px; flex: none; }
.btn.fix { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); font-weight: 650; gap: 0; }
/* 未登录等“待处理”（非故障）用警示色，不和真正的出错混在一起 */
.btn.fix.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 50%, var(--border)); }
/* 从未连接（新装默认启用有道但没登录）：中性引导，不是故障，用普通按钮的中性色而非红/橙 */
.btn.fix.muted { color: var(--text); border-color: var(--border); }
/* 上次成功时间：次要信息 */
.since { color: var(--text-2); }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* 触屏：点击区 ≥ 44px（popup 整页模式下 App 也会按 touchUi 兜底） */
@media (pointer: coarse) {
  .sync-main { min-height: 54px; }
  .sync-label { font-size: 14px; }
  .sync-status { font-size: 12.5px; }
  .btn.small { min-height: 38px; padding: 4px 12px; font-size: 13px; }
  .detail-btn { min-height: 32px; font-size: 12.5px; }
}
</style>
