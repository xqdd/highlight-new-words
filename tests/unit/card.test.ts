import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ShadowCardView, fitContrast, isDarkBackground, luminance } from '@/content/card/card-view';
import { bindCardTrigger } from '@/content/card/trigger';
import type { CardActions, CardData } from '@/content/card/types';
import { describeForm, dictLinks, formatPhonetic, parseDefinitions } from '@/content/card/word-info';
import {
  buildAddTargets,
  describeAddResult,
  describeKnownResult,
  describePreview,
  type AddTargetOption,
  type CardBackend,
} from '@/content/card/word-actions';
import type { WordActionPreview } from '@/core/messaging/protocol';
import { createDefaultSettings } from '@/core/settings/defaults';
import type { BookMeta, SourceBookState } from '@/core/wordbook/types';

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
    markKnown: vi.fn(async (lemma: string) => ({
      ok: true,
      lemma,
      deleted: [],
      message: '已标记为熟词；已从“我的生词本”删除 abandon',
      written: [{ bookId: 'known:local', name: '本地熟词本', ok: true, words: [lemma] }],
    })),
    unmarkKnown: vi.fn(async () => ({ ok: true, message: '已撤销；已加回 abandon' })),
    deleteFromSources: vi.fn(async () => ({ ok: true, message: '已删除', reports: [] })),
    ...over,
  };
}

const target = (over: Partial<AddTargetOption> & { id: string }): AddTargetOption => ({ name: over.id, remote: false, isDefault: false, ...over });

function preview(action: 'add' | 'known', over: Partial<WordActionPreview> = {}): WordActionPreview {
  return {
    action,
    lemma: 'abandon',
    write: [{ bookId: action === 'add' ? 'local:mine' : 'known:local', name: action === 'add' ? '我的生词本' : '本地熟词本', ok: true, words: ['abandon'], remote: false, undoable: true }],
    remove: [],
    needsConfirm: false,
    ...over,
  };
}

function makeBackend(over: Partial<CardBackend> = {}): CardBackend & Record<string, ReturnType<typeof vi.fn>> {
  return {
    getWordState: vi.fn(async () => ({ collected: false, collectedIn: [], known: false })),
    preview: vi.fn(async (action: 'add' | 'known') => preview(action)),
    listAddTargets: vi.fn(async () => [
      target({ id: 'local:mine', name: '我的生词本', isDefault: true }),
      target({ id: 'src:youdao:0', name: '有道词典 · 无标签', remote: true }),
      target({ id: 'src:youdao:9', name: '有道词典 · 托福', remote: true, disabledReason: '有道只能加到默认分组' }),
    ]),
    addWord: vi.fn(async (d: { lemma: string; targets?: string[] }) => ({
      ok: true,
      lemma: d.lemma,
      added: (d.targets ?? ['local:mine']).map((id) => ({ bookId: id, name: id === 'local:mine' ? '我的生词本' : '有道词典 · 无标签', ok: true, words: [d.lemma] })),
      removedKnown: [],
      message: `已加入${(d.targets ?? ['local:mine']).map((id) => `“${id === 'local:mine' ? '我的生词本' : '有道词典 · 无标签'}”`).join('、')}`,
    })),
    removeWord: vi.fn(async () => ({ ok: true, removed: [{ bookId: 'local:mine', name: '我的生词本', ok: true, words: ['abandon'] }], message: '已从“我的生词本”删除 abandon' })),
    confirmKnown: vi.fn(async (_w: string, lemma: string) => ({ ok: true, lemma, deleted: [], message: '已标记为熟词；已从“有道词典 · 无标签”删除 lay' })),
    sourceStates: vi.fn(async () => ({})),
    ...over,
  } as CardBackend & Record<string, ReturnType<typeof vi.fn>>;
}

const shadow = () => document.querySelector('hnw-card-host')!.shadowRoot!;
const q = <T extends Element = HTMLElement>(sel: string) => shadow().querySelector<T>(sel);
const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('ShadowCardView', () => {
  let view: ShadowCardView;
  let mark: HTMLElement;
  const data = (over: Partial<CardData> = {}): CardData => ({ surface: 'abandoned', lemma: 'abandon', books: [cet6], deletableBooks: [], ...over });

  beforeEach(() => {
    document.body.innerHTML = '<p>They <hnw-mark data-lemma="abandon"><hnw-w>abandoned</hnw-w></hnw-mark> it.</p>';
    mark = document.querySelector('hnw-mark')!;
  });
  afterEach(() => view?.destroy());

  it('加载中显示骨架，update 后显示释义、词形与词书标签；激活单词带标记', () => {
    view = new ShadowCardView(document, makeActions(), makeBackend());
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
    // 无可删除来源时不显示移出
    expect(q('[data-act="delete"]')).toBeNull();
    view.close();
    expect(mark.hasAttribute('data-hnw-active')).toBe(false);
  });

  it('文本一律作为文本节点渲染（不解析 HTML）', () => {
    view = new ShadowCardView(document, makeActions(), makeBackend());
    view.open(mark, data({ surface: '<img src=x onerror=alert(1)>', entry: { word: 'abandon', phonetic: '', short: '<b>放弃</b>', full: '' } }));
    expect(shadow().querySelector('img')).toBeNull();
    expect(shadow().querySelector('.defs b')).toBeNull();
    expect(q('.defs')!.textContent).toContain('<b>放弃</b>');
  });

  it('查询无结果时显示“暂无释义”', () => {
    view = new ShadowCardView(document, makeActions(), makeBackend());
    view.open(mark, data());
    view.update(data());
    expect(q('.loading')).toBeNull();
    expect(q('.empty')!.textContent).toContain('暂无释义');
  });

  it('认识：关闭卡片，toast 写明记入哪里与移除了什么，撤销显示后台结果', async () => {
    const actions = makeActions();
    view = new ShadowCardView(document, actions, makeBackend());
    view.open(mark, data());
    await flush();
    // 说明行：认识写到哪里
    expect(q('.hints')!.textContent).toContain('记入 本地熟词本');
    q('[data-act="known"]')!.click();
    await flush();
    expect(actions.markKnown).toHaveBeenCalledWith('abandon', 'abandoned');
    expect(view.isOpen).toBe(false);
    const toast = q('.toast')!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('「abandon」已标为熟词，记入“本地熟词本”');
    expect(toast.textContent).toContain('已从“我的生词本”删除 abandon');
    expect(toast.textContent).not.toContain('已标记为熟词；');
    toast.querySelector('button')!.click();
    await flush();
    expect(actions.unmarkKnown).toHaveBeenCalledWith('abandon');
    expect(q('.toast')!.textContent).toContain('已加回 abandon');
  });

  it('认识：含不可撤销的远端删除与同形异义词时先确认；勾选后带 confirmed 再调用', async () => {
    const actions = makeActions({
      markKnown: vi.fn(async (lemma: string) => ({
        ok: true,
        lemma,
        deleted: [],
        message: '已标记为熟词',
        withheld: [{ bookId: 'src:youdao:0', name: '有道词典 · 无标签', words: ['lay'] }],
      })),
    });
    const backend = makeBackend({
      preview: vi.fn(async (action: 'add' | 'known') =>
        action === 'add'
          ? preview('add')
          : preview('known', {
              remove: [{ bookId: 'src:youdao:0', name: '有道词典 · 无标签', ok: true, words: ['lie', 'lay'], remote: true, undoable: false, homographs: ['lay'] }],
              needsConfirm: true,
            }),
      ),
    });
    view = new ShadowCardView(document, actions, backend);
    view.open(mark, data());
    await flush();
    q('[data-act="known"]')!.click();
    await flush();
    expect(actions.markKnown).not.toHaveBeenCalled();
    const panel = q('.panel.warn')!;
    expect(panel.textContent).toContain('从“有道词典 · 无标签”删除 lie（撤销时无法恢复）');
    expect(panel.textContent).toContain('同时删除 lay');
    const cb = panel.querySelector<HTMLInputElement>('input[data-homographs]')!;
    expect(cb.checked).toBe(false);
    cb.click();
    q('[data-act="known-confirm"]')!.click();
    await flush();
    expect(actions.markKnown).toHaveBeenCalledWith('abandon', 'abandoned');
    expect(backend.confirmKnown).toHaveBeenCalledWith('abandoned', 'abandon');
    expect(q('.toast')!.textContent).toContain('删除 lay');
  });

  it('加入生词本：按默认目标加入，toast 写明加到哪里，按钮变为已收藏，可撤销', async () => {
    const backend = makeBackend();
    view = new ShadowCardView(document, makeActions(), backend);
    view.open(mark, data({ entry: { word: 'abandon', phonetic: 'ә', short: '放弃', full: '' } }));
    await flush();
    expect(q('.hints')!.textContent).toContain('写入 我的生词本');
    q('[data-act="add"]')!.click();
    await flush();
    expect(backend.addWord).toHaveBeenCalledWith({ word: 'abandoned', lemma: 'abandon', trans: '放弃', phonetic: 'ә' });
    expect(q('.toast')!.textContent).toContain('已加入“我的生词本”');
    expect(q('[data-act="add"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-act="add"]')!.textContent).toContain('已在生词本');
    q('.toast button')!.click();
    await flush();
    expect(backend.removeWord).toHaveBeenCalledWith('abandon', ['local:mine']);
    expect(q('.toast')!.textContent).toContain('已撤销加入');
    expect(q('[data-act="add"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('加入生词本：失败时警示 toast，按钮保持未收藏', async () => {
    const backend = makeBackend({
      addWord: vi.fn(async () => ({
        ok: false,
        lemma: 'abandon',
        added: [{ bookId: 'src:youdao:0', name: '有道词典 · 无标签', ok: false, words: [], error: '未登录' }],
        removedKnown: [],
        message: '加入失败；“有道词典 · 无标签”失败：未登录',
      })),
    });
    view = new ShadowCardView(document, makeActions(), backend);
    view.open(mark, data());
    await flush();
    q('[data-act="add"]')!.click();
    await flush();
    expect(q('.toast')!.classList.contains('err')).toBe(true);
    expect(q('.toast')!.textContent).toContain('未登录');
    expect(q('.toast button')).toBeNull();
    expect(q('[data-act="add"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('加入生词本：在卡片上临时改目标，不支持的目标置灰并显示原因', async () => {
    const backend = makeBackend();
    view = new ShadowCardView(document, makeActions(), backend);
    view.open(mark, data());
    await flush();
    q('[data-act="targets"]')!.click();
    const panel = q('.panel')!;
    const boxes = [...panel.querySelectorAll<HTMLInputElement>('input[data-target]')];
    expect(boxes.map((b) => [b.dataset.target, b.checked, b.disabled])).toEqual([
      ['local:mine', true, false],
      ['src:youdao:0', false, false],
      ['src:youdao:9', false, true],
    ]);
    expect(panel.textContent).toContain('有道只能加到默认分组');
    boxes[1]!.click();
    expect(q('[data-act="targets-apply"]')!.textContent).toContain('2');
    q('[data-act="targets-apply"]')!.click();
    await flush();
    expect(backend.addWord).toHaveBeenCalledWith(expect.objectContaining({ targets: ['local:mine', 'src:youdao:0'] }));
    expect(q('.toast')!.textContent).toContain('“有道词典 · 无标签”');
    expect(q('.toast')!.textContent).not.toContain('暂不支持临时目标');
    expect(q('.panel')).toBeNull();
  });

  it('加入生词本：默认目标都不支持加词时按钮置灰，点按说明原因并打开目标选择', async () => {
    const backend = makeBackend({
      listAddTargets: vi.fn(async () => [
        target({ id: 'local:mine', name: '我的生词本' }),
        target({ id: 'src:youdao:9', name: '有道词典 · 托福', remote: true, isDefault: true, disabledReason: '有道只能加到默认分组' }),
      ]),
    });
    view = new ShadowCardView(document, makeActions(), backend);
    view.open(mark, data());
    await flush();
    const btn = q('[data-act="add"]')!;
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(q('.hint.has-warn')!.textContent).toContain('有道只能加到默认分组');
    btn.click();
    await flush();
    expect(backend.addWord).not.toHaveBeenCalled();
    expect(q('.toast')!.textContent).toContain('无法加入');
    expect(q('.panel')).not.toBeNull();
  });

  it('移出来源生词本：两步确认后才调用；来源只读时置灰并说明', async () => {
    const actions = makeActions();
    view = new ShadowCardView(document, actions, makeBackend());
    view.open(mark, data({ books: [eudic, cet6], deletableBooks: [eudic] }));
    await flush();
    expect(q('.tag.user')!.textContent).toBe('欧路·生词本');
    q('[data-act="delete"]')!.click();
    await flush();
    expect(actions.deleteFromSources).not.toHaveBeenCalled();
    expect(q('[data-act="delete"]')!.textContent).toContain('确认');
    q('[data-act="delete"]')!.click();
    await flush();
    expect(actions.deleteFromSources).toHaveBeenCalledWith('abandon', ['src:eudic:-1']);
    expect(view.isOpen).toBe(false);
    expect(q('.toast')!.textContent).toContain('已删除');

    view.destroy();
    const actions2 = makeActions();
    const ro = { canDelete: false, readOnlyReason: '欧路已掌握单词只读' } as SourceBookState;
    view = new ShadowCardView(document, actions2, makeBackend({ sourceStates: vi.fn(async () => ({ 'src:eudic:-1': ro })) }));
    view.open(mark, data({ books: [eudic], deletableBooks: [eudic] }));
    await flush();
    expect(q('[data-act="delete"]')!.getAttribute('aria-disabled')).toBe('true');
    q('[data-act="delete"]')!.click();
    await flush();
    expect(actions2.deleteFromSources).not.toHaveBeenCalled();
    expect(q('.toast')!.textContent).toContain('欧路已掌握单词只读');
  });

  it('已收藏：点按移出，可撤销加回原生词本', async () => {
    const backend = makeBackend({ getWordState: vi.fn(async () => ({ collected: true, collectedIn: ['local:mine'], known: false })) });
    view = new ShadowCardView(document, makeActions(), backend);
    view.open(mark, data());
    await flush();
    expect(q('[data-act="add"]')!.textContent).toContain('已在生词本');
    q('[data-act="add"]')!.click();
    await flush();
    expect(backend.removeWord).toHaveBeenCalledWith('abandon', ['local:mine']);
    q('.toast button')!.click();
    await flush();
    expect(backend.addWord).toHaveBeenCalledWith(expect.objectContaining({ targets: ['local:mine'] }));
  });

  it('强调色取自单词的高亮颜色并保证可读', () => {
    document.body.innerHTML = '<p><hnw-mark data-lemma="abandon"><hnw-w style="text-decoration-line: underline; text-decoration-color: rgb(255, 220, 0)">abandon</hnw-w></hnw-mark></p>';
    view = new ShadowCardView(document, makeActions(), makeBackend());
    view.open(document.querySelector('hnw-mark')!, data());
    const accent = q('.card')!.style.getPropertyValue('--accent');
    const rgb = accent.match(/\d+/g)!.map(Number);
    // 黄色在白底上不可读：保持色相调暗
    expect(rgb[0]).toBeGreaterThan(rgb[2]!);
    expect(luminance(accent)).toBeLessThan(0.2);
  });

  it('窄视口使用底部卡片布局，toast 移到顶部', async () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
    view = new ShadowCardView(document, makeActions(), makeBackend());
    view.open(mark, data());
    expect(q('.card')!.classList.contains('sheet')).toBe(true);
    await flush();
    q('[data-act="add"]')!.click();
    await flush();
    expect(q('.toast')!.classList.contains('top')).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('word-actions', () => {
  it('buildAddTargets：本地在前、来源熟词本排除、不可写与未启用来源的处理', () => {
    const settings = createDefaultSettings();
    settings.sources.youdao!.enabled = true;
    settings.wordActions.addTargets = ['local:mine', 'src:youdao:9', 'src:eudic:x'];
    const st = (id: string, over: Partial<SourceBookState> = {}): SourceBookState => ({
      id,
      providerId: id.split(':')[1]!,
      remoteId: id.split(':')[2]!,
      name: id,
      status: 'ok',
      lastSyncAt: 1,
      lastAttemptAt: 1,
      wordCount: 1,
      ...over,
    });
    const sources = {
      books: {
        'src:youdao:0': st('src:youdao:0', { name: '无标签', canAdd: true }),
        'src:youdao:9': st('src:youdao:9', { name: '托福', canAdd: false, readOnlyReason: '有道只能加到默认分组' }),
        'src:eudic:x': st('src:eudic:x', { name: '测试', canAdd: true }),
        'src:eudic:mastered': st('src:eudic:mastered', { name: '已掌握', role: 'known' }),
      },
      providers: {},
    };
    const out = buildAddTargets(settings, sources, { books: {}, removed: {} });
    expect(out.map((t) => [t.id, t.isDefault, t.disabledReason ?? ''])).toEqual([
      ['local:mine', true, ''],
      ['src:youdao:0', false, ''],
      ['src:youdao:9', true, '有道只能加到默认分组'],
      ['src:eudic:x', true, '该来源未启用'],
    ]);
    expect(out[0]!.note).toContain('自动创建');
    expect(out[1]!.name).toContain('无标签');
  });

  it('describeKnownResult / describeAddResult / describePreview', () => {
    expect(
      describeKnownResult(
        {
          ok: true,
          lemma: 'run',
          deleted: [],
          message: '已标记为熟词；“欧路词典 · 已掌握单词”未处理：只读',
          written: [
            { bookId: 'known:local', name: '本地熟词本', ok: true, words: ['run'] },
            { bookId: 'src:eudic:mastered', name: '欧路词典 · 已掌握单词', ok: false, words: [], error: '只读', skipped: true },
          ],
        },
        'run',
      ),
    ).toBe('「run」已标为熟词，记入“本地熟词本”；“欧路词典 · 已掌握单词”未处理：只读');
    const added = { ok: true, lemma: 'run', added: [{ bookId: 'local:mine', name: '我的生词本', ok: true, words: ['run'] }], removedKnown: [], message: '已加入“我的生词本”' };
    expect(describeAddResult(added)).toBe('已加入“我的生词本”');
    expect(describeAddResult(added, ['src:youdao:0'])).toContain('暂不支持临时目标');
    const p = describePreview({
      action: 'known',
      lemma: 'run',
      write: [
        { bookId: 'src:eudic:mastered', name: '欧路·已掌握', ok: false, words: ['run'], remote: true, undoable: true, error: '只读', skipped: true },
      ],
      remove: [{ bookId: 'local:mine', name: '我的生词本', ok: true, words: ['run', 'ran'], remote: false, undoable: true }],
      needsConfirm: false,
    });
    expect(p.text).toBe('记入 本地熟词本；并从 我的生词本（run、ran） 移除；欧路·已掌握：只读，已跳过');
    expect(p.warn).toBe(true);
  });

  it('fitContrast：已达标的颜色不变，浅色调到达标', () => {
    expect(fitContrast([0, 0, 0, 1], [255, 255, 255, 1], 4.5)).toEqual([0, 0, 0, 1]);
    const c = fitContrast([255, 196, 0, 0.3], [255, 255, 255, 1], 4.5);
    expect(luminance(c)).toBeLessThan(0.19);
  });

  it('card 源码不使用 innerHTML', () => {
    const dir = path.resolve(__dirname, '../../src/content/card');
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
    }
  });
});

describe('bindCardTrigger', () => {
  it('触屏：点按单词打开并阻止默认行为，再次点按放行；点外部关闭', () => {
    document.body.innerHTML = '<a href="#x"><hnw-mark data-lemma="abandon">abandon</hnw-mark></a><p id="out">out</p>';
    const view = new ShadowCardView(document, makeActions(), makeBackend());
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
