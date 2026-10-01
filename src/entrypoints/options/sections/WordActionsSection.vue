<script setup lang="ts">
import { computed } from 'vue';
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import TargetChecklist from '../components/TargetChecklist.vue';
import { useOptions } from '../lib/context';
import { useSourceIndex } from '../lib/source-index';
import { resolveAutoKnownRemoveFrom, wordActionOptions } from '../lib/word-actions';

/**
 * 单词操作（卡片上的“加入生词本”和“认识”）的写入 / 移除目标（settings.wordActions，执行在 background/known.ts）：
 * - 加入生词本：写入哪些生词本（本地 / 可加词的来源分组），同时从哪些熟词本移除；
 * - 认识：写入哪些熟词本（本地 / 可写的来源熟词本），同时从哪些生词本移除（“自动”= 沿用各来源的“标记熟词时删除”开关）；
 * - 同原形处理：移除时是否连同 run/runs/ran/running 等屈折词形一起处理。
 * 只读或不支持的目标置灰并注明原因；远端失败、撤销边界等与直觉不同的行为在对应位置用一句话说明。
 */
const { settings, books } = useOptions();
const { states } = useSourceIndex();
const wa = computed(() => settings.value.wordActions);
const opts = computed(() => wordActionOptions(settings.value, books.value, states.value));

const removeMode = computed({
  get: () => (wa.value.knownRemoveFrom === 'auto' ? 'auto' : 'custom'),
  set: (m: 'auto' | 'custom') => {
    // 切到自定义时以“自动”当前实际生效的目标为初始值，用户只需增删
    settings.value.wordActions.knownRemoveFrom = m === 'auto' ? 'auto' : resolveAutoKnownRemoveFrom(settings.value, states.value);
  },
});
const autoTargets = computed(() => {
  const ids = new Set(resolveAutoKnownRemoveFrom(settings.value, states.value));
  return opts.value.knownRemoveFrom.filter((o) => ids.has(o.id));
});
const customRemove = computed({
  get: () => (Array.isArray(wa.value.knownRemoveFrom) ? wa.value.knownRemoveFrom : []),
  set: (v) => (settings.value.wordActions.knownRemoveFrom = v),
});
</script>

<template>
  <SettingsSection id="word-actions" title="单词操作" description="网页卡片上点“加入生词本”或“认识”时，写到哪里、从哪里移除">
    <ToggleSwitch
      v-model="settings.wordActions.sameLemma"
      label="同原形一起处理"
      description="移除时连同同一原形的各种变形（run、runs、ran、running）一起移除；不包括 runner、careful 这类派生词。关闭后只处理点到的词形和它的原形"
    />

    <div class="group">
      <h3>加入生词本</h3>
      <p class="muted">写入到（可多选）</p>
      <TargetChecklist v-model="settings.wordActions.addTargets" :options="opts.addTargets" label="加入生词本时写入" />
      <p class="muted">同时从这些熟词本移除</p>
      <TargetChecklist v-model="settings.wordActions.addRemoveFromKnown" :options="opts.addRemoveFromKnown" label="加入生词本时移出熟词本" />
      <p class="hint">写入远端生词本失败时，本地生词本照常加入，卡片上会提示哪一本没写成功。有道只能加到默认分组“无标签”。</p>
    </div>

    <div class="group">
      <h3>认识（标记熟词）</h3>
      <p class="muted">写入到（可多选）</p>
      <TargetChecklist v-model="settings.wordActions.knownTargets" :options="opts.knownTargets" label="认识时写入熟词本" />
      <p v-if="!settings.wordActions.knownTargets.length" class="hint warn">未选择任何熟词本时，仍会写入本地熟词本，保证这个词不再高亮。</p>
      <p class="muted">同时从这些生词本移除</p>
      <SegmentedControl
        v-model="removeMode"
        :options="[
          { value: 'auto', label: '跟随各来源开关' },
          { value: 'custom', label: '自定义' },
        ]"
      />
      <template v-if="removeMode === 'auto'">
        <p class="muted small">
          {{
            autoTargets.length
              ? '当前会移除：' + autoTargets.map((o) => o.name).join('、')
              : '当前不会从任何生词本移除。可在上方各来源打开“标记熟词时删除”，或改为自定义'
          }}
        </p>
      </template>
      <TargetChecklist v-else v-model="customRemove" :options="opts.knownRemoveFrom" label="认识时移出生词本" />
      <ul class="hint list">
        <li>远端删除失败时，本地缓存保留该词，下次同步也不会丢；失败原因会在卡片提示中说明。</li>
        <li>10 分钟内可以撤销：本地词书完整恢复；已从来源删除的词，能加词的分组会加回，不能加词的（如欧路网页登录模式）无法恢复。</li>
        <li>同形异义的不规则词形（如 found 也是 find 的过去式）从远端删除前会先让你确认。</li>
      </ul>
    </div>
  </SettingsSection>
</template>

<style scoped>
.group { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
h3 { margin: 0; font-size: 15px; }
.group > p { margin: 0; }
.small { font-size: 12px; }
.hint { margin: 0; font-size: 12px; color: var(--text-2); padding: 8px 12px; border-radius: 10px; background: var(--surface-2); }
.hint.warn { color: var(--warn); }
.hint.list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.hint.list li::before { content: '· '; }
</style>
