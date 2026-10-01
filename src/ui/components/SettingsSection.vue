<script setup lang="ts">
/**
 * 设置分组卡片：标题（左侧强调色竖条，参照 Relingo 分组标题）+ 说明 + 右上角操作区（actions 插槽）。
 * flush=true 时内容区去掉内边距，用于整行可点的列表（SettingRow / 词书列表）。
 */
defineProps<{ title: string; description?: string; id?: string; flush?: boolean }>();
</script>

<template>
  <section :id="id" class="section" :class="{ flush }">
    <header>
      <div class="titles">
        <h2>{{ title }}</h2>
        <p v-if="description" class="muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
    </header>
    <div class="body"><slot /></div>
  </section>
</template>

<style scoped>
.section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg, 16px); padding: 16px 18px;
  box-shadow: var(--shadow); scroll-margin-top: 72px; }
header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.titles { flex: 1; min-width: 0; }
h2 { position: relative; font-size: 16px; margin: 0; font-weight: 650; padding-left: 12px; }
h2::before { content: ''; position: absolute; left: 0; top: .2em; bottom: .2em; width: 4px; border-radius: 2px; background: var(--accent); }
header p { margin: 4px 0 0 12px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.body { display: flex; flex-direction: column; gap: 12px; }
.flush { padding: 16px 0 6px; }
.flush header { padding: 0 18px; }
.flush .body { gap: 0; }
@media (max-width: 480px) {
  .section { padding: 14px; border-radius: 14px; }
  .flush { padding: 14px 0 4px; }
  .flush header { padding: 0 14px; }
}
</style>
