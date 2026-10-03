import { browser } from 'wxt/browser';
import { sendToBackground } from '@/core/messaging';
import type { StatusSummary } from '@/core/messaging/protocol';
import { INLINE_MODE_LABELS, INLINE_MODE_ORDER, INLINE_TRANSLATION_NAME } from '@/core/settings/inline-translation-labels';
import type { InlineTranslationMode, Settings } from '@/core/settings/schema';
import { isSiteDisabled, saveSettings } from '@/core/settings/store';
import { markStyleToCss, resolveMarkStyle } from '@/core/theme/resolve';
import { DefaultWordBookRegistry, createExtensionLoaders } from '@/core/wordbook/registry';
import type { BookMeta } from '@/core/wordbook/types';
// 与 popup / 选项页共用的纯逻辑：预设切换（含按词书重新着色）、站点规则、词书启用切换、释义截短
import { applyPreset, presetGroups } from '../../entrypoints/options/lib/appearance';
import { oneLineMeaning, solidSwatch, toggleEnabledBook, toggleSiteRule } from '../../entrypoints/popup/model';
import { h } from '../card/h';
import { ATTR_BOOK, ATTR_LEMMA, TAG_MARK } from '../engine/dom';
import { markSurface } from '../engine/highlighter';
import { isYouTubeHost } from '../sites/youtube/dom';
import type { SiteContext } from '../sites/types';
import { bindSheetDrag, type OverlayHost } from './host';
import { svgIcon, type FloatIcon } from './icons';
import { syncFootText, toggleHostRule } from './model';
import { availableFloatActions } from './registry';

type Tab = 'words' | 'settings';

// 行内译文模式：与选项页、引导、popup 同一组短标签（core/settings/inline-translation-labels）
const INLINE_MODES: Array<{ value: InlineTranslationMode; label: string }> = INLINE_MODE_ORDER.map((value) => ({ value, label: INLINE_MODE_LABELS[value] }));
const CAPTION_MODES: Array<{ value: Settings['youtube']['captionTranslation']; label: string }> = [
  { value: 'above', label: '上方' },
  { value: 'below', label: '下方' },
  { value: 'after', label: '词后' },
  { value: 'off', label: '只高亮' },
];

const STATUS_POLL_MS = 1500;

export interface MenuDeps {
  ctx: SiteContext;
  overlay: OverlayHost;
  /** 取词模式状态与切换 */
  isPicking(): boolean;
  togglePick(): void;
  /** 打开完整设置（hash 为选项页路由） */
  openOptions(hash?: string): void;
  /** 悬浮球被隐藏（本站或全局）后的回调 */
  onHidden(): void;
}

/**
 * 悬浮球菜单（底部抽屉）：
 * - 顶部功能块：站点功能项（如 YouTube“当前字幕”）、取词模式、本站高亮开关
 * - 标签页：本页生词（点开卡片 / 认识）｜快捷设置（行内译文、样式预设、词书、字幕译文、悬浮球隐藏）
 * - 底栏：同步状态（点按立即同步全部）、完整设置
 * 设置写入直接改 storage 中的 settings（与 popup 同一份数据），熟词与同步走 background 消息。
 */
export class FloatMenu {
  private scrim: HTMLElement | null = null;
  private sheet: HTMLElement | null = null;
  private tab: Tab = 'words';
  private books: BookMeta[] | null = null;
  private status: StatusSummary | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private syncing = false;
  private hideOpen = false;
  /** 生词短释义缓存 */
  private readonly meanings = new Map<string, string>();

  constructor(private readonly deps: MenuDeps) {}

  get isOpen(): boolean {
    return !!this.sheet;
  }

  open(): void {
    if (this.sheet) return;
    const doc = this.deps.ctx.doc;
    this.deps.overlay.ensureMounted();
    // 打开时按当前网页背景重新判定深浅色（与卡片一致；页面可能在加载后切换了深浅主题）
    this.deps.overlay.setTheme(this.deps.ctx.getSettings());
    this.scrim = h(doc, 'div', { class: 'scrim', onclick: () => this.close() });
    this.sheet = h(doc, 'div', { class: 'sheet', role: 'dialog', 'aria-label': '生词高亮菜单' });
    this.deps.overlay.ui.append(this.scrim, this.sheet);
    this.hideOpen = false;
    this.render();
    requestAnimationFrame(() => {
      this.scrim?.classList.add('in');
      this.sheet?.classList.add('in');
    });
    void this.loadStatus();
    void this.loadBooks();
  }

  close(): void {
    clearTimeout(this.statusTimer);
    const { scrim, sheet } = this;
    this.scrim = null;
    this.sheet = null;
    if (!sheet) return;
    scrim?.classList.remove('in');
    sheet.classList.remove('in');
    setTimeout(() => {
      scrim?.remove();
      sheet.remove();
    }, 220);
  }

  /** 设置变化时刷新（菜单打开中） */
  refresh(): void {
    if (this.sheet) this.render();
  }

  /** 重绘抽屉；默认保留内容区滚动位置（设置变化、释义加载完成时不跳动），切换标签时 resetScroll 回到顶部 */
  private render({ resetScroll = false }: { resetScroll?: boolean } = {}): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const doc = this.deps.ctx.doc;
    const scrollTop = resetScroll ? 0 : (sheet.querySelector('.body')?.scrollTop ?? 0);
    const grab = h(doc, 'div', { class: 'grab', 'aria-hidden': 'true' });
    const head = h(
      doc,
      'div',
      { class: 'head' },
      h(doc, 'div', { class: 'title' }, '生词高亮', h(doc, 'span', { class: 'sub' }, location.hostname)),
      this.iconButton('close', '关闭', () => this.close()),
    );
    // 功能块与标签栏固定在上方，只有标签页内容滚动（滚动区域从标签栏下方开始，内容不会滚到标签栏下面被截一半）
    const top = h(doc, 'div', { class: 'top' }, this.renderTiles(), this.renderTabs());
    const body = h(doc, 'div', { class: 'body' }, this.tab === 'words' ? this.renderWords() : this.renderSettings());
    sheet.replaceChildren(grab, head, top, body, this.renderFoot());
    body.scrollTop = scrollTop;
    bindSheetDrag(sheet, grab, () => this.close());
    bindSheetDrag(sheet, head.querySelector('.title') as HTMLElement, () => this.close());
  }

  private iconButton(name: FloatIcon, label: string, onclick: () => void): HTMLButtonElement {
    return h(this.deps.ctx.doc, 'button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, onclick }, svgIcon(this.deps.ctx.doc, name));
  }

  // ---------------- 功能块 ----------------

  private renderTiles(): HTMLElement {
    const doc = this.deps.ctx.doc;
    const s = this.deps.ctx.getSettings();
    const siteOn = s.enabled && !isSiteDisabled(s, location.hostname);
    const tile = (icon: FloatIcon, title: string, sub: string, on: boolean, onclick: () => void) =>
      h(doc, 'button', { type: 'button', class: `tile${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick },
        h(doc, 'span', { class: 'ic' }, svgIcon(doc, icon)),
        h(doc, 'span', {}, h(doc, 'b', {}, title), h(doc, 'small', {}, sub)),
      );
    const siteTiles = availableFloatActions().map((a) =>
      tile('captions', a.label, a.hint ?? '', false, () => {
        this.close();
        a.run();
      }),
    );
    const picking = this.deps.isPicking();
    return h(
      doc,
      'div',
      { class: 'tiles' },
      ...siteTiles,
      tile('pick', '取词模式', picking ? '已开启 · 点按单词查词' : '点按任意单词查词；也可直接长按单词', picking, () => {
        this.close();
        this.deps.togglePick();
      }),
      tile('logo', '本站高亮', !s.enabled ? '已全局暂停' : siteOn ? '已开启' : '已关闭', siteOn, () =>
        this.update((n) => {
          if (!n.enabled) n.enabled = true;
          else n.sites.disabled = toggleSiteRule(n.sites.disabled, location.hostname, !siteOn);
        }),
      ),
    );
  }

  private renderTabs(): HTMLElement {
    const doc = this.deps.ctx.doc;
    const count = this.deps.ctx.pageLemmas().length;
    const tab = (id: Tab, label: string) =>
      h(doc, 'button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(this.tab === id), onclick: () => {
        if (this.tab === id) return;
        this.tab = id;
        // 切换标签：新标签页从顶部开始（沿用旧标签的滚动位置会让首行停在标签栏下沿，看上去被遮住一半）
        this.render({ resetScroll: true });
      } }, label);
    return h(doc, 'div', { class: 'tabs', role: 'tablist' }, tab('words', `本页生词${count ? ` ${count}` : ''}`), tab('settings', '快捷设置'));
  }

  // ---------------- 本页生词 ----------------

  private renderWords(): HTMLElement {
    const doc = this.deps.ctx.doc;
    const { ctx } = this.deps;
    const s = ctx.getSettings();
    if (!ctx.isActive()) {
      return h(doc, 'div', { class: 'empty' }, s.enabled ? '本站已关闭高亮，点上方“本站高亮”开启' : '高亮已全局暂停，点上方“本站高亮”恢复');
    }
    const lemmas = ctx.pageLemmas();
    if (lemmas.length === 0) return h(doc, 'div', { class: 'empty' }, '本页暂无生词');
    const missing = lemmas.filter((l) => !this.meanings.has(l));
    if (missing.length > 0) {
      void ctx.lookupMany(missing).then((found) => {
        for (const l of missing) this.meanings.set(l, oneLineMeaning(found.get(l)?.short, 24));
        if (this.tab === 'words') this.render();
      });
    }
    return h(
      doc,
      'ul',
      { class: 'words' },
      lemmas.map((lemma) => {
        const mark = this.findMark(lemma);
        const surface = mark ? markSurface(mark) : lemma;
        return h(
          doc,
          'li',
          { class: 'word' },
          h(doc, 'button', { type: 'button', class: 'open', onclick: () => this.openWord(lemma) },
            // 色点取该词主词书的高亮颜色（按词书分色时各不相同）
            h(doc, 'span', { class: 'dot', style: `background:${solidSwatch(resolveMarkStyle(s, mark?.getAttribute(ATTR_BOOK) ?? undefined))}` }),
            h(doc, 'span', { class: 'w' }, lemma),
            h(doc, 'span', { class: 'm' }, this.meanings.get(lemma) ?? ''),
          ),
          h(doc, 'button', { type: 'button', class: 'known', onclick: () => void this.markKnown(lemma, surface) }, '认识'),
        );
      }),
    );
  }

  private findMark(lemma: string): HTMLElement | null {
    return this.deps.ctx.doc.querySelector<HTMLElement>(`${TAG_MARK}[${ATTR_LEMMA}="${CSS.escape(lemma)}"]`);
  }

  /** 点生词：关菜单，滚到页面上第一个可见的该词，再打开卡片 */
  private openWord(lemma: string): void {
    const marks = [...this.deps.ctx.doc.querySelectorAll<HTMLElement>(`${TAG_MARK}[${ATTR_LEMMA}="${CSS.escape(lemma)}"]`)];
    const mark = marks.find((m) => m.getClientRects().length > 0) ?? marks[0];
    this.close();
    if (!mark) return;
    const r = mark.getBoundingClientRect();
    const inView = r.top >= 60 && r.bottom <= innerHeight * 0.5;
    if (!inView) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 平滑滚动结束后再开卡片（手机底部卡片会把视口下半部分遮住，滚到中间偏上）
    setTimeout(() => this.deps.ctx.openCard(mark), inView ? 0 : 420);
  }

  private async markKnown(lemma: string, surface: string): Promise<void> {
    const { ctx, overlay } = this.deps;
    try {
      const res = await ctx.markKnown(lemma, surface);
      this.render();
      overlay.toast(res.ok ? `“${lemma}”已标为熟词` : res.message || '标记失败', res.ok ? { label: '撤销', run: () => void ctx.unmarkKnown(lemma) } : undefined, { up: this.isOpen });
    } catch (e) {
      overlay.toast(`标记失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------------- 快捷设置 ----------------

  private renderSettings(): HTMLElement {
    const doc = this.deps.ctx.doc;
    const s = this.deps.ctx.getSettings();
    const groups: HTMLElement[] = [];
    const group = (title: string, ...children: HTMLElement[]) => h(doc, 'div', { class: 'group' }, h(doc, 'h4', {}, title), ...children);
    const seg = <T extends string>(items: Array<{ value: T; label: string }>, current: T, set: (v: T) => void) =>
      h(doc, 'div', { class: 'seg', role: 'group' },
        items.map((it) => h(doc, 'button', { type: 'button', 'aria-pressed': String(it.value === current), onclick: () => set(it.value) }, it.label)),
      );

    groups.push(group(INLINE_TRANSLATION_NAME, seg(INLINE_MODES, s.inlineTranslation.mode, (v) => this.update((n) => void (n.inlineTranslation.mode = v)))));

    if (isYouTubeHost(location.hostname)) {
      groups.push(
        group('字幕中的生词译文', seg(CAPTION_MODES, s.youtube.captionTranslation, (v) => this.update((n) => void (n.youtube.captionTranslation = v)))),
      );
    }

    // 样式预设：当前预设排在最前，横向滚动
    const presets = presetGroups().main;
    const current = s.style.themeId;
    const ordered = [...presets.filter((p) => p.id === current), ...presets.filter((p) => p.id !== current)];
    groups.push(
      group('高亮样式',
        h(doc, 'div', { class: 'chips' },
          ordered.map((p) =>
            h(doc, 'button', { type: 'button', class: 'chip', 'aria-pressed': String(p.id === current), onclick: () => this.update((n) => applyPreset(n, p.id)) },
              h(doc, 'span', { class: 'sw', style: markStyleToCss(p.mark) }, 'Aa'),
              p.name,
            ),
          ),
        ),
      ),
    );

    // 词书：已启用的在前
    const books = this.books;
    if (books) {
      const enabled = new Set(s.books.enabled);
      const sorted = [...books.filter((b) => enabled.has(b.id)), ...books.filter((b) => !enabled.has(b.id))];
      groups.push(
        group('词书（可多选，难度/词频分级各选一档）',
          h(doc, 'div', { class: 'chips' },
            sorted.map((b) =>
              h(doc, 'button', { type: 'button', class: 'chip', 'aria-pressed': String(enabled.has(b.id)), onclick: () =>
                this.update((n) => void (n.books.enabled = toggleEnabledBook(n.books.enabled, b.id, !enabled.has(b.id), books))) },
                b.short || b.name,
                h(doc, 'span', { class: 'n' }, formatSize(b.size)),
              ),
            ),
          ),
        ),
      );
    }

    groups.push(
      group('悬浮球',
        h(doc, 'div', { class: 'hide-menu' },
          h(doc, 'button', { type: 'button', class: 'btn', onclick: () => this.hideBall('site') }, svgIcon(doc, 'hide', 18), '在本站隐藏'),
          h(doc, 'button', { type: 'button', class: 'btn', onclick: () => this.hideBall('all') }, '在所有网站关闭悬浮球'),
        ),
      ),
    );
    return h(doc, 'div', {}, ...groups);
  }

  private hideBall(scope: 'site' | 'all'): void {
    this.update((n) => {
      if (scope === 'all') n.floatBall.enabled = false;
      else n.floatBall.hiddenSites = toggleHostRule(n.floatBall.hiddenSites, location.hostname, true);
    });
    this.close();
    // 悬浮球隐藏后手机上就没有入口了：toast 带“撤销”立即恢复，并写明设置中的恢复位置（选项页“更多 › 悬浮球”）
    const undo = () =>
      this.update((n) => {
        if (scope === 'all') n.floatBall.enabled = true;
        else n.floatBall.hiddenSites = toggleHostRule(n.floatBall.hiddenSites, location.hostname, false);
      });
    this.deps.overlay.toast(
      scope === 'all' ? '已关闭悬浮球（可在设置 › 更多 › 悬浮球 中重新开启）' : '已在本站隐藏悬浮球（可在设置 › 更多 › 悬浮球 中恢复）',
      { label: '撤销', run: undo },
    );
    this.deps.onHidden();
  }

  /** 修改设置并写入（基于当前设置的副本，写入后由 app 的 storage 监听推送到页面） */
  private update(mutate: (next: Settings) => void): void {
    const next = structuredClone(this.deps.ctx.getSettings());
    mutate(next);
    void saveSettings(next);
  }

  private async loadBooks(): Promise<void> {
    try {
      this.books = await new DefaultWordBookRegistry(createExtensionLoaders()).list();
      if (this.tab === 'settings') this.render();
    } catch {
      this.books = [];
    }
  }

  // ---------------- 同步状态 ----------------

  private renderFoot(): HTMLElement {
    const doc = this.deps.ctx.doc;
    const st = this.status;
    const busy = this.syncing || !!st?.syncAll?.running;
    const { level, text } = busy ? { level: 'busy', text: '正在同步…' } : st ? syncFootText(st) : { level: 'off', text: '读取同步状态…' };
    return h(
      doc,
      'div',
      { class: 'foot' },
      h(doc, 'button', { type: 'button', class: 'sync', title: '立即同步全部', onclick: () => this.onSyncClick() },
        h(doc, 'span', { class: `st ${level}` }),
        h(doc, 'span', { class: 'tx' }, text),
      ),
      h(doc, 'button', { type: 'button', class: 'btn small', onclick: () => {
        this.close();
        this.deps.openOptions();
      } }, svgIcon(doc, 'settings', 18), '完整设置'),
    );
  }

  private async loadStatus(): Promise<void> {
    try {
      this.status = await sendToBackground('getStatusSummary', {});
    } catch {
      this.status = null;
    }
    if (!this.sheet) return;
    this.render();
    // 同步进行中时轮询进度
    if (this.status?.syncAll?.running || this.status?.items.some((i) => i.level === 'busy')) {
      clearTimeout(this.statusTimer);
      this.statusTimer = setTimeout(() => void this.loadStatus(), STATUS_POLL_MS);
    }
  }

  /** 点同步状态：有需要处理的项（未登录、授权失效）时去选项页对应位置，否则立即同步全部 */
  private onSyncClick(): void {
    const problem = this.status?.items.find((i) => i.level === 'error' || i.level === 'never');
    if (problem) {
      this.close();
      this.deps.openOptions(problem.href);
      return;
    }
    void this.syncAll();
  }

  private async syncAll(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.render();
    try {
      // background=true：立即返回，同步在后台继续（与 popup 相同），这里轮询总状态
      await sendToBackground('syncAll', { background: true });
    } catch (e) {
      this.deps.overlay.toast(`同步失败：${e instanceof Error ? e.message : String(e)}`, undefined, { up: true });
    } finally {
      this.syncing = false;
    }
    await this.loadStatus();
  }
}

function formatSize(n: number): string {
  if (!n) return '';
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

/**
 * 打开选项页：内容脚本不能调用 runtime.openOptionsPage，也不能直接打开扩展页面（非 web_accessible 资源会被拦截为错误页），
 * 只能请 background 打开（`openOptions` 消息，见 release/issues.md 中交给 background 的条目）。
 * 返回是否已打开；background 尚未实现时返回 false，由调用方提示用户从扩展菜单进入。
 */
export async function openOptionsPage(hash = ''): Promise<boolean> {
  try {
    const res = (await browser.runtime.sendMessage({ ns: 'hnw', type: 'openOptions', data: { hash: hash.replace(/^#/, '') } })) as { ok?: boolean } | undefined;
    return !!res?.ok;
  } catch {
    return false;
  }
}
