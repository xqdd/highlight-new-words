import { fetchPackagedJson } from '../../core/dict/packaged';

export interface ReadingPhraseData { entries: Record<string, string> }

/** 精确匹配固定表达，限制为 2–8 词，拒绝句子标点和多段选择。 */
export function normalizeReadingPhrase(text: string): string | undefined {
  const phrase = text.trim().toLowerCase().replace(/[\t \u00a0]+/g, ' ');
  return /^[a-z]+(?: [a-z]+){1,7}$/.test(phrase) ? phrase : undefined;
}

/** be 的常见屈折只在精确查找无结果时回退；used to 等整条释义始终优先。 */
export function lookupReadingPhrase(data: ReadingPhraseData, phrase: string): string | undefined {
  if (Object.hasOwn(data.entries, phrase)) return data.entries[phrase];
  const canonical = phrase.replace(/^(?:am|is|are|was|were|been|being) /, 'be ');
  return Object.hasOwn(data.entries, canonical) ? data.entries[canonical] : undefined;
}

/** 用户主动选中短语时才加载本地词典；原始 DOM 和 Selection 始终保留。 */
export class ReadingPhrasesController {
  private enabled = false;
  private data?: Promise<ReadingPhraseData>;
  private host?: HTMLElement;
  private anchor?: { range: Range; top: number; left: number };
  private generation = 0;
  private readonly doc: Document;
  private readonly load: () => Promise<ReadingPhraseData>;

  constructor(options: { document?: Document; load?: () => Promise<ReadingPhraseData> } = {}) {
    this.doc = options.document ?? document;
    this.load = options.load ?? (() => fetchPackagedJson<ReadingPhraseData>('data/reading-phrases.json'));
  }

  update(settings: { enabled: boolean }): void {
    if (settings.enabled === this.enabled) return;
    this.enabled = settings.enabled;
    if (this.enabled) {
      this.doc.addEventListener('pointerup', this.onSelection);
      this.doc.addEventListener('keyup', this.onKey);
      this.doc.addEventListener('pointerdown', this.onPointerDown);
      this.doc.defaultView?.addEventListener('scroll', this.onScroll, true);
    } else this.detach();
  }

  dispose(): void { this.enabled = false; this.detach(); }

  private detach(): void {
    this.doc.removeEventListener('pointerup', this.onSelection);
    this.doc.removeEventListener('keyup', this.onKey);
    this.doc.removeEventListener('pointerdown', this.onPointerDown);
    this.doc.defaultView?.removeEventListener('scroll', this.onScroll, true);
    this.close();
  }

  private close = (): void => {
    this.generation++;
    this.host?.remove();
    this.host = undefined;
    this.anchor = undefined;
  };

  private onScroll = (): void => {
    if (!this.anchor) return;
    const rect = this.anchor.range.getBoundingClientRect();
    // 移动端可能在选区浮层出现后才派发已完成的 scroll 通知；仅实际锚点移动时关闭。
    if (Math.abs(rect.top - this.anchor.top) > 1 || Math.abs(rect.left - this.anchor.left) > 1) this.close();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.composedPath().includes(this.host!)) return;
    this.close();
  };

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
    else if (event.key === 'Shift' || event.key.startsWith('Arrow')) void this.onSelection(event);
  };

  private onSelection = async (event: Event): Promise<void> => {
    if (!this.enabled || (event instanceof MouseEvent && event.button !== 0)) return;
    if (this.host && event.composedPath().includes(this.host)) return;
    this.close();
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement;
    const excluded = 'a,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),code,pre,[data-hnw-ui]';
    if (start?.closest(excluded) || end?.closest(excluded) || range.cloneContents().querySelector(excluded)) return;
    const selectedText = selection.toString();
    const phrase = normalizeReadingPhrase(selectedText);
    if (!phrase || typeof range.getBoundingClientRect !== 'function') return;
    const token = this.generation;
    let meaning: string;
    try {
      this.data ??= this.load();
      const data = await this.data;
      meaning = lookupReadingPhrase(data, phrase) ?? '本地短语词典未收录';
    } catch {
      this.data = undefined;
      meaning = '本地短语词典暂时无法读取';
    }
    // 异步加载期间用户可能已关闭浮层、移动选区或禁用功能。
    if (!this.enabled || token !== this.generation || this.doc.getSelection()?.toString() !== selectedText) return;
    const rect = range.getBoundingClientRect();
    const host = this.doc.createElement('div');
    host.setAttribute('data-hnw-ui', 'reading-phrase');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = ':host{all:initial;position:fixed;z-index:2147483647;display:block}button{box-sizing:border-box;max-width:min(340px,calc(100vw - 24px));border:1px solid #a7b1ad;border-radius:6px;background:#fff;color:#17251e;padding:9px 12px;text-align:left;font:13px/1.55 system-ui,sans-serif;white-space:normal;overflow-wrap:anywhere;box-shadow:0 3px 12px #0002;cursor:pointer}strong{display:block;font-weight:600}span{display:block}';
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.title = '收起短语释义';
    button.setAttribute('aria-label', `${phrase}：${meaning}；收起`);
    const title = this.doc.createElement('strong');
    title.textContent = phrase;
    const body = this.doc.createElement('span');
    body.textContent = meaning;
    button.append(title, body);
    button.addEventListener('click', this.close);
    shadow.append(style, button);
    host.style.left = `${Math.max(12, Math.min(rect.left, (this.doc.defaultView?.innerWidth ?? 360) - 352))}px`;
    host.style.top = `${Math.max(12, rect.bottom + 7)}px`;
    this.doc.documentElement.append(host);
    this.host = host;
    this.anchor = { range, top: rect.top, left: rect.left };
    const height = host.getBoundingClientRect().height;
    const viewport = this.doc.defaultView?.innerHeight ?? 800;
    if (rect.bottom + 7 + height > viewport - 12) host.style.top = `${Math.max(12, rect.top - height - 7)}px`;
  };
}
