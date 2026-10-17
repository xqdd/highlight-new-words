import { EMPHASIS_KINDS, SYNTAX_KINDS, type ReadingSettings, type ReadingMarkStyle } from '@/core/reading/settings';
import type { ReadingToken } from '@/core/reading/analyze';

interface NativeSlice { node: Text; start: number; end: number; protected: boolean }
const CHANNELS = { color: 'color', underline: 'line', dotted: 'line', wavy: 'line', background: 'background', marker: 'background', bold: 'stroke' } as const;
let instanceId = 0;

/**
 * 原生文字绘制不插入逐词元素，不改变站点 Text、断行、选择或链接。
 * 使用 StaticRange 避免每次生词 DOM 写入时更新整页 live Range；正文变化后由视觉控制器重新提交。
 */
export class NativeReadingHighlights {
  static supported(doc: Document): boolean {
    const view = doc.defaultView;
    return !!view?.CSS?.highlights && typeof view.Highlight === 'function' && typeof view.StaticRange === 'function';
  }

  private readonly prefix = `hnw-reading-${++instanceId}`;
  private readonly layers = new Map<string, Highlight>();
  private readonly blocks = new Map<Element, Array<{ layer: Highlight; range: StaticRange }>>();
  private readonly style: HTMLStyleElement;

  constructor(private doc: Document, private settings: ReadingSettings) {
    const rules: string[] = [];
    // 一次注册所有配置组合；滚动时仅更新绘制范围，绝不逐词/逐批修改样式表。
    for (const pos of [undefined, ...SYNTAX_KINDS]) for (const emphasis of [undefined, ...EMPHASIS_KINDS]) {
      const channels = new Map<string, { mode: ReadingMarkStyle; color: string }>();
      if (pos && settings.syntax.enabled && settings.syntax[`${pos}s`]) {
        const mode = settings.syntax.modes[pos] ?? settings.syntax.mode;
        channels.set(CHANNELS[mode], { mode, color: settings.syntax.colors[pos] });
      }
      if (emphasis && settings.emphasis[emphasis]) {
        const marking = settings.emphasis.styles[emphasis];
        channels.set(CHANNELS[marking.mode], marking);
      }
      const declarations: string[] = [];
      for (const { mode, color } of channels.values()) {
        if (mode === 'color') declarations.push(`color:${color}`);
        else if (mode === 'background') declarations.push(`background-color:${color}33`);
        // highlight 不支持 background-image；以同色透明底保留荧光提示，避免为渐变再包装正文。
        else if (mode === 'marker') declarations.push(`background-color:${color}55`);
        else if (mode === 'bold') declarations.push(`text-shadow:0.35px 0 ${color},-0.35px 0 ${color}`);
        else declarations.push(`text-decoration-line:underline;text-decoration-style:${mode === 'underline' ? 'solid' : mode};text-decoration-color:${color};text-underline-offset:3px`);
      }
      const key = `${pos ?? 'none'}-${emphasis ?? 'none'}`;
      if (declarations.length) this.addLayer(key, declarations.join(';'), rules);
      if (settings.bionic.enabled) {
        const stroke = { light: 0.25, medium: 0.45, strong: 0.65 }[settings.bionic.intensity];
        const color = channels.get('color')?.color ?? 'currentColor';
        const existingShadow = declarations.find(value => value.startsWith('text-shadow:'))?.slice('text-shadow:'.length);
        // 词首与词尾用不重叠范围，防止透明背景叠两遍变深；显式沿用词色，避免高层 currentColor 遮盖彩色层。
        const prefixDeclarations = declarations.filter(value => !value.startsWith('text-shadow:'));
        prefixDeclarations.push(`text-shadow:${existingShadow ? `${existingShadow},` : ''}${stroke}px 0 ${color},-${stroke}px 0 ${color}`);
        this.addLayer(`${key}-prefix`, prefixDeclarations.join(';'), rules);
      }
    }
    this.style = doc.createElement('style');
    this.style.textContent = rules.join('\n');
    doc.head.append(this.style);
  }

  private addLayer(key: string, declarations: string, rules: string[]): void {
    const name = `${this.prefix}-${key}`;
    const layer = new this.doc.defaultView!.Highlight();
    layer.priority = 1;
    this.doc.defaultView!.CSS.highlights.set(name, layer);
    this.layers.set(key, layer);
    rules.push(`::highlight(${name}){${declarations}}`);
  }

  has(block: Element): boolean { return this.blocks.has(block); }

  paint(block: Element, slices: NativeSlice[], tokens: ReadingToken[], bionic: Set<ReadingToken>): void {
    this.remove(block);
    const entries: Array<{ layer: Highlight; range: StaticRange }> = [];
    let tokenIndex = 0;
    for (const slice of slices) {
      // 已有生词保留自身 DOM、事件和译文；阅读优先时直接绘制其 Text，生词优先时保留原视觉。
      if (slice.protected && this.settings.wordStylePriority === 'vocabulary') continue;
      while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= slice.start) tokenIndex++;
      for (let i = tokenIndex; i < tokens.length && tokens[i]!.start < slice.end; i++) {
        const token = tokens[i]!;
        const pos = this.settings.syntax.enabled && token.pos && this.settings.syntax[`${token.pos}s`] ? token.pos : undefined;
        const emphasis = token.emphasis && this.settings.emphasis[token.emphasis] ? token.emphasis
          : token.properNoun && this.settings.emphasis.properNouns ? 'properNouns' : undefined;
        const start = Math.max(token.start, slice.start) - slice.start;
        const end = Math.min(token.end, slice.end) - slice.start;
        const key = `${pos ?? 'none'}-${emphasis ?? 'none'}`;
        const hasPrefix = this.settings.bionic.enabled && bionic.has(token) && token.text.length >= this.settings.bionic.minLength;
        const prefixEnd = hasPrefix ? Math.max(start, Math.min(end, token.start + Math.max(1, Math.ceil(token.text.length * this.settings.bionic.ratio)) - slice.start)) : start;
        const layer = this.layers.get(key);
        if (layer && end > prefixEnd) {
          const range = new this.doc.defaultView!.StaticRange({ startContainer: slice.node, startOffset: prefixEnd, endContainer: slice.node, endOffset: end });
          layer.add(range); entries.push({ layer, range });
        }
        if (prefixEnd > start) {
          const prefixLayer = this.layers.get(`${key}-prefix`)!;
          const range = new this.doc.defaultView!.StaticRange({ startContainer: slice.node, startOffset: start, endContainer: slice.node, endOffset: prefixEnd });
          prefixLayer.add(range); entries.push({ layer: prefixLayer, range });
        }
      }
    }
    if (entries.length) this.blocks.set(block, entries);
  }

  remove(block: Element, descendants = false): void {
    // 行内子树脱离原段落后，块索引仍指向旧段落；范围归属必须按实际节点判断。
    const blocks = descendants ? [...this.blocks.keys()] : [block];
    for (const candidate of blocks) {
      const retained: Array<{ layer: Highlight; range: StaticRange }> = [];
      for (const entry of this.blocks.get(candidate) ?? []) {
        if (!descendants || block.contains(candidate) || block.contains(entry.range.startContainer)) entry.layer.delete(entry.range);
        else retained.push(entry);
      }
      if (retained.length) this.blocks.set(candidate, retained);
      else this.blocks.delete(candidate);
    }
  }

  stop(): void {
    for (const key of this.layers.keys()) this.doc.defaultView!.CSS.highlights.delete(`${this.prefix}-${key}`);
    this.layers.clear(); this.blocks.clear();
    this.style.remove();
  }
}
