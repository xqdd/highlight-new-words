<script setup lang="ts">
import BottomSheet from '@/ui/components/BottomSheet.vue';
import { useOptions } from '../lib/context';
import { RELEASE_NOTES, markReleaseNotesSeen } from '../lib/release-notes';

/** 更新说明弹层（升级后首次打开自动弹出；“更多”页可再次打开）。关闭即记为已读 */
const open = defineModel<boolean>('open', { required: true });
const { navigate } = useOptions();

function close() {
  open.value = false;
  void markReleaseNotesSeen();
}
function go(page: string, anchor?: string) {
  close();
  navigate(page, anchor);
}
</script>

<template>
  <BottomSheet :open="open" title="更新说明" description="这个版本中与之前不同的地方" @update:open="(v: boolean) => !v && close()">
    <ul class="notes">
      <li v-for="n in RELEASE_NOTES" :key="n.title">
        <strong>{{ n.title }}</strong>
        <span>{{ n.body }}</span>
        <button v-if="n.link" type="button" class="link" @click="go(n.link.page, n.link.anchor)">{{ n.link.label }} →</button>
      </li>
    </ul>
    <template #footer>
      <button type="button" class="btn primary" @click="close">知道了</button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.notes li { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); }
.notes span { color: var(--text-2); font-size: 13px; line-height: 1.55; }
.link { align-self: flex-start; border: 0; background: transparent; color: var(--accent); font-weight: 600; cursor: pointer; padding: 0; min-height: 32px; font-size: 13px; }
</style>
