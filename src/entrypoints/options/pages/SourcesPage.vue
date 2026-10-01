<script setup lang="ts">
import LocalBooksSection from '../sections/LocalBooksSection.vue';
import SourcesSection from '../sections/SourcesSection.vue';
import WordActionsSection from '../sections/WordActionsSection.vue';

/** 生词本页：云端来源（有道/欧路，多生词本独立同步）+ 文件导入的本地词书 + 卡片“加入生词本 / 认识”的目标配置 */
</script>

<template>
  <SourcesSection />
  <LocalBooksSection />
  <WordActionsSection />
</template>
