import { browser } from 'wxt/browser';
import type { CardModifierKey, CardTrigger } from '@/core/settings/schema';
import { STORAGE_KEYS } from '@/core/storage/keys';
import { TAG_MARK } from '../engine/dom';
import { cardTriggerHintText, isMacPlatform, resolveCardTrigger, triggerSignature, type ResolvedCardTrigger } from './trigger-config';
import type { CardView } from './types';

/** 打开来源：hover 悬停、modifier 修饰键 + 悬停、click 鼠标点击、tap 触屏点按 */
export type CardOpenVia = 'hover' | 'modifier' | 'click' | 'tap';

/** “已提示过的触发方式”存取（缺省为 storage.local `cardTriggerHint`；测试或不需要提示时可替换/关闭） */
export interface TriggerHintStore {
  load(): Promise<string | undefined>;
  save(signature: string): Promise<void>;
}

export interface TriggerOptions {
  doc: Document;
  view: CardView;
  getTrigger(): CardTrigger;
  /** trigger='modifier' 时按住的修饰键（v11 新增；缺省按 alt） */
  getModifier?(): CardModifierKey | undefined;
  /** 悬停弹卡延迟 ms（settings.card.hoverDelay；缺省 DEFAULT_HOVER_SHOW_DELAY） */
  getHoverDelay?(): number | undefined;
  /** 触屏点按页面生词是否打开卡片（settings.card.tapOpen；缺省开启） */
  getTapOpen?(): boolean;
  /** 需要打开卡片时回调（入口负责组装数据并调用 view.open）；锚点可以是 hnw-mark 或触发区域（registerCardTriggerZone）返回的元素 */
  onOpen(mark: HTMLElement, via: CardOpenVia): void;
  /** PC 端卡片首次出现时的触发方式提示；false 关闭（缺省用 storage.local） */
  hintStore?: TriggerHintStore | false;
  /** 是否 macOS（缺省按 navigator 判断；测试用） */
  mac?: boolean;
}

/**
 * 额外的触发区域（供 floatball/站点适配层复用通用触发逻辑，如 YouTube 字幕面板 Shadow DOM 中的单词按钮）。
 * 注册后，所有 bindCardTrigger 绑定都会在 hnw-mark 之外再问一遍区域：悬停/修饰键/点击/触屏点按的规则完全一致。
 */
export interface CardTriggerZone {
  /**
   * 事件对应的卡片锚点：带 `data-lemma`/`data-books` 的元素（与 SiteContext.openCard 锚点约定一致），不是单词返回 null。
   * 在事件派发期间调用，可用 `e.composedPath()` 穿透 open Shadow DOM，也可按 PointerEvent 坐标做几何命中。
   */
  anchorOf(e: Event): HTMLElement | null;
  /** 指针/点按落在区域内（如面板空白处）时视同在卡片上：不因“移出”而关闭卡片，按下也不关闭 */
  contains?(e: Event): boolean;
  /**
   * 是否需要在 pointermove 时重新命中（默认 false，只看 pointerover）。
   * 单词被透明层盖住、pointerover 拿不到单词时（如 YouTube 控件层压在字幕上）设为 true，anchorOf 按坐标判断；pointermove 按帧节流。
   */
  hitTestOnMove?: boolean;
}

const zones = new Set<CardTriggerZone>();

/** 注册触发区域，返回注销函数 */
export function registerCardTriggerZone(zone: CardTriggerZone): () => void {
  zones.add(zone);
  return () => zones.delete(zone);
}

/**
 * 悬停显示延迟缺省值（ms）：实际值读 settings.card.hoverDelay（100/250/400，默认 250）。
 * 旧版 100ms 在指针扫过段落时容易误弹卡片，默认放宽到 250ms
 */
const DEFAULT_HOVER_SHOW_DELAY = 250;
const HOVER_HIDE_DELAY = 250;
/** 首次提示至少可见这么久（ms）才算“已看到”并记下；不到就关闭的卡片下次仍提示 */
const HINT_SEEN_MS = 1000;
/**
 * 指针已在单词上、再按下修饰键时的显示延迟（ms）：比悬停稍长，留出判断“组合键”的时间
 * （Ctrl+C、Alt+Tab 等在修饰键之后很快按下第二个键，这类按键不弹卡片）
 */
const KEY_SHOW_DELAY = 180;

const MODIFIER_KEYS: Record<CardModifierKey, string[]> = {
  alt: ['Alt', 'AltGraph'],
  ctrl: ['Control'],
  shift: ['Shift'],
  meta: ['Meta', 'OS'],
};
const ALL_MODIFIER_KEYS = new Set(Object.values(MODIFIER_KEYS).flat());

type ModifierFlags = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey'>;

/** 只按着指定的修饰键（其他修饰键都没按）：Ctrl+Alt、Ctrl+Shift 等组合不算 */
function onlyModifier(e: ModifierFlags, m: CardModifierKey): boolean {
  return e.altKey === (m === 'alt') && e.ctrlKey === (m === 'ctrl') && e.shiftKey === (m === 'shift') && e.metaKey === (m === 'meta');
}

const anyModifier = (e: ModifierFlags) => e.altKey || e.ctrlKey || e.shiftKey || e.metaKey;
/** 浏览器“在新标签/新窗口打开链接”的修饰键：Ctrl（Windows/Linux）、⌘（macOS）、Shift（新窗口） */
const newTabModifier = (e: ModifierFlags) => e.ctrlKey || e.metaKey || e.shiftKey;
const NEW_TAB_KEYS = new Set(['Control', 'Meta', 'OS', 'Shift']);

/** 事件目标是否在带 href 的链接内（composedPath 可穿透 open Shadow DOM，如字幕面板中的链接） */
function inLink(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof Element && n.matches('a[href]'));
}

/** 焦点在可编辑区域（输入框、富文本编辑器）：此时按 Shift/Alt 多半是在打字，不弹卡片 */
function isEditing(doc: Document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** 缺省提示存取：storage.local `cardTriggerHint`（按设备记忆，不参与同步） */
const storageHintStore: TriggerHintStore = {
  async load() {
    const v = (await browser.storage.local.get(STORAGE_KEYS.cardTriggerHint))[STORAGE_KEYS.cardTriggerHint];
    return typeof v === 'string' ? v : undefined;
  },
  async save(signature) {
    await browser.storage.local.set({ [STORAGE_KEYS.cardTriggerHint]: signature });
  },
};

/**
 * 卡片触发逻辑。触屏（pointerType 不是 mouse）始终点按，PC 端鼠标按 settings.card.trigger：
 *
 * - 悬停（auto/hover）：鼠标悬停单词 hoverDelay（默认 250ms，可选 100/400）后打开；离开单词与卡片 250ms 后关闭（在卡片内点过之后不再因移出而关闭）
 * - 修饰键 + 悬停（modifier）：只按着设定的修饰键时，指针移入单词 hoverDelay 后打开；指针已在单词上再按下修饰键，180ms 后打开。
 *   修饰键与其他键/鼠标按下/滚轮组合（Ctrl+C、Ctrl+点击开新标签、Ctrl+滚轮缩放、Alt+Tab）时本次按住作废，直到松开；
 *   焦点在输入框时按键不触发。打开过卡片的那次按住，松开时吞掉 keyup，避免 Windows 上单按 Alt 激活浏览器菜单。
 *   关闭规则与悬停相同（松开修饰键不关闭，移出后关闭）
 * - 点击（click）：点击单词打开并阻止默认行为（链接中的单词不跳转）；同一单词卡片已打开时再点一次放行（跳转链接）；
 *   带任一修饰键的点击（Ctrl/⌘ 新标签、Shift 新窗口、Alt 下载）完全交给浏览器；拖选文字结束的点击不弹卡片
 * - 触屏点按：打开卡片并阻止默认行为；再次点按同一单词放行
 * - 鼠标在卡片外按下 / 触屏在卡片外点按（click，滑动滚动不会触发）/ Esc 关闭
 * - 带 Ctrl/⌘/Shift 在链接内按下鼠标（新标签/新窗口打开链接，#113）：关闭卡片、取消待打开的计时，
 *   直到这些修饰键松开都不再弹卡片，避免链接在新标签打开后卡片还留在原页；点击照常交给浏览器
 * - PC 端卡片首次出现时在卡片内提示一次当前触发方式（方式变化后再提示一次），见 CardView.showHint；
 *   提示可见满 1s 或用户与卡片交互（在卡片内按下）后才记为“已提示”，一闪而过的卡片下次仍提示（#114）
 * - 页面滚动由 CardView 自己处理（浮层跟随单词、单词离开视口关闭；手机底部卡片保持打开）
 * 返回解绑函数。
 */
export function bindCardTrigger(opts: TriggerOptions): () => void {
  const { doc, view } = opts;
  const mac = opts.mac ?? isMacPlatform();
  const hintStore = opts.hintStore === false ? null : (opts.hintStore ?? storageHintStore);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最近一次 pointerdown 的指针类型，用于在 click 中区分触屏与鼠标 */
  let lastPointerType = 'mouse';
  /**
   * 用户在卡片内按下过鼠标（点了按钮、展开了面板）后，该卡片“钉住”：鼠标移出不再自动关闭，
   * 只由点外部 / Esc / 关闭按钮关闭。否则面板收起导致卡片变矮、指针落到卡片外时会被误关。
   */
  let pinnedAnchor: HTMLElement | null = null;
  /** 鼠标当前所在的单词（任何模式都记录，修饰键模式下按键时据此打开） */
  let hoverAnchor: HTMLElement | null = null;
  /** 本次按住修饰键已与其他键/鼠标组合（快捷键），松开前不再触发 */
  let chord = false;
  /** 本次按住修饰键打开过卡片（松开时吞掉 keyup） */
  let openedByHold = false;
  /** 带新标签修饰键点了链接（#113）：Ctrl/⌘/Shift 松开前不弹卡片 */
  let newTabHold = false;
  /** 已提示过（已记下）的触发方式签名；undefined = 尚未读到（读到前不提示，避免重复） */
  let hintedSig: string | undefined;
  /** 已显示、但还没确认用户看到的提示：可见满 HINT_SEEN_MS 或在卡片内交互后才写入 hintStore */
  let pendingHint: { sig: string; anchor: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
  let hintLoaded = !hintStore;
  hintStore?.load().then(
    (v) => {
      hintedSig = v;
      hintLoaded = true;
    },
    () => {},
  );

  const resolved = (): ResolvedCardTrigger => resolveCardTrigger({ trigger: opts.getTrigger(), modifier: opts.getModifier?.() }, mac);

  const anchorOf = (e: Event): HTMLElement | null => {
    const t = e.target;
    const mark = t instanceof Element ? t.closest<HTMLElement>(TAG_MARK) : null;
    if (mark) return mark;
    for (const z of zones) {
      const a = z.anchorOf(e);
      if (a) return a;
    }
    return null;
  };
  /** 在卡片内或在注册区域的“保持打开”范围内 */
  const insideCard = (e: Event): boolean => view.contains(e) || [...zones].some((z) => z.contains?.(e));

  /** 确认用户看到了提示：记下签名，之后不再提示同一方式 */
  const commitHint = () => {
    if (!pendingHint) return;
    clearTimeout(pendingHint.timer);
    hintedSig = pendingHint.sig;
    pendingHint = null;
    void hintStore?.save(hintedSig).catch(() => {});
  };

  /**
   * PC 端打开后提示一次当前方式。显示时先不记下：悬停模式下卡片常一闪而过，用户还没看到提示就关了（#114）。
   * 提示 1s 后卡片仍为同一单词打开才记下（期间在卡片内按下也算看到，见 onPointerDown）；否则下次打开再提示
   */
  const maybeHint = (anchor: HTMLElement, t: ResolvedCardTrigger) => {
    if (!hintStore || !hintLoaded || !view.showHint) return;
    const sig = triggerSignature(t);
    if (hintedSig === sig || !view.isOpen || view.anchor !== anchor) return;
    // 上一条未确认的提示随卡片换词已消失（CardView 换词清除提示），作废其计时
    if (pendingHint) clearTimeout(pendingHint.timer);
    view.showHint(cardTriggerHintText(t, mac));
    const timer = setTimeout(() => {
      if (view.isOpen && view.anchor === anchor) commitHint();
      else pendingHint = null;
    }, HINT_SEEN_MS);
    pendingHint = { sig, anchor, timer };
  };

  const openNow = (anchor: HTMLElement, via: CardOpenVia) => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pinnedAnchor = null;
    opts.onOpen(anchor, via);
    if (via !== 'tap') maybeHint(anchor, resolved());
  };

  const scheduleOpen = (anchor: HTMLElement, via: CardOpenVia, delay: number) => {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (via === 'modifier') openedByHold = true;
      openNow(anchor, via);
    }, delay);
  };

  /** 鼠标指向的单词变化（pointerover，或区域要求的 pointermove 命中） */
  const onHoverTarget = (anchor: HTMLElement | null, e: PointerEvent) => {
    const t = resolved();
    if (anchor) {
      clearTimeout(hideTimer);
      if (t.mode === 'click') return;
      if (view.anchor === anchor && view.isOpen) return;
      // 新标签修饰键已松开但 keyup 没收到（如焦点切走）时，以指针事件上的修饰键状态为准解除
      if (newTabHold && !newTabModifier(e)) newTabHold = false;
      if (newTabHold) {
        clearTimeout(showTimer);
        return;
      }
      if (t.mode === 'modifier' && (chord || !onlyModifier(e, t.modifier))) {
        clearTimeout(showTimer);
        return;
      }
      scheduleOpen(anchor, t.mode, opts.getHoverDelay?.() ?? DEFAULT_HOVER_SHOW_DELAY);
    } else if (insideCard(e)) {
      clearTimeout(hideTimer);
    } else {
      clearTimeout(showTimer);
      // 点击模式打开的卡片不因移出而关闭
      if (t.mode !== 'click' && view.isOpen && !(pinnedAnchor && pinnedAnchor === view.anchor)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => view.close(), HOVER_HIDE_DELAY);
      }
    }
  };

  const onPointerOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    hoverAnchor = anchorOf(e);
    onHoverTarget(hoverAnchor, e);
  };

  /** 只有注册了 hitTestOnMove 的区域才需要：每帧最多命中一次，命中的单词变化时按“指向变化”处理 */
  let moveRaf = 0;
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || moveRaf || ![...zones].some((z) => z.hitTestOnMove)) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
    });
    // composedPath 只在派发期间有效：命中判断必须在本次回调里完成
    const anchor = anchorOf(e);
    if (anchor === hoverAnchor) return;
    hoverAnchor = anchor;
    onHoverTarget(anchor, e);
  };

  const onPointerDown = (e: PointerEvent) => {
    lastPointerType = e.pointerType || 'mouse';
    // 修饰键 + 鼠标按下（Ctrl+点击开新标签等）是快捷键，本次按住作废
    if (lastPointerType === 'mouse' && anyModifier(e)) {
      chord = true;
      clearTimeout(showTimer);
      // Ctrl/⌘/Shift + 点链接 = 新标签/新窗口打开（#113）：卡片不该留在原页，关闭并在修饰键松开前不再弹出
      if (newTabModifier(e) && inLink(e) && !view.contains(e)) {
        newTabHold = true;
        clearTimeout(hideTimer);
        if (view.isOpen) view.close();
        return;
      }
    }
    if (view.isOpen && insideCard(e)) {
      if (view.contains(e)) {
        pinnedAnchor = view.anchor;
        // 在卡片内按下（点按钮、点“知道了”）说明用户看到了卡片，提示记为已看到
        if (pendingHint?.anchor === view.anchor) commitHint();
      }
      clearTimeout(hideTimer);
    }
    // 触屏的按下可能是滚动手势的开始，留到 click 再判断是否关闭
    if (lastPointerType === 'touch') return;
    if (view.isOpen && !insideCard(e) && !anchorOf(e)) view.close();
  };

  const onClick = (e: MouseEvent) => {
    if (insideCard(e) && !anchorOf(e)) return;
    if (view.contains(e)) return;
    const anchor = anchorOf(e);
    if (!anchor) {
      // 触屏点按卡片外部：关闭（不阻止页面默认行为）
      if (view.isOpen && lastPointerType === 'touch') view.close();
      return;
    }
    const isTouch = lastPointerType !== 'mouse';
    // 用户关闭了触屏点按开卡片：页面生词的点按完全交给页面（链接照常跳转）；
    // 注册区域（YouTube 字幕面板等专门的查词入口）与悬浮球取词模式不受影响
    if (isTouch && opts.getTapOpen?.() === false && anchor.tagName === TAG_MARK.toUpperCase()) return;
    if (!isTouch) {
      if (resolved().mode !== 'click') return;
      // 带修饰键的点击（新标签/新窗口/下载）完全交给浏览器
      if (anyModifier(e)) return;
      // 拖选文字结束的点击不弹卡片
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    }
    // 已为该单词打开卡片时再次点按：放行默认行为（如链接跳转）
    if (view.isOpen && view.anchor === anchor) return;
    e.preventDefault();
    e.stopPropagation();
    openNow(anchor, isTouch ? 'tap' : 'click');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && view.isOpen) view.close();
    const t = resolved();
    if (t.mode !== 'modifier') return;
    if (!MODIFIER_KEYS[t.modifier].includes(e.key)) {
      // 修饰键之外的键：若修饰键正按着，就是组合键（Ctrl+C 等），本次按住作废；单独的其他修饰键不算
      if (anyModifier(e) && !ALL_MODIFIER_KEYS.has(e.key)) {
        chord = true;
        clearTimeout(showTimer);
      } else if (ALL_MODIFIER_KEYS.has(e.key)) {
        // 又按下了别的修饰键（如 Alt 时再按 Ctrl）：不再是“只按着设定的键”
        clearTimeout(showTimer);
      }
      return;
    }
    if (e.repeat) return;
    chord = false;
    openedByHold = false;
    if (newTabHold) return;
    // 指针已在单词上时按下修饰键：稍等确认不是组合键再打开
    if (!hoverAnchor || !hoverAnchor.isConnected || !onlyModifier(e, t.modifier) || isEditing(doc)) return;
    if (view.isOpen && view.anchor === hoverAnchor) return;
    scheduleOpen(hoverAnchor, 'modifier', KEY_SHOW_DELAY);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    // keyup 时事件上的修饰键状态已是松开后的状态：Ctrl/⌘/Shift 全部松开才解除
    if (NEW_TAB_KEYS.has(e.key) && !newTabModifier(e)) newTabHold = false;
    const t = resolved();
    if (t.mode !== 'modifier' || !MODIFIER_KEYS[t.modifier].includes(e.key)) return;
    clearTimeout(showTimer);
    // 本次按住用来查过词：吞掉松开事件，避免 Windows/Linux 上单按 Alt 激活浏览器菜单栏
    if (openedByHold && !chord) e.preventDefault();
    chord = false;
    openedByHold = false;
  };

  /** Ctrl+滚轮缩放等：本次按住作废 */
  const onWheel = (e: WheelEvent) => {
    if (anyModifier(e)) {
      chord = true;
      clearTimeout(showTimer);
    }
  };

  /** 窗口失焦（Alt+Tab、切到地址栏）后收不到 keyup，复位按住状态 */
  const onBlur = () => {
    clearTimeout(showTimer);
    chord = false;
    openedByHold = false;
    newTabHold = false;
  };

  const win = doc.defaultView;
  // capture 阶段监听：页面阻止冒泡也能收到
  doc.addEventListener('pointerover', onPointerOver, true);
  doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('keyup', onKeyUp, true);
  doc.addEventListener('wheel', onWheel, { capture: true, passive: true });
  win?.addEventListener('blur', onBlur);
  return () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (pendingHint) clearTimeout(pendingHint.timer);
    cancelAnimationFrame(moveRaf);
    doc.removeEventListener('pointerover', onPointerOver, true);
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('keyup', onKeyUp, true);
    doc.removeEventListener('wheel', onWheel, true);
    win?.removeEventListener('blur', onBlur);
  };
}
