<script setup lang="ts">
import type { ReadingSettings } from '@/core/reading/settings';
import SettingRow from '@/ui/components/SettingRow.vue';
import ToggleSwitch from '@/ui/components/ToggleSwitch.vue';

const scope = defineModel<ReadingSettings['scope']>({ required: true });
</script>

<template>
  <ToggleSwitch v-model="scope.skipShortBlocks" label="跳过短文本" />
  <SettingRow v-if="scope.skipShortBlocks" label="最少英文词数"><input v-model.number="scope.minWords" aria-label="最少英文词数" type="number" min="2" max="50" step="1" /></SettingRow>
  <ToggleSwitch v-model="scope.skipStandaloneLinks" label="跳过独立链接" />
  <ToggleSwitch v-model="scope.skipHeadings" label="跳过标题" />
  <ToggleSwitch v-model="scope.skipTables" label="跳过表格" />
  <ToggleSwitch v-model="scope.skipButtons" label="跳过按钮" />
  <ToggleSwitch v-model="scope.skipNavigation" label="跳过导航区域" />
  <ToggleSwitch v-model="scope.skipMetadata" label="跳过辅助信息" />
</template>
