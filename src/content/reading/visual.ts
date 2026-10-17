import { analyzeReading, type ReadingToken } from '@/core/reading/analyze';
import { EMPHASIS_KINDS, type ReadingSettings, type ReadingMarkStyle } from '@/core/reading/settings';
import { shouldSkipElement } from '@/content/engine/dom';
import { hasFragments, restoreGroup, ownerTextOf, registerTextDecoration, detachTextDecoration, writeDecoratedText, isDecorationWrite } from '@/content/engine/highlighter';
import { ignoredReadingRanges, READING_METADATA } from './scope';

// pre 仅允许 shouldSkipElement 已确认的 Medium 响应正文；普通预格式文本和代码仍然排除。
const STRUCTURED_BLOCKS = 'p,li,blockquote,figcaption,dd,dt,td,th,pre,:is(article,main,[role="main"],.markdown-body,.s-prose) :is(h1,h2,h3,h4,h5,h6),ytd-watch-metadata h1';
// YouTube 正文使用自定义元素；限定描述和评论区域，避免把推荐列表和播放器控件当正文。
const VIDEO_BLOCKS = 'ytd-watch-metadata #description yt-attributed-string,ytd-watch-metadata #description yt-formatted-string,ytd-video-secondary-info-renderer #description,ytd-comment-view-model #content-text,ytd-comment-renderer #content-text';
// 常见文章/讨论区也用 div 分段，仅在语义正文区域发现含实际英文文本的容器。
const PROSE_BLOCKS = ':is(article,main,[role="main"],[role="article"],.s-prose,.markdown-body,shreddit-comment) :is(div,section),article,main,[role="article"],shreddit-comment';
const BUTTONS = 'button,[role="button"]';
const NAVIGATION = 'nav,header,footer,aside,[role="navigation"],[role="menu"]';
// 放行界面文字时，独立控件与导航链接各自作为文本块，避免依赖正文祖先或串联整个菜单。
const BLOCKS = `${STRUCTURED_BLOCKS},${VIDEO_BLOCKS},${PROSE_BLOCKS},${BUTTONS},${NAVIGATION},${READING_METADATA},:is(${NAVIGATION}) :is(a[href],div,section)`;
const TAG = 'hnw-read';
const EXCLUDED = '[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],ytd-watch-next-secondary-results-renderer,ytd-rich-grid-renderer';
const MAX_BLOCK_LENGTH = 6000;
const MAX_BLOCK_NODES = 800;
const MAX_PENDING = 32;
// 四向缓冲兼顾长文上下滚动和宽表格横移；离屏缓存另设上限，避免预读区边界往返反复重建。
const PREFETCH_MARGIN = '1600px 1600px';
const MAX_CACHED_BLOCKS = 64;
const MAX_CACHED_CHARACTERS = 8000;
const PREFETCH_SETTLE_MS = 90;
const SCROLL_RENDER_INTERVAL_MS = 80;
const MAX_RENDER_BATCH = 8;
const RENDER_READ_BUDGET_MS = 8;
// 同一通道由语义强调覆盖词性；不同通道共存，不重置作者已有的字色或装饰。
const STYLE_CHANNELS = {
  color: 'color', underline: 'line', dotted: 'line', wavy: 'line',
  background: 'background', marker: 'background', bold: 'stroke',
} as const;

interface TextSlice { node: Text; start: number; end: number; protected: boolean }
const WORD_ATTRIBUTES = ['data-pos', 'data-emphasis', 'data-bionic', 'data-prefix', 'data-hnw-reading-word'] as const;
type WordSnapshot = { style: string | null; attributes: Array<string | null> };

/**
 * 可撤销的正文视觉提示。每个任务只分析一个有长度上限的段落，任务间让出主线程。
 * 词性读取完整行内上下文，写入仅改文字包装，保留链接、事件处理器和原站点元素。
 */
export class ReadingVisual {
  private observer?: MutationObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private frame?: number;
  private lastScrollAt = -Infinity;
  private lastRenderAt = -Infinity;
  private readonly onScroll = () => { this.lastScrollAt = performance.now(); };
  private running = false;
  private excluded = EXCLUDED;
  private videoTextDocument = false;
  private pending = new Set<Element>();
  private discovery: Array<{ walker: TreeWalker; force: boolean; reset: WeakSet<Element>; parents: WeakSet<Element> }> = [];
  private intersections?: IntersectionObserver;
  private visibleIntersections?: IntersectionObserver;
  private visible = new Set<Element>();
  private observed = new WeakSet<Element>();
  private analyzed = new WeakSet<Element>();
  private nearby = new Set<Element>();
  private cachedOffscreen = new Map<Element, number>();
  private cachedCharacters = 0;
  private blockLengths = new WeakMap<Element, number>();
  private groups = new Map<Text, HTMLElement>();
  private groupsByBlock = new Map<Element, Set<Text>>();
  private blockOf = new WeakMap<Text, Element>();
  private style?: HTMLStyleElement;
  private pendingVocabulary = new Set<Element>();
  private decoratedWords = new Map<Element, Map<HTMLElement, WordSnapshot>>();

  constructor(private root: HTMLElement, private settings: ReadingSettings) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.excluded = [EXCLUDED, ...(this.settings.scope.skipButtons ? [BUTTONS] : []), ...(this.settings.scope.skipNavigation ? [NAVIGATION] : []), ...(this.settings.scope.skipMetadata ? [READING_METADATA] : [])].join(',');
    this.videoTextDocument = /(^|\.)youtube\.com$/i.test(this.root.ownerDocument.location.hostname)
      || !!this.root.querySelector('ytd-watch-metadata,ytd-video-secondary-info-renderer,ytd-comment-view-model,ytd-comment-renderer');
    this.lastScrollAt = -Infinity;
    this.lastRenderAt = -Infinity;
    this.root.ownerDocument.defaultView?.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.style = this.root.ownerDocument.createElement('style');
    const stroke = { light: 0.25, medium: 0.45, strong: 0.65 }[this.settings.bionic.intensity];
    // 前缀由伪元素覆盖描粗，原单词保持单一 Text，不破坏生词引擎的整词匹配或复制。
    const prefix = ':is(hnw-read,hnw-w[data-hnw-reading-word])[data-prefix]';
    this.style.textContent = `${prefix}{position:relative}${prefix}::before{content:attr(data-prefix);position:absolute;inset-inline-start:0;top:auto;max-width:100%;overflow:hidden;white-space:nowrap;font-weight:inherit;-webkit-text-stroke:${stroke}px currentColor;pointer-events:none;user-select:none}hnw-read[data-prefix]:has(hnw-mark)::before{content:none}`;
    // 生词优先时仅取消包含生词的词级包装；正文其余阅读效果和译文均保留。
    if (this.settings.wordStylePriority === 'vocabulary') this.style.textContent += 'hnw-read:is([data-pos],[data-emphasis],[data-bionic]):has(hnw-mark){all:unset!important}';
    this.root.ownerDocument.head.append(this.style);
    const IO = this.root.ownerDocument.defaultView?.IntersectionObserver;
    const prefetchOptions: IntersectionObserverInit & { scrollMargin?: string } = { rootMargin: PREFETCH_MARGIN };
    // rootMargin 不会穿透中间滚动容器的裁剪；支持 scrollMargin 时为宽表格预读左右邻列。
    // 内嵌长表格也会纵向裁剪，四向预读才能在进入可见区之前完成标记；旧浏览器沿用视口预读和往返缓存。
    if (IO && 'scrollMargin' in IO.prototype) prefetchOptions.scrollMargin = '1200px 800px';
    if (IO) this.intersections = new IO((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          this.forgetCachedBlock(entry.target);
          this.nearby.add(entry.target); this.enqueueBlock(entry.target);
        } else {
          this.nearby.delete(entry.target); this.pending.delete(entry.target);
          if (!this.cachedOffscreen.has(entry.target) && (this.groupsByBlock.has(entry.target) || this.decoratedWords.has(entry.target))) {
            const characters = this.blockLengths.get(entry.target) ?? 0;
            this.cachedOffscreen.set(entry.target, characters);
            this.cachedCharacters += characters;
          }
        }
      }
      this.schedule();
    }, prefetchOptions);
    // 浏览器统一计算真实可见区，避免每帧逐个读候选块的位置触发布局。
    if (IO) this.visibleIntersections = new IO(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) { this.visible.add(entry.target); this.enqueueBlock(entry.target); }
        else this.visible.delete(entry.target);
      }
      this.schedule();
    });
    this.observer = new MutationObserver(records => this.handleMutations(records));
    this.observe();
    this.discover(this.root);
    this.schedule();
  }

  private handleMutations(records: MutationRecord[]): void {
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement;
      // 生词引擎后续插入/重建标记时，只同步生词文字的样式，不撤销正文或触发双方循环重建。
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node as Element).matches('hnw-mark'))) {
        const block = target?.closest(BLOCKS);
        if (block && this.root.contains(block) && this.pendingVocabulary.size < MAX_PENDING) this.pendingVocabulary.add(block);
      }
      // 生词引擎在视觉组内部切分/恢复文本，不改变正文语义，无需重复分析。
      if (target?.closest(`${TAG}[data-group],hnw-mark,hnw-w,hnw-tr,hnw-reading-tools`)) continue;
      if (record.type === 'characterData' && (hasFragments(record.target as Text) || isDecorationWrite(record.target as Text))) continue;
      if (record.type === 'childList') {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.some((node) => ownerTextOf(node))) continue;
        if (nodes.length && nodes.every((node) => node.nodeType === 1 && (node as Element).tagName.startsWith('HNW-'))) continue;
      }
      if (record.type === 'characterData' && this.groups.has(record.target as Text)) this.discard(record.target as Text);
      for (const node of record.removedNodes) {
        if (node.nodeType === Node.TEXT_NODE && this.groups.has(node as Text)) this.discard(node as Text);
        // 被页面移除的整段也需解除索引/观察，否则虚拟列表会长期保留旧 DOM。
        if (node.nodeType === Node.ELEMENT_NODE && !node.isConnected && !(node as Element).tagName.startsWith('HNW-')) {
          this.observer?.disconnect();
          this.restore(node as Element, true);
          for (const block of [node as Element, ...(node as Element).querySelectorAll(BLOCKS)]) {
            this.intersections?.unobserve(block);
            this.visibleIntersections?.unobserve(block);
            this.visible.delete(block);
            this.observed.delete(block); this.analyzed.delete(block);
            this.nearby.delete(block); this.pending.delete(block); this.forgetCachedBlock(block); this.pendingVocabulary.delete(block);
          }
          this.observe();
        }
      }
      const block = target?.closest(BLOCKS);
      // 容器的动画 class/style 不代表它自身含正文；只置脏已发现的块或新写入的英文 Text。
      // 新增元素的正文由下面的 discover 处理，避免把数百个纯布局 div 塞进视口队列。
      if (block && this.root.contains(block) && (this.observed.has(block) || record.type === 'characterData'
        || [...record.addedNodes].some(node => node.nodeType === Node.TEXT_NODE && /[A-Za-z]/.test(node.textContent ?? '')))) this.registerBlock(block, true);
      if (record.type === 'attributes') {
        if (target && !this.safe(target)) {
          this.observer?.disconnect();
          // blockquote/li 也可能含独立正文块：安全失效必须撤销整棵后代子树。
          this.restore(target, true);
          this.observe();
          continue;
        }
        if (target) this.discover(target, true);
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        // 避免为每条 mutation 全量收集大型子树；改用后续时间片中的 TreeWalker。
        if (!el.tagName.startsWith('HNW-')) this.discover(el);
      }
    }
    this.schedule();
  }

  update(settings: ReadingSettings): void {
    this.stop();
    this.settings = settings;
    this.start();
  }

  stop(): void {
    this.running = false;
    this.root.ownerDocument.defaultView?.removeEventListener('scroll', this.onScroll, true);
    this.observer?.disconnect();
    this.intersections?.disconnect();
    this.intersections = undefined;
    this.visibleIntersections?.disconnect();
    this.visibleIntersections = undefined;
    this.visible.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.frame !== undefined) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.pending.clear();
    this.pendingVocabulary.clear();
    this.discovery = [];
    this.nearby.clear();
    this.cachedOffscreen.clear();
    this.cachedCharacters = 0;
    this.blockLengths = new WeakMap();
    this.observed = new WeakSet();
    this.analyzed = new WeakSet();
    // 停止前尚未派发移除记录的子树也要各自还原，不能借其他子树清理而丢掉原文。
    const detached = new Set([...this.groupsByBlock.keys(), ...this.decoratedWords.keys()]);
    for (const block of detached) if (!block.isConnected) this.restore(block, true);
    this.restore(this.root, true);
    this.style?.remove();
    this.style = undefined;
  }

  private active(): boolean {
    const s = this.settings;
    return s.enabled && (s.bionic.enabled || s.syntax.enabled || EMPHASIS_KINDS.some(kind => s.emphasis[kind]));
  }

  private createWalker(root: Element = this.root): TreeWalker {
    return this.root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const el = node as Element;
        if (el.matches('hnw-mark,hnw-w')) return NodeFilter.FILTER_SKIP;
        if (el.tagName.startsWith('HNW-') || el.matches(this.excluded) || shouldSkipElement(el)) return NodeFilter.FILTER_REJECT;
        // 接受普通元素，让发现阶段也能按节点数/时间主动让出线程。
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  private enqueueBlock(block: Element): void {
    if (this.analyzed.has(block) || (this.intersections && !this.nearby.has(block))) return;
    if (this.pending.size >= MAX_PENDING && !this.pending.has(block)) {
      // 宽表格/短评论可能让预读区先塞满队列；真正可见的块应替换缓冲候选，而非排队等待32段。
      if (!this.visible.has(block)) return;
      const buffered = [...this.pending].find(candidate => !this.visible.has(candidate));
      if (!buffered) return;
      this.pending.delete(buffered);
    }
    this.pending.add(block);
  }

  private forgetCachedBlock(block: Element): void {
    const characters = this.cachedOffscreen.get(block);
    if (characters === undefined) return;
    this.cachedCharacters -= characters;
    this.cachedOffscreen.delete(block);
  }

  private registerBlock(block: Element, force = false): void {
    // 一个段落的多个 Text（含已切分生词）共享同一观察，不重复校验祖先与入队。
    if (!force && this.observed.has(block)) {
      if (!this.intersections) this.enqueueBlock(block);
      return;
    }
    if (block.closest(this.excluded) || shouldSkipElement(block)) return;
    if (force) this.analyzed.delete(block);
    if (!this.observed.has(block)) {
      this.observed.add(block);
      this.intersections?.observe(block);
      this.visibleIntersections?.observe(block);
    }
    this.enqueueBlock(block);
  }

  private discover(root: Element, force = false): void {
    if (root.closest(this.excluded)) return;
    // TreeWalker 不会对根节点调用过滤器，增量扫描必须先检查它和祖先的站点/编辑器排除规则。
    for (let el: Element | null = root; el; el = el.parentElement) {
      if (shouldSkipElement(el)) return;
      if (el === this.root) break;
    }
    // 评论成批挂入时先交给视口观察，不等待整页/样式变化的后台遍历到达页面后部。
    // 只查询有明确正文边界的站点容器，普通大子树仍按下面的预算增量发现。
    if (this.videoTextDocument && !force) {
      if (root.matches(VIDEO_BLOCKS)) this.registerBlock(root);
      for (const block of root.querySelectorAll(VIDEO_BLOCKS)) this.registerBlock(block);
    }
    // mutation 风暴合并为一次发现；analyzed 保证已完成正文不会随全页扫描重做。
    if (this.discovery.length >= 16) this.discovery = [{ walker: this.createWalker(), force, reset: new WeakSet(), parents: new WeakSet() }];
    else this.discovery.push({ walker: this.createWalker(root), force, reset: new WeakSet(), parents: new WeakSet() });
  }

  private observe(): void {
    this.observer?.observe(this.root, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'contenteditable', 'role', 'class', 'style'] });
  }

  private schedule(): void {
    if (!this.running || !this.active() || this.timer !== undefined || this.frame !== undefined) return;
    const work = () => {
      this.timer = undefined;
      this.frame = undefined;
      const deadline = performance.now() + 3;
      let discovered = 0;
      while (this.discovery.length && discovered++ < 200 && performance.now() < deadline && (this.intersections || this.pending.size < MAX_PENDING)) {
        const job = this.discovery[0]!;
        const node = job.walker.nextNode();
        if (!node) this.discovery.shift();
        else if (node.nodeType === Node.TEXT_NODE && /[A-Za-z]/.test(node.textContent ?? '')) {
          // 空段落、缩进用的表格单元格和纯布局节点没有可分析文字，不占用每帧一个块的额度。
          const parent = node.parentElement;
          if (!parent || job.parents.has(parent)) continue;
          job.parents.add(parent);
          const block = parent.closest(BLOCKS);
          if (block) {
            // 一个块可包含许多行内 Text；同次重新发现只置脏一次，避免跨帧重复重绘。
            const reset = job.force && !job.reset.has(block);
            job.reset.add(block);
            this.registerBlock(block, reset);
          }
        }
      }
      for (const nearby of this.nearby) {
        if (!nearby.isConnected) this.nearby.delete(nearby);
        else this.enqueueBlock(nearby);
        if (this.pending.size >= MAX_PENDING) break;
      }
      // 连续滚动也需补齐预读区；限制批次频率，并先完成整批读取再写入，避免每段都触发全页重算。
      const settled = performance.now() - this.lastScrollAt >= PREFETCH_SETTLE_MS;
      const canRender = settled || !!this.intersections && performance.now() - this.lastRenderAt >= SCROLL_RENDER_INTERVAL_MS;
      let block = canRender ? this.pending.values().next().value as Element | undefined : undefined;
      // 预读区内优先补当前视口，再处理上下左右缓冲区。
      if (canRender) {
        for (const candidate of this.pending) {
          if (this.visible.has(candidate)) { block = candidate; break; }
        }
      }
      if (block) {
        const batch = [block, ...[...this.pending].filter(candidate => candidate !== block && this.visible.has(candidate)),
          ...[...this.pending].filter(candidate => candidate !== block && !this.visible.has(candidate))].slice(0, MAX_RENDER_BATCH);
        if (batch.some(candidate => this.root.contains(candidate))) {
          // 取走尚未派发的外部记录，避免 disconnect 丢失同时到达的页面更新。
          const records = this.observer?.takeRecords() ?? [];
          if (records.length) this.handleMutations(records);
          this.observer?.disconnect();
          for (const candidate of batch) if (this.root.contains(candidate)) this.restore(candidate);
          // 站点可能用 body:has(...) 等规则；交错读写会让每个单元格都重算同一棵大子树。
          const writes: Array<(() => void) | undefined> = [];
          const readStarted = performance.now();
          for (const candidate of batch) {
            this.pending.delete(candidate);
            if (!this.root.contains(candidate)) continue;
            const write = this.render(candidate, false, true);
            this.pendingVocabulary.delete(candidate);
            this.analyzed.add(candidate);
            writes.push(write);
            // 短单元格可合批；长段落达到预算后立即让出线程。
            if (performance.now() - readStarted >= RENDER_READ_BUDGET_MS) break;
          }
          for (const write of writes) write?.();
          this.lastRenderAt = performance.now();
          this.observe();
        } else for (const candidate of batch) this.pending.delete(candidate);
      }
      else {
        const vocabularyBlock = canRender ? this.pendingVocabulary.values().next().value as Element | undefined : undefined;
        if (vocabularyBlock) {
          this.observer?.disconnect();
          const batch = [...this.pendingVocabulary].sort((a, b) => Number(this.visible.has(b)) - Number(this.visible.has(a))).slice(0, MAX_RENDER_BATCH);
          const writes = batch.map(candidate => {
            this.pendingVocabulary.delete(candidate);
            if (this.root.contains(candidate) && (!this.intersections || this.nearby.has(candidate))) return this.render(candidate, true, true);
          });
          for (const write of writes) write?.();
          this.lastRenderAt = performance.now();
          this.observe();
        }
      }
      // 缓存近期离屏段落，往返直接复用同一 DOM；超过块数/原文长度上限才逐帧回收最早离开的段落。
      // 只撤逐词视觉层，保留原 Text 和生词分组，避免回收触发生词重建。
      const overCacheLimit = this.cachedOffscreen.size > MAX_CACHED_BLOCKS || this.cachedCharacters > MAX_CACHED_CHARACTERS;
      const retired = settled && overCacheLimit ? this.cachedOffscreen.keys().next().value as Element | undefined : undefined;
      if (retired) {
        this.forgetCachedBlock(retired);
        this.observer?.disconnect();
        this.restoreWords(retired);
        for (const original of this.groupsByBlock.get(retired) ?? []) {
          const wrapper = this.groups.get(original);
          for (const token of wrapper?.querySelectorAll(`${TAG}:not([data-group])`) ?? []) token.replaceWith(...token.childNodes);
        }
        this.analyzed.delete(retired);
        this.observe();
      }
      if (this.pending.size || this.discovery.length || this.pendingVocabulary.size
        || this.cachedOffscreen.size > MAX_CACHED_BLOCKS || this.cachedCharacters > MAX_CACHED_CHARACTERS) this.schedule();
    };
    // 写入之后等下一帧再读排版，防止多个定时切片在同一帧反复触发整页布局。
    const view = this.root.ownerDocument.defaultView;
    if (view?.requestAnimationFrame) this.frame = view.requestAnimationFrame(work);
    else this.timer = setTimeout(work, 4);
  }

  private discard(original: Text): void {
    detachTextDecoration(original, false);
    this.groups.get(original)?.remove();
    this.groups.delete(original);
    const block = this.blockOf.get(original);
    const entries = block && this.groupsByBlock.get(block);
    entries?.delete(original);
    if (block && entries?.size === 0) this.groupsByBlock.delete(block);
    this.blockOf.delete(original);
  }

  private restore(root: Element, descendants = false): void {
    const wordBlocks = root.matches(BLOCKS) && !descendants ? [root] : [...this.decoratedWords.keys()].filter(block => root.contains(block));
    for (const block of wordBlocks) this.restoreWords(block);
    // 正常重绘只遍历本段，避免每段都扫描全页累积组而退化为 O(n²)。
    const originals = root.matches(BLOCKS) && !descendants ? [...(this.groupsByBlock.get(root) ?? [])]
      : [...this.groupsByBlock].filter(([block]) => root.contains(block)).flatMap(([, entries]) => [...entries]);
    for (const original of originals) {
      const wrapper = this.groups.get(original);
      if (!wrapper) continue;
      if (!wrapper.isConnected && !root.contains(wrapper)) { this.discard(original); continue; }
      if (!root.contains(wrapper) && original.isConnected) continue;
      // 先还原生词引擎的切分组，再把视觉组的文字拼回原站点 Text。
      const walker = root.ownerDocument.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
      const owners: Text[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) if (hasFragments(node as Text)) owners.push(node as Text);
      owners.forEach(restoreGroup);
      if (original.isConnected || root.contains(original)) writeDecoratedText(original, original.data + (wrapper.textContent ?? ''));
      this.discard(original);
    }
  }

  private restoreWords(block: Element): void {
    for (const [word, snapshot] of this.decoratedWords.get(block) ?? []) {
      if (snapshot.style === null) word.removeAttribute('style'); else word.setAttribute('style', snapshot.style);
      WORD_ATTRIBUTES.forEach((name, index) => {
        const value = snapshot.attributes[index];
        if (value === null) word.removeAttribute(name); else word.setAttribute(name, value!);
      });
    }
    this.decoratedWords.delete(block);
  }

  private safe(block: Element): boolean {
    for (let el: Element | null = block; el; el = el.parentElement) {
      if (el.matches(this.excluded) || shouldSkipElement(el)) return false;
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
      if (el === this.root) break;
    }
    return true;
  }

  private render(block: Element, wordsOnly = false, deferWrite = false): (() => void) | undefined {
    if (!wordsOnly && !deferWrite) this.restore(block);
    if (!this.safe(block)) return;
    const scope = this.settings.scope;
    if (scope.skipHeadings && block.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')
      || scope.skipTables && block.closest('table,[role="table"],[role="grid"]')) return;
    const slices: TextSlice[] = [];
    const lineBreaks: number[] = [];
    const preservedWhitespace = new WeakMap<Element, boolean>();
    let text = '';
    const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          // 生词标记保留在上下文内，但绝不在其内部插入视觉包装。
          if (el.matches('hnw-mark,hnw-w')) return NodeFilter.FILTER_SKIP;
          // 自有视觉层的可见性继承正文，不逐词读取计算样式；仅同步生词时尤其重要。
          if (el.localName === TAG) return NodeFilter.FILTER_SKIP;
          if (el.localName === 'br') { lineBreaks.push(text.length); text += '\n'; return NodeFilter.FILTER_REJECT; }
          if (el.matches(this.excluded) || shouldSkipElement(el)) { text += ' '; return NodeFilter.FILTER_REJECT; }
          const style = el.ownerDocument.defaultView?.getComputedStyle(el);
          preservedWhitespace.set(el, /pre|break-spaces/.test(style?.whiteSpace ?? ''));
          if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') { text += ' '; return NodeFilter.FILTER_REJECT; }
          if (el !== block && el.matches(BLOCKS)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node: Node | null;
    let visited = 0;
    while ((node = walker.nextNode())) {
      if (++visited > MAX_BLOCK_NODES) return;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const t = node as Text;
      const parent = t.parentElement!;
      let preserve = preservedWhitespace.get(parent);
      if (preserve === undefined) {
        preserve = /pre|break-spaces/.test(parent.ownerDocument.defaultView?.getComputedStyle(parent).whiteSpace ?? '');
        preservedWhitespace.set(parent, preserve);
      }
      if (preserve) for (const match of t.data.matchAll(/\n/g)) lineBreaks.push(text.length + match.index);
      slices.push({ node: t, start: text.length, end: text.length + t.length, protected: !!t.parentElement?.closest('hnw-mark') });
      text += t.data;
      // 病态的单段/虚拟列表避免 NLP 同步工作无限增长，整段保持原样。
      if (text.length > MAX_BLOCK_LENGTH) return;
    }
    this.blockLengths.set(block, text.length);
    // 先过滤界面短标签和整块链接，再调用 NLP；行内链接仍保留在完整段落上下文中。
    if (scope.skipShortBlocks) {
      let words = 0;
      for (const _match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)) {
        if (++words >= scope.minWords) break;
      }
      if (words < scope.minWords) return;
    }
    if (scope.skipStandaloneLinks && slices.some(slice => /[A-Za-z]/.test(slice.node.data))
      && slices.every(slice => !/[A-Za-z0-9]/.test(slice.node.data) || slice.node.parentElement?.closest('a[href]'))) return;
    const ignored = ignoredReadingRanges(text, lineBreaks, slices.map(slice => ({ start: slice.start, end: slice.end, link: !!slice.node.parentElement?.closest('a[href]') })), scope);
    const tokens = analyzeReading(text, this.settings.syntax.enabled || this.settings.emphasis.properNouns)
      .filter(token => !ignored.some(range => token.start < range.end && token.end > range.start));
    const bionicTokens = new Set<ReadingToken>();
    let englishIndex = 0;
    for (const token of tokens) {
      if (!/^[A-Za-z]/.test(token.text)) continue;
      // 段内从首词开始计数；短英文词计入节奏，数字不计，同词跨 inline 只计一次。
      if (englishIndex++ % this.settings.bionic.interval === 0) bionicTokens.add(token);
    }
    const tokensBySlice = new Map<TextSlice, ReadingToken[]>();
    let tokenIndex = 0;
    for (const slice of slices) {
      while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= slice.start) tokenIndex++;
      const applicable: ReadingToken[] = [];
      for (let i = tokenIndex; i < tokens.length && tokens[i]!.start < slice.end; i++) applicable.push(tokens[i]!);
      tokensBySlice.set(slice, applicable);
    }
    const wrappedTokens = new Set<ReadingToken>();
    if (this.settings.bionic.enabled) {
      // 先批量读原文排版，再写视觉组；超长词跨行时保留站点断行，仅省略词首描粗。
      const range = block.ownerDocument.createRange();
      if (typeof range.getClientRects === 'function') {
        const availableWidth = block.getBoundingClientRect().width;
        const fontSizes = new Map<Element, number>();
        for (const slice of slices) {
          if (slice.protected) continue;
          const parent = slice.node.parentElement!;
          let fontSize = fontSizes.get(parent);
          if (fontSize === undefined) {
            fontSize = parseFloat(block.ownerDocument.defaultView!.getComputedStyle(parent).fontSize) || 16;
            fontSizes.set(parent, fontSize);
          }
          for (const token of tokensBySlice.get(slice)!) {
            if (!bionicTokens.has(token)) continue;
            if (token.end <= slice.start || token.start >= slice.end || token.text.length < this.settings.bionic.minLength) continue;
            // 一个英文字符按一 em 作保守上界；普通词无需逐词读取布局。
            if (availableWidth > 0 && token.text.length * fontSize < availableWidth) continue;
            range.setStart(slice.node, Math.max(token.start, slice.start) - slice.start);
            range.setEnd(slice.node, Math.min(token.end, slice.end) - slice.start);
            if (range.getClientRects().length > 1) wrappedTokens.add(token);
          }
        }
      }
    }
    const write = () => {
      const wordStyles = this.decoratedWords.get(block) ?? new Map<HTMLElement, WordSnapshot>();
      for (const [word] of wordStyles) if (!word.isConnected) wordStyles.delete(word);
      for (const slice of slices) {
        if (slice.protected) {
          if (this.settings.wordStylePriority !== 'reading') continue;
          const word = slice.node.parentElement?.closest<HTMLElement>('hnw-w');
          const token = tokensBySlice.get(slice)?.find(token => token.start <= slice.start && token.end >= slice.end);
          if (!word || !token || !slice.node.length) continue;
          const decorated = this.decorate(token, slice.node.data, slice.start, wrappedTokens.has(token), bionicTokens.has(token));
          if (!decorated) continue;
          if (!wordStyles.has(word)) wordStyles.set(word, { style: word.getAttribute('style'), attributes: WORD_ATTRIBUTES.map(name => word.getAttribute(name)) });
          // 覆盖生词的视觉通道，保留 DOM、事件、译文和词条属性；不在生词内部插入包装。
          // 阅读样式须一次呈现；沿用生词背景过渡会让预读单元格持续触发动画和样式重算。
          word.style.cssText = 'transition:none!important;color:inherit!important;background:transparent!important;box-shadow:none!important;outline:none!important;text-decoration:none!important;font-weight:inherit!important;font-style:inherit!important;-webkit-text-stroke:inherit!important';
          for (const property of Array.from(decorated.style)) word.style.setProperty(property, decorated.style.getPropertyValue(property), 'important');
          for (const name of WORD_ATTRIBUTES) word.removeAttribute(name);
          for (const name of WORD_ATTRIBUTES.slice(0, -1)) if (decorated.hasAttribute(name)) word.setAttribute(name, decorated.getAttribute(name)!);
          word.setAttribute('data-hnw-reading-word', '');
          continue;
        }
        if (wordsOnly) continue;
        const applicable = tokensBySlice.get(slice)!;
        if (!applicable.length) continue;
        const fragment = block.ownerDocument.createDocumentFragment();
        let cursor = 0;
        for (const token of applicable) {
          const start = Math.max(token.start, slice.start) - slice.start;
          const end = Math.min(token.end, slice.end) - slice.start;
          fragment.append(slice.node.data.slice(cursor, start));
          const value = slice.node.data.slice(start, end);
          const span = this.decorate(token, value, slice.start + start, wrappedTokens.has(token), bionicTokens.has(token));
          fragment.append(span ?? value);
          cursor = end;
        }
        fragment.append(slice.node.data.slice(cursor));
        if (!fragment.querySelector(TAG)) continue;
        // 原 Text 永远留在原位，页面框架仍可改写/删除其持有的节点。
        const wrapper = block.ownerDocument.createElement(TAG);
        wrapper.dataset.group = '';
        wrapper.append(fragment);
        writeDecoratedText(slice.node, '');
        slice.node.after(wrapper);
        this.groups.set(slice.node, wrapper);
        let entries = this.groupsByBlock.get(block);
        if (!entries) { entries = new Set(); this.groupsByBlock.set(block, entries); }
        entries.add(slice.node);
        this.blockOf.set(slice.node, block);
        registerTextDecoration(slice.node, wrapper);
      }
      if (wordStyles.size) this.decoratedWords.set(block, wordStyles);
    };
    if (deferWrite) return write;
    write();
  }

  private decorate(token: ReadingToken, value: string, offset: number, wrapped: boolean, emphasizePrefix: boolean): HTMLElement | undefined {
    const s = this.settings;
    const pos = s.syntax.enabled && token.pos && s.syntax[`${token.pos}s`] ? token.pos : undefined;
    const emphasis = token.emphasis && s.emphasis[token.emphasis] ? token.emphasis
      : token.properNoun && s.emphasis.properNouns ? 'properNouns' : undefined;
    const bionic = s.bionic.enabled && emphasizePrefix && !wrapped && /^[A-Za-z]/.test(token.text) && token.text.length >= s.bionic.minLength;
    if (!pos && !emphasis && !bionic) return;
    const span = this.root.ownerDocument.createElement(TAG);
    span.style.display = 'inline';
    const channels = new Map<string, { mode: ReadingMarkStyle; color: string }>();
    if (pos) {
      span.dataset.pos = pos;
      const mode = s.syntax.modes[pos] ?? s.syntax.mode;
      channels.set(STYLE_CHANNELS[mode], { mode, color: s.syntax.colors[pos] });
    }
    if (emphasis) {
      span.dataset.emphasis = emphasis;
      const style = s.emphasis.styles[emphasis];
      channels.set(STYLE_CHANNELS[style.mode], style);
    }
    for (const { mode, color } of channels.values()) {
      if (mode === 'color') span.style.color = color;
      else if (mode === 'underline' || mode === 'dotted' || mode === 'wavy') {
        span.style.textDecorationLine = 'underline';
        span.style.textDecorationStyle = mode === 'underline' ? 'solid' : mode;
        span.style.textDecorationColor = color;
        span.style.textUnderlineOffset = '3px';
      } else if (mode === 'background' || mode === 'marker') {
        // 透明底色不更改原文字色，也不加 padding/border，保持行宽和原站断行。
        if (mode === 'background') span.style.backgroundColor = `${color}33`;
        else span.style.backgroundImage = `linear-gradient(transparent 55%, ${color}55 55%, ${color}55 95%, transparent 95%)`;
        span.style.setProperty('box-decoration-break', 'clone');
        span.style.setProperty('-webkit-box-decoration-break', 'clone');
      } else {
        // 用原字形描边加粗，配置色只进入描边，避免 native bold 改变字宽/链接字色。
        span.style.setProperty('-webkit-text-stroke', `0.35px ${color}`);
      }
    }
    const boldEnd = token.start + Math.max(1, Math.ceil(token.text.length * Math.min(1, Math.max(0.1, s.bionic.ratio))));
    const boldLength = bionic ? Math.min(value.length, Math.max(0, boldEnd - offset)) : 0;
    if (boldLength) {
      span.dataset.bionic = '';
      span.dataset.prefix = value.slice(0, boldLength);
    }
    span.textContent = value;
    return span;
  }
}
