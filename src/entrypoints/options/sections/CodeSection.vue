<script setup lang="ts">
import SegmentedControl from '@/ui/components/SegmentedControl.vue';
import SettingRow from '@/ui/components/SettingRow.vue';
import SettingsSection from '@/ui/components/SettingsSection.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';
import { useOptions } from '../lib/context';

/**
 * 代码块中标注生词（v8，settings.code，实现见 engine）：默认关闭。
 * 子选项：范围（仅注释和字符串 / 全部）、译文显示（仅悬停看卡片 / 上方浮动小标注）。
 * 与正文不同的行为用一句话说明：代码里不插入占位译文、复制不带标注、编程常用词不高亮、在线编辑器始终跳过。
 */
const { settings } = useOptions();
</script>

<template>
  <SettingsSection id="code" title="代码中的生词" description="技术文档、GitHub 等页面里的代码块与行内代码">
    <ToggleSwitch v-model="settings.code.enabled" label="在代码中标注生词" description="默认关闭。在线编辑器（VS Code 网页版、CodeMirror 等）始终不处理" />
    <template v-if="settings.code.enabled">
      <SettingRow label="范围" :description="settings.code.scope === 'comments' ? '按语法高亮识别注释和字符串，识别不了的代码块和行内代码不处理' : '代码中的所有文字，变量名会按 camelCase、snake_case 拆成单词再匹配'" stack>
        <SegmentedControl
          v-model="settings.code.scope"
          :options="[
            { value: 'comments', label: '仅注释和字符串' },
            { value: 'all', label: '全部' },
          ]"
        />
      </SettingRow>
      <SettingRow label="代码中的译文" :description="settings.code.display === 'hover' ? '代码里不显示译文，悬停或点按生词看卡片' : '在生词上方浮出小字译文，不占位置、不影响对齐，但会遮挡上一行代码'" stack>
        <SegmentedControl
          v-model="settings.code.display"
          :options="[
            { value: 'hover', label: '仅悬停 / 卡片' },
            { value: 'float', label: '上方小标注' },
          ]"
        />
      </SettingRow>
      <ul class="notes muted">
        <li>代码里不会插入括号或注音式译文，缩进、对齐保持不变，复制代码也不会带出任何标注。</li>
        <li>if、return、const、args、init 这类编程常用词视为熟词，不会高亮。</li>
      </ul>
    </template>
  </SettingsSection>
</template>

<style scoped>
.notes { margin: 0; padding: 8px 12px 8px 26px; border-radius: 10px; background: var(--surface-2); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
</style>
