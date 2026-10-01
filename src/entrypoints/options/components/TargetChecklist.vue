<script setup lang="ts">
import type { BookId } from '@/core/settings/schema';
import type { TargetOption } from '../lib/word-actions';
import { toggleTarget } from '../lib/word-actions';

/**
 * 目标多选清单（单词操作的写入 / 移除目标）：每项一行复选框 + 归属标签 + 说明。
 * 不支持的项（只读熟词本、不能加词的分组）置灰并显示原因，而不是隐藏，让用户知道为什么不能选。
 * 已选中但当前不可用的项（如分组被改为只读）仍显示为选中、可取消。
 */
const model = defineModel<BookId[]>({ required: true });
defineProps<{ options: TargetOption[]; label: string; disabled?: boolean }>();
</script>

<template>
  <ul class="targets" role="group" :aria-label="label">
    <li v-for="o in options" :key="o.id" :class="{ off: o.disabled }">
      <label>
        <input
          type="checkbox"
          :checked="model.includes(o.id)"
          :disabled="disabled || (o.disabled && !model.includes(o.id))"
          @change="model = toggleTarget(model, o.id, ($event.target as HTMLInputElement).checked)"
        />
        <span class="t">
          <span class="name">{{ o.name }}<span class="group">{{ o.group }}</span></span>
          <span v-if="o.note" class="note">{{ o.note }}</span>
        </span>
      </label>
    </li>
  </ul>
</template>

<style scoped>
.targets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
li + li { border-top: 1px solid var(--border); }
label { display: flex; align-items: center; gap: 12px; min-height: var(--tap); padding: 8px 12px; cursor: pointer; }
input { width: 18px; height: 18px; accent-color: var(--accent); flex: none; margin: 0; }
.t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 550; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.group { font-size: 11px; font-weight: 600; padding: 0 7px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.note { font-size: 12px; color: var(--text-2); }
li.off label { cursor: default; }
li.off .name { color: var(--text-2); }
</style>
