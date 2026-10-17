import type { ReadingSettings } from '@/core/reading/settings';
import { ignoredReadingRanges, READING_METADATA } from '../reading/scope';
import type { TextHit } from './highlighter';

const TEXT_BLOCKS = 'p,li,blockquote,figcaption,dd,dt,td,th,pre,h1,h2,h3,h4,h5,h6,button,[role="button"],yt-attributed-string,yt-formatted-string,div,section,article,main,nav,header,footer,aside';

/** 生词范围按正文块缓存，单次读取所有行内文字，避免每个命中词重复遍历同一段。 */
export class HighlightScopeFilter {
  private blocks = new WeakMap<Element, { starts: Map<Text, number>; ignored: Array<{ start: number; end: number }> }>();
  constructor(private scope: ReadingSettings['scope']) {}

  blockOf(node: Node): Element | null {
    return (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest(TEXT_BLOCKS) ?? null;
  }

  invalidate(): void { this.blocks = new WeakMap(); }

  filter(node: Text, hits: TextHit[]): TextHit[] {
    const parent = node.parentElement!;
    const s = this.scope;
    if (s.skipButtons && parent.closest('button,[role="button"]')
      || s.skipNavigation && parent.closest('nav,header,footer,aside,[role="navigation"],[role="menu"]')
      || s.skipHeadings && parent.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')
      || s.skipTables && parent.closest('table,[role="table"],[role="grid"]')
      || s.skipMetadata && parent.closest(READING_METADATA)) return [];
    const block = this.blockOf(node) ?? parent;
    let cached = this.blocks.get(block);
    if (!cached) {
      const starts = new Map<Text, number>(), breaks: number[] = [], slices = [];
      let text = '', visited = 0;
      const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: element => {
          // 达到预算时返回当前节点，让外层退出；也计入被跳过的空容器，避免复杂 DOM 无界遍历。
          if (++visited > 800 || text.length > 6000) return NodeFilter.FILTER_ACCEPT;
          if (element.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
          const el = element as Element;
          if (el.localName === 'br') { breaks.push(text.length); text += '\n'; return NodeFilter.FILTER_REJECT; }
          if (el.matches('script,style,code,pre,input,textarea,select,[hidden],[aria-hidden="true"],[contenteditable="true"]')
            || s.skipButtons && el.matches('button,[role="button"]')
            || s.skipMetadata && el.matches(READING_METADATA)
            || el.matches(TEXT_BLOCKS)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        },
      });
      let current: Node | null;
      const whitespace = new WeakMap<Element, boolean>();
      while ((current = walker.nextNode())) {
        if (visited > 800 || text.length > 6000) break;
        if (current.nodeType !== Node.TEXT_NODE) continue;
        const t = current as Text, host = t.parentElement!;
        starts.set(t, text.length);
        let preserve = whitespace.get(host);
        if (preserve === undefined) {
          preserve = /pre|break-spaces/.test(host.ownerDocument.defaultView?.getComputedStyle(host).whiteSpace ?? '');
          whitespace.set(host, preserve);
        }
        if (preserve) for (const match of t.data.matchAll(/\n/g)) breaks.push(text.length + match.index);
        slices.push({ start: text.length, end: text.length + t.length, link: !!host.closest('a[href]') });
        text += t.data;
      }
      cached = { starts, ignored: ignoredReadingRanges(text, breaks, slices, s) };
      this.blocks.set(block, cached);
    }
    const start = cached.starts.get(node);
    // 超长或超复杂的容器不继续同步扫描，保留原有生词行为，避免扩大排版过滤的开销。
    if (start === undefined) return hits;
    return hits.filter(hit => !cached.ignored.some(range => start + hit.start < range.end && start + hit.end > range.start));
  }
}
