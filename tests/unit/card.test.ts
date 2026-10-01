import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShadowCardView, isDarkBackground, luminance } from '@/content/card/card-view';
import { bindCardTrigger } from '@/content/card/trigger';
import type { CardActions, CardData } from '@/content/card/types';
import { describeForm, dictLinks, formatPhonetic, parseDefinitions } from '@/content/card/word-info';
import type { BookMeta } from '@/core/wordbook/types';

const cet6: BookMeta = { id: 'cet6', name: '大学英语六级', nameEn: 'CET-6', short: '六级', kind: 'builtin', category: 'exam', level: 4, size: 0 };
const eudic: BookMeta = { id: 'src:eudic:-1', name: '欧路·生词本', nameEn: 'Eudic', short: '欧路', kind: 'source', category: 'user', level: 0, size: 0, providerId: 'eudic' };

describe('word-info', () => {
  it('describeForm：规则与不规则词形', () => {
    expect(describeForm('abandon', 'abandon')).toBeUndefined();
    expect(describeForm('Abandoned', 'abandon')).toBe('过去式，过去分词');
    expect(describeForm('running', 'run')).toBe('现在分词');
    expect(describeForm('ran', 'run')).toBe('过去式');
    expect(describeForm('gone', 'go')).toBe('过去分词');
    expect(describeForm('made', 'make')).toBe('过去式，过去分词');
    expect(describeForm('studies', 'study')).toBe('复数，第三人称单数');
    expect(describeForm('boxes', 'box')).toBe('复数，第三人称单数');
    expect(describeForm('children', 'child')).toBe('复数');
    expect(describeForm('making', 'make')).toBe('现在分词');
    expect(describeForm('stopped', 'stop')).toBe('过去式，过去分词');
    expect(describeForm('better', 'good')).toBe('比较级');
    expect(describeForm('happiest', 'happy')).toBe('最高级');
    expect(describeForm('quickly', 'quick')).toBe('副词');
    expect(describeForm('xyzzy', 'abc')).toBe('变形');
  });

  it('parseDefinitions：拆出词性与领域标签，去重', () => {
    const lines = parseDefinitions('vt. 放弃', 'vt. 放弃, 抛弃\nn. 放任\n[经] 能力\nn. 放任\n没有词性的行');
    expect(lines).toEqual([
      { pos: 'vt.', text: '放弃, 抛弃' },
      { pos: 'n.', text: '放任' },
      { pos: '[经]', text: '能力' },
      { pos: '', text: '没有词性的行' },
    ]);
    expect(parseDefinitions('v. 放弃', undefined)).toEqual([{ pos: 'v.', text: '放弃' }]);
    expect(parseDefinitions()).toEqual([]);
  });

  it('formatPhonetic：规范化 ECDICT 音标', () => {
    expect(formatPhonetic("ә'bændәn")).toBe("/ə'bændən/");
    expect(formatPhonetic('[ri:d]')).toBe('/ri:d/');
    expect(formatPhonetic('')).toBe('');
  });

  it('dictLinks：URL 编码', () => {
    expect(dictLinks('ice cream')[0]!.url).toContain('ice%20cream');
  });

  it('luminance / isDarkBackground', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('rgb(0, 0, 0)')).toBeCloseTo(0);
    expect(luminance('not-a-color')).toBe(1);
    document.body.innerHTML = '<div style="background:#111"><span id="w">x</span></div><span id="l">y</span>';
    expect(isDarkBackground(document.getElementById('w')!)).toBe(true);
    expect(isDarkBackground(document.getElementById('l')!)).toBe(false);
  });
});

function makeActions(over: Partial<CardActions> = {}): CardActions {
  return {
    speak: vi.fn(),
    markKnown: vi.fn(async (lemma: string) => ({ ok: true, lemma, deleted: [], message: '' })),
    unmarkKnown: vi.fn(async () => {}),
    deleteFromSources: vi.fn(async () => ({ ok: true, message: '已删除', reports: [] })),
    ...over,
  };
}

const shadow = () => document.querySelector('hnw-card-host')!.shadowRoot!;
const q = <T extends Element = HTMLElement>(sel: string) => shadow().querySelector<T>(sel);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ShadowCardView', () => {
  let view: ShadowCardView;
  let mark: HTMLElement;
  const data = (over: Partial<CardData> = {}): CardData => ({ surface: 'abandoned', lemma: 'abandon', books: [cet6], deletableBooks: [], ...over });

  beforeEach(() => {
    document.body.innerHTML = '<p>They <hnw-mark data-lemma="abandon">abandoned</hnw-mark> it.</p>';
    mark = document.querySelector('hnw-mark')!;
  });
  afterEach(() => view?.destroy());

  it('加载中显示骨架，update 后显示释义、词形与词书标签；激活单词带标记', () => {
    view = new ShadowCardView(document, makeActions());
    view.open(mark, data());
    expect(view.isOpen).toBe(true);
    expect(q('.loading')).not.toBeNull();
    expect(mark.hasAttribute('data-hnw-active')).toBe(true);
    view.update(data({ entry: { word: 'abandon', phonetic: "ә'bændәn", short: 'vt. 放弃', full: 'vt. 放弃\nn. 放任\nadj. a\nadv. b' } }));
    expect(q('.word')!.textContent).toBe('abandon');
    expect(q('.form')!.textContent).toContain('过去式');
    expect(q('.phon')!.textContent).toContain("/ə'bændən/");
    expect(q('.tag')!.textContent).toBe('六级');
    expect(shadow().querySelectorAll('.defs li')).toHaveLength(4);
    // 超过 3 行折叠，展开后不再折叠
    expect(q('.defs')!.classList.contains('clamp')).toBe(true);
    q('[data-act="expand"]')!.click();
    expect(q('.defs')!.classList.contains('clamp')).toBe(false);
    // 无收藏能力时不显示收藏按钮；无可删除来源时不显示移出
    expect(q('[data-act="collect"]')).toBeNull();
    expect(q('[data-act="delete"]')).toBeNull();
    view.close();
    expect(mark.hasAttribute('data-hnw-active')).toBe(false);
  });

  it('查询无结果时显示“暂无释义”', () => {
    view = new ShadowCardView(document, makeActions());
    view.open(mark, data());
    view.update(data());
    expect(q('.loading')).toBeNull();
    expect(q('.empty')!.textContent).toContain('暂无释义');
  });

  it('认识：关闭卡片并给出可撤销 toast，撤销调用 unmarkKnown', async () => {
    const actions = makeActions();
    view = new ShadowCardView(document, actions);
    view.open(mark, data());
    q('[data-act="known"]')!.click();
    await flush();
    await flush();
    expect(actions.markKnown).toHaveBeenCalledWith('abandon', 'abandoned');
    expect(view.isOpen).toBe(false);
    const toast = q('.toast')!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('撤销');
    toast.querySelector('button')!.click();
    await flush();
    expect(actions.unmarkKnown).toHaveBeenCalledWith('abandon');
    expect(q('.toast')!.textContent).toContain('已撤销');
  });

  it('移出生词本：两步确认后才调用', async () => {
    const actions = makeActions();
    view = new ShadowCardView(document, actions);
    view.open(mark, data({ books: [eudic, cet6], deletableBooks: [eudic] }));
    expect(q('.tag.user')!.textContent).toBe('欧路·生词本');
    q('[data-act="delete"]')!.click();
    await flush();
    expect(actions.deleteFromSources).not.toHaveBeenCalled();
    expect(q('[data-act="delete"]')!.textContent).toContain('确认');
    q('[data-act="delete"]')!.click();
    await flush();
    await flush();
    expect(actions.deleteFromSources).toHaveBeenCalledWith('abandon', ['src:eudic:-1']);
    expect(view.isOpen).toBe(false);
    expect(q('.toast')!.textContent).toContain('已删除');
  });

  it('收藏：注入 setCollected 时显示按钮，失败回滚', async () => {
    const setCollected = vi.fn(async () => ({ ok: false, message: '网络错误' }));
    view = new ShadowCardView(document, makeActions({ setCollected }));
    view.open(mark, data({ collected: false }));
    const btn = q('[data-act="collect"]')!;
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    await flush();
    await flush();
    expect(setCollected).toHaveBeenCalledWith('abandon', 'abandoned', true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(q('.toast')!.textContent).toContain('网络错误');
  });

  it('窄视口使用底部卡片布局', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
    view = new ShadowCardView(document, makeActions());
    view.open(mark, data());
    expect(q('.card')!.classList.contains('sheet')).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('bindCardTrigger', () => {
  it('触屏：点按单词打开并阻止默认行为，再次点按放行；点外部关闭', () => {
    document.body.innerHTML = '<a href="#x"><hnw-mark data-lemma="abandon">abandon</hnw-mark></a><p id="out">out</p>';
    const view = new ShadowCardView(document, makeActions());
    const onOpen = vi.fn((m: HTMLElement) => view.open(m, { surface: 'abandon', lemma: 'abandon', books: [], deletableBooks: [] }));
    const unbind = bindCardTrigger({ doc: document, view, getTrigger: () => 'auto', onOpen });
    const mark = document.querySelector('hnw-mark')!;
    const tap = (el: Element) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' } as PointerEventInit));
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      el.dispatchEvent(click);
      return click;
    };
    expect(tap(mark).defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(tap(mark).defaultPrevented).toBe(false);
    // 触屏按下外部（可能是滚动开始）不关闭，click 才关闭
    document.getElementById('out')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' } as PointerEventInit));
    expect(view.isOpen).toBe(true);
    tap(document.getElementById('out')!);
    expect(view.isOpen).toBe(false);
    unbind();
    view.destroy();
  });
});
