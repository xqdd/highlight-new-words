import { afterEach, describe, expect, it } from 'vitest';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Lemmatizer } from '@/core/lemma/types';
import type { Dictionary } from '@/core/dict/types';
import { HighlightEngine } from '@/content/engine/engine';
import { isVisuallyHidden, shouldSkipElement } from '@/content/engine/dom';
import { collectTextNodes, isTextCandidate } from '@/content/engine/scanner';

const flush = () => new Promise((r) => setTimeout(r, 40));
const lemmatizer: Lemmatizer = {
  analyze: (w) => ({ base: w.toLowerCase(), inflections: [], derivations: [], fromTable: false }),
  candidates: (w) => [w.toLowerCase()],
};
const book = createSetWordBook({ id: 'b', name: 'b', nameEn: 'b', short: 'b', kind: 'builtin', category: 'exam', level: 3, size: 0 }, ['navigation', 'photosynthesis', 'repository']);

const dictionary: Dictionary = { lookup: async () => undefined, lookupMany: async () => new Map() };

let engine: HighlightEngine | undefined;
afterEach(() => {
  engine?.stop();
  engine = undefined;
  document.body.innerHTML = '';
});

describe('视觉隐藏（读屏专用）元素不标注', () => {
  it('常见类名：sr-only / visually-hidden / screen-reader-text / mw-jump-link / show-on-focus skip link / 哈希类名', () => {
    const cases = [
      'sr-only',
      'sr-only mt-n1',
      'visually-hidden',
      'screen-reader-text',
      'mw-jump-link',
      'px-2 color-bg-accent-emphasis show-on-focus js-skip-to-content',
      'prc-VisuallyHidden-VisuallyHidden-Q0qSB',
      'MarketingHeader-module__visuallyHidden__sqKsl',
      'PRIVATE_VisuallyHidden prc-TreeView-TreeViewVisuallyHidden-1N8xK',
    ];
    for (const c of cases) {
      const el = document.createElement('span');
      el.className = c;
      expect(isVisuallyHidden(el), c).toBe(true);
      expect(shouldSkipElement(el), c).toBe(true);
    }
    // 普通类名、仅 overflow-hidden 的容器不受影响
    for (const c of ['overflow-hidden', 'hidden-sm', 'markdown-body', 'skip']) {
      const el = document.createElement('div');
      el.className = c;
      expect(isVisuallyHidden(el), c).toBe(false);
    }
  });

  it('内联样式：clip:rect(0 0 0 0)、clip:rect(1px,1px,1px,1px)、clip-path:inset(50%)、1px×1px+overflow:hidden', () => {
    const hidden = [
      'position:absolute;clip:rect(0 0 0 0);',
      'position:absolute!important;clip:rect(1px,1px,1px,1px)',
      'clip-path: inset(50%); position:absolute',
      'position:absolute;width:1px;height:1px;overflow:hidden;margin:-1px',
    ];
    for (const s of hidden) {
      const el = document.createElement('span');
      el.setAttribute('style', s);
      expect(isVisuallyHidden(el), s).toBe(true);
    }
    for (const s of ['width:100px;height:1px;overflow:hidden', 'overflow:hidden', 'max-width:1px;height:10px', 'clip:auto']) {
      const el = document.createElement('span');
      el.setAttribute('style', s);
      expect(isVisuallyHidden(el), s).toBe(false);
    }
  });

  it('扫描时整棵子树跳过，增量处理的文本节点也按祖先判定跳过', () => {
    document.body.innerHTML =
      '<a class="mw-jump-link" href="#content">Jump to <b>navigation</b></a>' +
      '<h2 class="sr-only">Repository navigation</h2>' +
      '<span style="position:absolute;width:1px;height:1px;overflow:hidden">photosynthesis</span>' +
      '<p>visible photosynthesis</p>';
    expect(collectTextNodes(document.body).map((t) => t.data)).toEqual(['visible photosynthesis']);
    const inner = document.querySelector('b')!.firstChild as Text;
    expect(isTextCandidate(inner)).toBe(false);
  });

  it('引擎只标注可见正文中的生词', async () => {
    document.body.innerHTML =
      '<a class="px-2 show-on-focus js-skip-to-content" href="#start">Skip to navigation</a>' +
      '<div class="prc-VisuallyHidden-VisuallyHidden-Q0qSB">repository photosynthesis</div>' +
      '<p>The repository explains photosynthesis.</p>';
    const matcher = new WordMatcher({ lemmatizer, books: [book], known: new Set() });
    engine = new HighlightEngine({ root: document.body, matcher, dictionary, inlineTranslation: 'off' });
    engine.start();
    await flush();
    const marks = [...document.querySelectorAll('hnw-mark')];
    expect(marks.map((m) => m.closest('p') !== null)).toEqual([true, true]);
    expect(document.querySelector('a hnw-mark, div hnw-mark')).toBeNull();
  });
});
