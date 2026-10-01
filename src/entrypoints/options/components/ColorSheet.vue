<script setup lang="ts">
import BottomSheet from '@/ui/components/BottomSheet.vue';
import ColorPicker from '@/ui/components/ColorPicker.vue';

/**
 * 取色弹层：手机为底部抽屉、桌面为对话框；颜色实时生效（预览区在页面顶部吸顶，可边选边看）。
 * footer 插槽放“跟随全局”“清除”等额外操作。
 */
const open = defineModel<boolean>('open', { required: true });
const color = defineModel<string>('color', { required: true });
defineProps<{ title: string; description?: string; alpha?: boolean }>();
</script>

<template>
  <BottomSheet v-model:open="open" :title="title" :description="description">
    <ColorPicker v-model="color" :alpha="alpha" />
    <template #footer>
      <slot />
      <button type="button" class="btn primary" @click="open = false">完成</button>
    </template>
  </BottomSheet>
</template>
