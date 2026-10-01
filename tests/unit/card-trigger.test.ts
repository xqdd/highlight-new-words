import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCardTrigger, registerCardTriggerZone, type TriggerHintStore } from '@/content/card/trigger';
import {
  cardTriggerHintText,
  effectiveModifier,
  modifierChoices,
  modifierLabel,
  resolveCardTrigger,
  triggerSignature,
} from '@/content/card/trigger-config';
import type { CardView } from '@/content/card/types';
import type { CardModifierKey, CardTrigger } from '@/core/settings/schema';
import { createDefaultSettings } from '@/core/settings/defaults';
import { normalizeSettings } from '@/core/settings/migrate';

/** 最小 CardView：只记录打开/关闭与提示 */
function fakeView(contains: (e: Event) => boolean = () => false): CardView & { hints: string[] } {
  let anchor: HTMLElement | null = null;
  let open = false;
  const hints: string[] = [];
  return {
    hints,
    open(a) {
      anchor = a;
      open = true;
    },
    update() {},
    close() {
      open = false;
      anchor = null;
    },
    get isOpen() {
      return open;
    },
    get anchor() {
      return anchor;
    },
    contains,
    setStyle() {},
    showHint(text) {
      hints.push(text);
    },
    destroy() {},
  };
}

type Mods = { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean };
const over = (el: Element, mods: Mods = {}, pointerType = 'mouse') =>
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType, ...mods } as PointerEventInit));
const down = (el: Element, mods: Mods = {}, pointerType = 'mouse') =>
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType, ...mods } as PointerEventInit));
const click = (el: Element, mods: Mods = {}) => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(ev);
  return ev;
};
const key = (type: 'keydown' | 'keyup', k: string, mods: Mods = {}) => {
  const ev = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...mods });
  document.dispatchEvent(ev);
  return ev;
};

function setup(trigger: CardTrigger, modifier: CardModifierKey = 'alt', hintStore: TriggerHintStore | false = false, hoverDelay?: number) {
  document.body.innerHTML =
    '<p><hnw-mark id="w1" data-lemma="abandon">abandon</hnw-mark> plain <span id="out">out</span></p>' +
    '<a id="link" href="#go"><hnw-mark id="w2" data-lemma="harbor">harbor</hnw-mark></a><input id="inp">';
  const view = fakeView();
  const onOpen = vi.fn((m: HTMLElement) => view.open(m, { surface: '', lemma: '', books: [], deletableBooks: [] }));
  const unbind = bindCardTrigger({
    doc: document,
    view,
    getTrigger: () => trigger,
    getModifier: () => modifier,
    getHoverDelay: hoverDelay === undefined ? undefined : () => hoverDelay,
    onOpen,
    hintStore,
    mac: false,
  });
  const $ = (id: string) => document.getElementById(id)!;
  return { view, onOpen, unbind, $ };
}

describe('trigger-config', () => {
  it('解析 PC 端触发方式与平台修饰键', () => {
    expect(resolveCardTrigger({ trigger: 'auto' }, false)).toEqual({ mode: 'hover', modifier: 'alt' });
    expect(resolveCardTrigger({ trigger: 'modifier', modifier: 'meta' }, true)).toEqual({ mode: 'modifier', modifier: 'meta' });
    // macOS 同步来的 ⌘ 在 Windows/Linux 上按 Ctrl
    expect(effectiveModifier('meta', false)).toBe('ctrl');
    expect(modifierChoices(false)).toEqual(['alt', 'ctrl', 'shift']);
    expect(modifierChoices(true)).toContain('meta');
    expect(modifierLabel('alt', true)).toBe('⌥ Option');
    expect(modifierLabel('ctrl', false)).toBe('Ctrl');
    expect(triggerSignature({ mode: 'modifier', modifier: 'shift' })).toBe('modifier:shift');
    expect(cardTriggerHintText({ mode: 'modifier', modifier: 'alt' }, true)).toContain('⌥');
    expect(cardTriggerHintText({ mode: 'click', modifier: 'alt' }, true)).toContain('⌘');
    // 三种方式的首次提示句式一致，均以设置入口路径结尾
    for (const mode of ['hover', 'modifier', 'click'] as const) {
      expect(cardTriggerHintText({ mode, modifier: 'alt' }, false)).toMatch(/。可在 设置 › 外观 › 释义卡片 更改$/);
    }
  });

  it('旧设置补齐 card.modifier，旧 trigger 原样保留', () => {
    expect(createDefaultSettings().card).toEqual({ trigger: 'auto', modifier: 'alt', hoverDelay: 250, showUserTrans: true, tapOpen: true, longPressOpen: true });
    const old = { ...createDefaultSettings(), card: { trigger: 'click' } };
    expect(normalizeSettings(old).card).toEqual({ trigger: 'click', modifier: 'alt', hoverDelay: 250, showUserTrans: true, tapOpen: true, longPressOpen: true });
    // 悬停延迟只允许 100/250/400：写坏的值按默认
    expect(normalizeSettings({ card: { trigger: 'hover', hoverDelay: 400 } }).card.hoverDelay).toBe(400);
    expect(normalizeSettings({ card: { trigger: 'hover', hoverDelay: 7 } }).card.hoverDelay).toBe(250);
    expect(normalizeSettings({ card: { trigger: 'hover', hoverDelay: '250' } }).card.hoverDelay).toBe(250);
  });
});

describe('bindCardTrigger v11', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('悬停：默认 250ms 后打开，移出 250ms 后关闭；点击不拦截链接', () => {
    const { view, onOpen, unbind, $ } = setup('hover');
    over($('w1'));
    vi.advanceTimersByTime(249);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledWith($('w1'), 'hover');
    over($('out'));
    vi.advanceTimersByTime(250);
    expect(view.isOpen).toBe(false);
    expect(click($('w2')).defaultPrevented).toBe(false);
    unbind();
  });

  it('修饰键：不按不弹；先按键再移入、或指向后再按键都能打开', () => {
    const { onOpen, unbind, $ } = setup('modifier', 'alt');
    over($('w1'));
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();
    // 指针已在单词上，再按下 Alt
    key('keydown', 'Alt', { altKey: true });
    vi.advanceTimersByTime(200);
    expect(onOpen).toHaveBeenCalledWith($('w1'), 'modifier');
    // 用来查过词的那次按住，松开时吞掉 keyup（避免 Windows 单按 Alt 激活菜单）
    expect(key('keyup', 'Alt').defaultPrevented).toBe(true);
    // 按住 Alt 移入另一个单词（移入走悬停延迟，默认 250ms）
    over($('w2'), { altKey: true });
    vi.advanceTimersByTime(250);
    expect(onOpen).toHaveBeenLastCalledWith($('w2'), 'modifier');
    unbind();
  });

  it('修饰键：组合键（Ctrl+C、Ctrl+点击、Ctrl+Alt）不弹卡片，松开后恢复', () => {
    const { onOpen, unbind, $ } = setup('modifier', 'ctrl');
    over($('w1'));
    key('keydown', 'Control', { ctrlKey: true });
    key('keydown', 'c', { ctrlKey: true });
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();
    // 仍按着 Ctrl 移入其他单词：本次按住已作废
    over($('w2'), { ctrlKey: true });
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();
    expect(key('keyup', 'Control').defaultPrevented).toBe(false);
    // Ctrl+点击链接：交给浏览器，不弹卡片
    key('keydown', 'Control', { ctrlKey: true });
    down($('w2'), { ctrlKey: true });
    const ev = click($('w2'), { ctrlKey: true });
    vi.advanceTimersByTime(500);
    expect(ev.defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    key('keyup', 'Control');
    // Ctrl+Alt 同时按住：不是“只按着 Ctrl”
    over($('w1'), { ctrlKey: true, altKey: true });
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();
    // 正常按住 Ctrl 移入
    over($('w1'), { ctrlKey: true });
    vi.advanceTimersByTime(250);
    expect(onOpen).toHaveBeenCalledTimes(1);
    unbind();
  });

  it('修饰键：焦点在输入框时按 Shift 不弹卡片', () => {
    const { onOpen, unbind, $ } = setup('modifier', 'shift');
    over($('w1'));
    ($('inp') as HTMLInputElement).focus();
    key('keydown', 'Shift', { shiftKey: true });
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();
    unbind();
  });

  it('点击：首次点击弹卡并阻止跳转，再点放行；带修饰键点击交给浏览器；悬停不弹', () => {
    const { onOpen, unbind, $ } = setup('click');
    over($('w2'));
    vi.advanceTimersByTime(500);
    expect(onOpen).not.toHaveBeenCalled();
    down($('w2'));
    expect(click($('w2')).defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledWith($('w2'), 'click');
    // 点击模式打开的卡片不因移出而关闭
    over($('out'));
    vi.advanceTimersByTime(500);
    down($('w2'));
    expect(click($('w2')).defaultPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    down($('w1'), { metaKey: true });
    expect(click($('w1'), { metaKey: true }).defaultPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    unbind();
  });

  it('触屏不受 PC 端设置影响：修饰键模式下点按照常打开', () => {
    const { onOpen, unbind, $ } = setup('modifier');
    down($('w2'), {}, 'touch');
    expect(click($('w2')).defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledWith($('w2'), 'tap');
    unbind();
  });

  it('关闭“触屏点按开卡片”：点按页面生词不弹卡片、不拦截链接；鼠标点击模式不受影响', () => {
    document.body.innerHTML = '<a id="link" href="#go"><hnw-mark id="w2" data-lemma="harbor">harbor</hnw-mark></a>';
    const view = fakeView();
    const onOpen = vi.fn();
    const unbind = bindCardTrigger({ doc: document, view, getTrigger: () => 'click', getTapOpen: () => false, onOpen, hintStore: false, mac: false });
    const w2 = document.getElementById('w2')!;
    down(w2, {}, 'touch');
    expect(click(w2).defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    down(w2);
    expect(click(w2).defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledWith(w2, 'click');
    unbind();
  });

  it('首次出现提示一次当前方式，方式变化后再提示；触屏不提示', async () => {
    let saved: string | undefined;
    const store: TriggerHintStore = { load: async () => saved, save: async (s) => void (saved = s) };
    let trigger: CardTrigger = 'hover';
    document.body.innerHTML = '<hnw-mark id="w1" data-lemma="a">a</hnw-mark><hnw-mark id="w2" data-lemma="b">b</hnw-mark><i id="out"></i>';
    const view = fakeView();
    const onOpen = vi.fn((m: HTMLElement) => view.open(m, { surface: '', lemma: '', books: [], deletableBooks: [] }));
    const unbind = bindCardTrigger({ doc: document, view, getTrigger: () => trigger, onOpen, hintStore: store, mac: false });
    await vi.advanceTimersByTimeAsync(0);
    const w1 = document.getElementById('w1')!;
    const w2 = document.getElementById('w2')!;
    over(w1);
    vi.advanceTimersByTime(250);
    expect(view.hints).toHaveLength(1);
    // 提示可见满 1s 才记下
    expect(saved).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(saved).toBe('hover');
    over(w2);
    vi.advanceTimersByTime(250);
    expect(view.hints).toHaveLength(1);
    trigger = 'click';
    view.close();
    down(w1, {}, 'touch');
    click(w1);
    expect(view.hints).toHaveLength(1);
    view.close();
    down(w1);
    click(w1);
    expect(view.hints).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(saved).toBe('click');
    unbind();
  });

  it('触发区域：Shadow DOM 中的单词按钮走同一套规则，区域空白处不触发移出关闭', () => {
    const { view, onOpen, unbind } = setup('hover');
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button class="tok" data-lemma="cue">cue</button><span class="gap">gap</span>';
    const off = registerCardTriggerZone({
      anchorOf: (e) => (e.composedPath().find((n) => n instanceof HTMLElement && n.matches('.tok[data-lemma]')) as HTMLElement) ?? null,
      contains: (e) => e.composedPath().includes(host),
    });
    const tok = root.querySelector('.tok')!;
    tok.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' } as PointerEventInit));
    vi.advanceTimersByTime(250);
    expect(onOpen).toHaveBeenCalledWith(tok, 'hover');
    root.querySelector('.gap')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' } as PointerEventInit));
    vi.advanceTimersByTime(500);
    expect(view.isOpen).toBe(true);
    off();
    unbind();
  });
});

describe('card 修复轮', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([100, 250, 400])('C1 悬停延迟 %ims：不到不弹，满了弹出', (delay) => {
    const { onOpen, unbind, $ } = setup('hover', 'alt', false, delay);
    over($('w1'));
    vi.advanceTimersByTime(delay - 1);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledWith($('w1'), 'hover');
    unbind();
  });

  it('C1 默认 250ms：指针扫过（停留不到 250ms 就移到别处）不弹卡', () => {
    const { onOpen, unbind, $ } = setup('hover');
    over($('w1'));
    vi.advanceTimersByTime(150);
    over($('out'));
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
    unbind();
  });

  it('C1 修饰键模式：移入走悬停延迟，指针已在单词上再按键仍为 180ms（不受悬停延迟影响）', () => {
    const { onOpen, unbind, $ } = setup('modifier', 'alt', false, 400);
    over($('w1'), { altKey: true });
    vi.advanceTimersByTime(399);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    key('keyup', 'Alt');
    over($('w2'));
    key('keydown', 'Alt', { altKey: true });
    vi.advanceTimersByTime(179);
    expect(onOpen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenLastCalledWith($('w2'), 'modifier');
    unbind();
  });

  it('C2 #113 修饰键=Ctrl：按住 Ctrl 悬停链接内生词打开卡片，Ctrl+点击后卡片关闭、不拦截点击，松开 Ctrl 前不再弹', () => {
    const { view, onOpen, unbind, $ } = setup('modifier', 'ctrl');
    key('keydown', 'Control', { ctrlKey: true });
    over($('w2'), { ctrlKey: true });
    vi.advanceTimersByTime(250);
    expect(view.isOpen).toBe(true);
    expect(view.anchor).toBe($('w2'));
    down($('w2'), { ctrlKey: true });
    expect(view.isOpen).toBe(false);
    expect(click($('w2'), { ctrlKey: true }).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(view.isOpen).toBe(false);
    // 仍按着 Ctrl：移入其他单词、移回原单词都不弹
    over($('w1'), { ctrlKey: true });
    vi.advanceTimersByTime(1000);
    over($('w2'), { ctrlKey: true });
    vi.advanceTimersByTime(1000);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 松开后重新按下 Ctrl：恢复
    key('keyup', 'Control');
    key('keydown', 'Control', { ctrlKey: true });
    vi.advanceTimersByTime(180);
    expect(onOpen).toHaveBeenCalledTimes(2);
    unbind();
  });

  it('C2 #113 悬停模式：⌘/Shift+点击链接内生词同样关闭卡片；修饰键松开（指针事件上已无修饰键）后恢复', () => {
    const { view, onOpen, unbind, $ } = setup('hover');
    over($('w2'));
    vi.advanceTimersByTime(250);
    expect(view.isOpen).toBe(true);
    down($('w2'), { metaKey: true });
    expect(view.isOpen).toBe(false);
    expect(click($('w2'), { metaKey: true }).defaultPrevented).toBe(false);
    over($('w1'), { metaKey: true });
    vi.advanceTimersByTime(1000);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 没收到 keyup（焦点切走）时，以指针事件上的修饰键状态为准
    over($('w1'));
    vi.advanceTimersByTime(250);
    expect(onOpen).toHaveBeenCalledTimes(2);
    // Shift+点击（新窗口）
    over($('w2'));
    vi.advanceTimersByTime(250);
    down($('w2'), { shiftKey: true });
    expect(view.isOpen).toBe(false);
    unbind();
  });

  it('C2 非链接区域行为不变：Ctrl+按下非链接中的已打开单词不关闭卡片', () => {
    const { view, unbind, $ } = setup('hover');
    over($('w1'));
    vi.advanceTimersByTime(250);
    down($('w1'), { ctrlKey: true });
    expect(click($('w1'), { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(view.isOpen).toBe(true);
    expect(view.anchor).toBe($('w1'));
    unbind();
  });

  /** 带提示存取的绑定；卡片“内部”用 #in-card 元素模拟 */
  async function setupHint() {
    let saved: string | undefined;
    const store: TriggerHintStore = { load: async () => saved, save: async (s) => void (saved = s) };
    document.body.innerHTML =
      '<hnw-mark id="w1" data-lemma="a">a</hnw-mark><hnw-mark id="w2" data-lemma="b">b</hnw-mark><i id="out"></i><div id="in-card"><button>x</button></div>';
    const inCard = document.getElementById('in-card')!;
    const view = fakeView((e) => e.composedPath().includes(inCard));
    const onOpen = vi.fn((m: HTMLElement) => view.open(m, { surface: '', lemma: '', books: [], deletableBooks: [] }));
    const unbind = bindCardTrigger({ doc: document, view, getTrigger: () => 'hover', onOpen, hintStore: store, mac: false });
    await vi.advanceTimersByTimeAsync(0);
    const $ = (id: string) => document.getElementById(id)!;
    return { view, unbind, $, inCard, saved: () => saved };
  }

  it('C3 #114 卡片不到 1 秒就关闭：不记为已提示，下次打开仍提示；持续可见满 1 秒才记下', async () => {
    const { view, unbind, $, saved } = await setupHint();
    over($('w1'));
    vi.advanceTimersByTime(250);
    expect(view.hints).toHaveLength(1);
    // 一闪而过：移出 250ms 后关闭（打开后约 0.5s）
    over($('out'));
    vi.advanceTimersByTime(250);
    expect(view.isOpen).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(saved()).toBeUndefined();
    // 下次打开仍显示提示
    over($('w2'));
    vi.advanceTimersByTime(250);
    expect(view.hints).toHaveLength(2);
    vi.advanceTimersByTime(999);
    expect(saved()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(saved()).toBe('hover');
    // 已记下：之后不再提示
    view.close();
    over($('w1'));
    vi.advanceTimersByTime(250);
    expect(view.hints).toHaveLength(2);
    unbind();
  });

  it('C3 #114 不到 1 秒但用户在卡片内按下（点按钮）：立即记为已提示', async () => {
    const { view, unbind, $, inCard, saved } = await setupHint();
    over($('w1'));
    vi.advanceTimersByTime(250);
    expect(view.hints).toHaveLength(1);
    vi.advanceTimersByTime(300);
    down(inCard.querySelector('button')!);
    expect(saved()).toBe('hover');
    expect(view.isOpen).toBe(true);
    unbind();
  });
});

describe('ShadowCardView.showHint', () => {
  it('卡片内显示一次性提示，“知道了”或切换单词后消失', async () => {
    const { ShadowCardView } = await import('@/content/card/card-view');
    document.body.innerHTML = '<hnw-mark id="a" data-lemma="abandon">abandon</hnw-mark><hnw-mark id="b" data-lemma="harbor">harbor</hnw-mark>';
    // 上下文请求永不返回：本用例只看提示条
    const pending = () => new Promise<never>(() => {});
    const backend = {
      getWordState: pending,
      preview: pending,
      listAddTargets: pending,
      sourceStates: pending,
    } as never;
    const actions = { speak() {}, markKnown: async () => ({ ok: true }), unmarkKnown: async () => {}, deleteFromSources: async () => ({ ok: true }) } as never;
    const view = new ShadowCardView(document, actions, backend);
    const root = document.querySelector('hnw-card-host')!.shadowRoot!;
    view.showHint('不应显示');
    expect(root.querySelector('.once-hint')).toBeNull();
    view.open(document.getElementById('a')!, { surface: 'abandon', lemma: 'abandon', books: [], deletableBooks: [] });
    view.showHint('按住 Alt 指向单词才显示卡片');
    expect(root.querySelector('.once-hint span')?.textContent).toBe('按住 Alt 指向单词才显示卡片');
    view.update({ surface: 'abandon', lemma: 'abandon', books: [], deletableBooks: [] });
    expect(root.querySelector('.once-hint')).not.toBeNull();
    (root.querySelector('[data-act="hint-ok"]') as HTMLElement).click();
    expect(root.querySelector('.once-hint')).toBeNull();
    view.showHint('x');
    view.open(document.getElementById('b')!, { surface: 'harbor', lemma: 'harbor', books: [], deletableBooks: [] });
    expect(root.querySelector('.once-hint')).toBeNull();
    view.destroy();
  });
});
