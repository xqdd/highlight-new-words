import type { ReadingSettings } from '@/core/reading/settings';

/** 只采用有明确界面语义的容器，避免按 author/tag 等宽泛类名误伤正文。 */
export const READING_METADATA = '[role="toolbar"],[role="tablist"],[role="status"],[role="tooltip"],[itemprop="keywords"],.post-taglist,.js-topic-tag-list,.comment-metadata,.entry-meta,.post-meta,.byline,ytd-watch-info-text,ytd-video-owner-renderer,ytd-macro-markers-list-renderer,ytd-horizontal-card-list-renderer';

export interface ReadingScopeSlice { start: number; end: number; link: boolean }

/** 按视觉硬换行过滤零散文字，原文偏移保持不变；普通 HTML 源码换行不作为分段依据。 */
export function ignoredReadingRanges(text: string, breaks: readonly number[], slices: readonly ReadingScopeSlice[], scope: ReadingSettings['scope']): Array<{ start: number; end: number }> {
  const ignored = [];
  let start = 0;
  for (const end of [...breaks, text.length]) {
    const line = text.slice(start, end);
    let skip = scope.skipShortBlocks && (line.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? []).length < scope.minWords;
    if (!skip && scope.skipStandaloneLinks && /[A-Za-z]/.test(line)) {
      // 切片可能横跨多行；只统计本行实际的文字，不让其他行的正文替独立链接解除过滤。
      skip = slices.filter(slice => slice.start < end && slice.end > start)
        .every(slice => slice.link || !/[A-Za-z0-9]/.test(text.slice(Math.max(start, slice.start), Math.min(end, slice.end))));
    }
    if (!skip && scope.skipMetadata) {
      const trimmed = line.trim();
      // 纯 URL、话题/账号列表及明确的章节跳转属于索引信息，正文中提及它们仍可参与分析。
      skip = /^(?:(?:https?:\/\/|www\.)\S+\s*)+$/i.test(trimmed)
        || /^(?:[#@][\p{L}\p{N}_-]+\s*)+$/u.test(trimmed)
        || trimmed.split(/\s[·•|]\s/).length >= 3 && !/[.!?。！？](?:\s|$)/.test(trimmed)
        || /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s+\S/.test(line)
          && slices.some(slice => slice.link && slice.start < end && slice.end > start
            && /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*$/.test(text.slice(Math.max(start, slice.start), Math.min(end, slice.end))));
    }
    if (skip) ignored.push({ start, end });
    start = end + 1;
  }
  return ignored;
}
