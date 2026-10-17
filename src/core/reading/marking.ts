import { EMPHASIS_KINDS, SYNTAX_KINDS, SYNTAX_LABELS, type ReadingEmphasisKind, type ReadingPartOfSpeech, type ReadingSettings, type ReadingMarkStyle } from './settings';

export const READING_MARK_ITEMS = [
  ...SYNTAX_KINDS.map(id => ({ id, label: SYNTAX_LABELS[id], family: 'syntax' as const })),
  ...EMPHASIS_KINDS.map(id => ({ id, label: ({ negation: '否定词', connectives: '逻辑连接词', numbers: '数字与数量', properNouns: '专名' })[id], family: 'emphasis' as const })),
];
export type ReadingMarkItem = typeof READING_MARK_ITEMS[number];

/** 两类识别结果使用同一配置接口；保留词性与语义的独立开关及样式。 */
export function readingMarkConfig(settings: ReadingSettings, item: ReadingMarkItem) {
  if (item.family === 'syntax') {
    const id = item.id as ReadingPartOfSpeech;
    return { enabled: settings.syntax.enabled && settings.syntax[`${id}s`], mode: settings.syntax.modes[id] ?? settings.syntax.mode, color: settings.syntax.colors[id] };
  }
  const id = item.id as ReadingEmphasisKind;
  return { enabled: settings.emphasis[id], ...settings.emphasis.styles[id] };
}

export function updateReadingMark(settings: ReadingSettings, item: ReadingMarkItem, patch: { enabled?: boolean; mode?: ReadingMarkStyle; color?: string }) {
  if (item.family === 'syntax') {
    const id = item.id as ReadingPartOfSpeech;
    if (patch.enabled !== undefined) {
      // 总开关关闭时先清空词类，再启用用户选中的条目，避免顺带开启全部词性。
      if (!settings.syntax.enabled && patch.enabled) {
        for (const kind of SYNTAX_KINDS) settings.syntax[`${kind}s`] = false;
        settings.syntax.enabled = true;
      }
      settings.syntax[`${id}s`] = patch.enabled;
      settings.syntax.enabled = SYNTAX_KINDS.some(kind => settings.syntax[`${kind}s`]);
    }
    if (patch.mode !== undefined) settings.syntax.modes[id] = patch.mode;
    if (patch.color !== undefined) settings.syntax.colors[id] = patch.color;
  } else {
    const id = item.id as ReadingEmphasisKind;
    if (patch.enabled !== undefined) settings.emphasis[id] = patch.enabled;
    if (patch.mode !== undefined) settings.emphasis.styles[id].mode = patch.mode;
    if (patch.color !== undefined) settings.emphasis.styles[id].color = patch.color;
  }
}
