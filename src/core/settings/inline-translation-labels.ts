import type { InlineTranslationMode } from '@/core/theme/themes';

/**
 * 行内译文（settings.inlineTranslation.mode）在各界面的统一叫法：选项页外观、首次引导、popup、悬浮球快捷设置共用。
 * 统一叫“行内译文”，不用“释义”——“释义”专指单词卡片（“释义卡片”），混用会让人以为关掉的是卡片。
 */
export const INLINE_TRANSLATION_NAME = '行内译文';
/** 空间紧张处（popup 标题行开关）的短名 */
export const INLINE_TRANSLATION_SHORT_NAME = '译文';

/** 四个模式的短标签（全部界面同一组） */
export const INLINE_MODE_LABELS: Record<InlineTranslationMode, string> = {
  off: '关闭',
  after: '词后',
  ruby: '词上方',
  hover: '仅悬停',
};

/** 按 off / after / ruby / hover 的顺序列出选项，界面可再补 desc 等字段 */
export const INLINE_MODE_ORDER: readonly InlineTranslationMode[] = ['off', 'after', 'ruby', 'hover'];
