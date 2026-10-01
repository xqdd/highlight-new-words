import { afterEach, describe, expect, it } from 'vitest';
import type { Lemmatizer } from '@/core/lemma/types';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Dictionary, DictEntry } from '@/core/dict/types';
import { createDefaultSettings } from '@/core/settings/defaults';
import { BUILTIN_THEMES } from '@/core/theme/themes';
import { HighlightEngine } from '@/content/engine/engine';
import { buildPageCss } from '@/content/engine/style';

const flush = () => new Promise((r) => setTimeout(r, 40));
const bookOf = (words: string[]) =>
  createSetWordBook({ id: 'b', name: 'b', nameEn: 'b', short: 'b', kind: 'builtin', category: 'exam', level: 3, size: 0 }, words);
const dictOf = (entries: Record<string, Partial<DictEntry>>): Dictionary => ({
  lookup: async (w) => (entries[w] ? { word: w, ...entries[w] } : undefined),
  lookupMany: async (ws) => new Map([...ws].filter((w) => entries[w]).map((w) => [w, { word: w, ...entries[w] }])),
});

let engine: HighlightEngine | undefined;
afterEach(() => {
  engine?.stop();
  engine = undefined;
  document.body.innerHTML = '';
});

describe('E1 派生词借词根命中时取屈折原形的释义', () => {
  // 模拟词形还原器（不依赖正在演进的打包词形数据）：页面词形 -> 屈折原形 / 派生词根，形状与 DataLemmatizer.analyze 一致
  const table: Record<string, { inflections: string[]; derivations: string[] }> = {
    projections: { inflections: ['projection'], derivations: ['project'] },
    consequences: { inflections: ['consequence'], derivations: ['consequent'] },
    proposals: { inflections: ['proposal'], derivations: ['propose'] },
    citing: { inflections: ['cite', 'cit'], derivations: [] },
    advocating: { inflections: ['advocate', 'advocat'], derivations: [] },
    committee: { inflections: [], derivations: ['commit'] },
  };
  const lemmatizer: Lemmatizer = {
    analyze: (w) => {
      const base = w.toLowerCase();
      return { base, inflections: table[base]?.inflections ?? [], derivations: table[base]?.derivations ?? [], fromTable: !!table[base] };
    },
    candidates: (w) => {
      const base = w.toLowerCase();
      return [...new Set([base, ...(table[base]?.inflections ?? []), ...(table[base]?.derivations ?? [])])];
    },
  };

  const dict = dictOf({
    project: { short: 'n. 项目' },
    projection: { short: 'n. 预测, 投射' },
    consequent: { short: 'a. 作为结果的' },
    consequence: { short: 'n. 后果, 结果' },
    proposal: { short: 'n. 提议, 建议' },
    cite: { short: 'v. 引用' },
    advocate: { short: 'n. 提倡者', shortVerb: '提倡' },
  });

  it('projections（词书只收 project）显示“预测”，consequences 显示“后果”；proposals/citing 回退原形', async () => {
    document.body.innerHTML = '<p>the projections and consequences of proposals citing data, advocating change</p>';
    const matcher = new WordMatcher({ lemmatizer, books: [bookOf(['project', 'consequent', 'proposal', 'cite', 'advocate'])], known: new Set() });
    engine = new HighlightEngine({ root: document.body, matcher, dictionary: dict, inlineTranslation: 'after' });
    engine.start();
    await flush();
    const got = [...document.querySelectorAll('hnw-mark')].map((m) => [m.getAttribute('data-lemma'), m.querySelector('hnw-tr')?.getAttribute('data-tr')]);
    expect(got).toEqual([
      ['project', '预测'],
      ['consequent', '后果'],
      ['proposal', '提议'],
      ['cite', '引用'],
      // 动词变形：屈折原形的动词释义优先
      ['advocate', '提倡'],
    ]);
  });

  it('WordMatcher.inflectionOf 只给屈折原形，不给派生词根', () => {
    const matcher = new WordMatcher({ lemmatizer, books: [bookOf(['project'])], known: new Set() });
    expect(matcher.inflectionOf('projections')).toBe('projection');
    expect(matcher.inflectionOf('committee')).toBeUndefined();
    // 不提供 analyze 的还原器（SimpleLemmatizer 等）：没有屈折原形，行为与修复前一致
    expect(new WordMatcher({ lemmatizer: { candidates: (w) => [w] }, books: [], known: new Set() }).inflectionOf('projections')).toBeUndefined();
  });
});

describe('E2 预设不重名', () => {
  it('内置预设的中文名与英文名都唯一；旧 id wavy 仍可用', () => {
    const names = BUILTIN_THEMES.map((t) => t.name);
    const namesEn = BUILTIN_THEMES.map((t) => t.nameEn);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(namesEn).size).toBe(namesEn.length);
    const wavy = BUILTIN_THEMES.find((t) => t.id === 'wavy');
    expect(wavy?.mark.underline).toBe('wavy');
    expect(wavy?.name).not.toBe(BUILTIN_THEMES.find((t) => t.id === 'wavy-line')?.name);
  });
});

describe('E3 受限容器中的装饰线降级', () => {
  it('波浪线：受限容器 mark 偏移收为 1px 并降为实线；非受限规则不变', () => {
    const s = createDefaultSettings();
    s.style.themeId = 'wavy-line';
    const css = buildPageCss(s);
    expect(css).toContain('hnw-mark:where([data-hnw-tight])>hnw-w{text-underline-offset:1px;text-decoration-style:solid}');
    // 非受限：原样保留波浪线与 4px 偏移
    const base = css.split('\n').find((r) => r.startsWith('hnw-mark>hnw-w{'))!;
    expect(base).toContain('text-decoration-style: wavy');
    expect(base).toContain('text-underline-offset: 4px');
  });

  it('双下划线降为实线；实线只收偏移不改线型', () => {
    const s = createDefaultSettings();
    s.style.themeId = 'custom';
    s.style.custom.mark = { background: '', color: '', underline: 'solid', underlineDouble: true, underlineColor: '#7c3aed', underlineOffset: 5 };
    expect(buildPageCss(s)).toContain('hnw-mark:where([data-hnw-tight])>hnw-w{text-underline-offset:1px;text-decoration-style:solid}');
    s.style.custom.mark = { background: '', color: '', underline: 'solid', underlineColor: '#7c3aed', underlineOffset: 5 };
    const css = buildPageCss(s);
    expect(css).toContain('hnw-mark:where([data-hnw-tight])>hnw-w{text-underline-offset:1px}');
    expect(css).not.toContain('hnw-mark:where([data-hnw-tight])>hnw-w{text-underline-offset:1px;text-decoration-style:solid}');
  });

  it('受限容器中的 mark 命中降级规则（DOM 中验证）', () => {
    document.body.innerHTML = `<style>${buildPageCss(createDefaultSettings())}</style><hnw-mark data-hnw-tight><hnw-w>x</hnw-w></hnw-mark>`;
    expect(document.querySelector('hnw-w')!.matches('hnw-mark:where([data-hnw-tight])>hnw-w')).toBe(true);
  });
});

/** 按顶层逗号拆分选择器列表（:is(h1,h2) 里的逗号不拆） */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

describe('E5 桌面端不显示括注的 mark 悬停兜底浮层', () => {
  const settings = () => {
    const s = createDefaultSettings();
    s.inlineTranslation.mode = 'after';
    return s;
  };
  /** 取 @media (hover:hover) 中的兜底浮层规则，返回去掉 :hover 的选择器列表 */
  function fallbackSelectors(css: string): string[] {
    const block = css.split('\n').find((r) => r.startsWith('@media (hover:hover){') && r.includes('[data-hnw-nogloss]:hover>hnw-tr[data-tr]'));
    expect(block, '兜底规则必须在 (hover:hover) 媒体查询中，触屏不受影响').toBeTruthy();
    const rule = block!.split('}').find((r) => r.includes(':hover>hnw-tr[data-tr]') && r.includes('position:absolute'))!;
    expect(rule).toContain('pointer-events:none!important');
    return splitSelectors(rule.replace(/^@media \(hover:hover\)\{/, '').split('{')[0]!).map((x) => x.replace(':hover', ''));
  }

  it('链接、标题、低置信度、密度省略的 mark 都有译文并命中悬停浮层规则；普通 mark 不命中', async () => {
    const css = buildPageCss(settings());
    const sels = fallbackSelectors(css);
    document.documentElement.setAttribute('data-hnw-tr', 'after');
    document.body.innerHTML = `<h2>abandon</h2><p>we <a href="#">abandon</a> it. Then Premise holds and abandon x abandon y</p>`;
    const matcher = new WordMatcher({ lemmatizer: { candidates: (w) => [w.toLowerCase()] }, books: [bookOf(['abandon', 'premise'])], known: new Set() });
    engine = new HighlightEngine({ root: document.body, matcher, dictionary: dictOf({ abandon: { short: 'v. 放弃' }, premise: { short: 'n. 前提' } }), inlineTranslation: 'after' });
    engine.start();
    await flush();
    const marks = [...document.querySelectorAll('hnw-mark')];
    const kinds = marks.map((m) =>
      m.closest('h2') ? 'heading' : m.hasAttribute('data-hnw-link') ? 'link' : m.hasAttribute('data-hnw-lowconf') ? 'lowconf' : m.hasAttribute('data-hnw-nogloss') ? 'nogloss' : 'normal',
    );
    expect(kinds).toEqual(['heading', 'link', 'lowconf', 'normal', 'nogloss']);
    for (const [i, m] of marks.entries()) {
      const tr = m.querySelector('hnw-tr')!;
      expect(tr.getAttribute('data-tr')).toBeTruthy();
      const hit = sels.some((s) => tr.matches(s));
      expect(hit, `${kinds[i]} 是否命中兜底浮层`).toBe(kinds[i] !== 'normal');
    }
    document.documentElement.removeAttribute('data-hnw-tr');
  });

  it('ruby 模式同样兜底，且无释义的占位注解不弹空浮层', () => {
    const s = settings();
    s.inlineTranslation.mode = 'ruby';
    const sels = fallbackSelectors(buildPageCss(s));
    expect(sels.some((x) => x.startsWith('html[data-hnw-tr="ruby"]'))).toBe(true);
    expect(sels.every((x) => x.endsWith('>hnw-tr[data-tr]'))).toBe(true);
  });
});
