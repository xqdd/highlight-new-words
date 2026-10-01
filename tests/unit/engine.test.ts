import { beforeEach, describe, expect, it } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Dictionary } from '@/core/dict/types';
import { HighlightEngine, shortenTranslation } from '@/content/engine/engine';
import { highlightTextNode, unwrapAll } from '@/content/engine/highlighter';
import { collectTextNodes } from '@/content/engine/scanner';

const book = createSetWordBook(
  { id: 'cet4', name: 'cet4', nameEn: 'cet4', short: '四级', kind: 'builtin', category: 'exam', level: 3, size: 0 },
  ['abandon', 'scrutinize', 'premise'],
);
const matcher = () => new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book], known: new Set() });
const dict: Dictionary = {
  lookup: async (w) => ({ word: w, short: 'v. 放弃；抛弃' }),
  lookupMany: async (ws) => new Map([...ws].map((w) => [w, { word: w, short: 'v. 放弃；抛弃' }])),
};
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('scanner', () => {
  it('跳过 script/code/input/contenteditable 与自身节点', () => {
    document.body.innerHTML = `<p>abandon here</p><code>abandon</code><script>var abandon</script>
      <div contenteditable="true">abandon</div><hnw-mark>abandon</hnw-mark><textarea>abandon</textarea>`;
    const texts = collectTextNodes(document.body).map((t) => t.data);
    expect(texts).toEqual(['abandon here']);
  });
});

describe('highlightTextNode', () => {
  it('保留原文本节点并包裹命中词，可还原', () => {
    document.body.innerHTML = '<p>They abandoned the premise quickly.</p>';
    const p = document.querySelector('p')!;
    const original = p.firstChild as Text;
    const marks = highlightTextNode(original, (w) => matcher().match(w));
    expect(marks.map((m) => m.textContent)).toEqual(['abandoned', 'premise']);
    expect(marks[0]!.getAttribute('data-lemma')).toBe('abandon');
    expect(p.firstChild).toBe(original);
    expect(p.textContent).toBe('They abandoned the premise quickly.');
    unwrapAll(document.body);
    expect(p.querySelector('hnw-mark')).toBeNull();
    expect(p.textContent).toBe('They abandoned the premise quickly.');
  });
});

describe('HighlightEngine', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p>They abandoned the premise.</p>';
  });

  it('全量扫描、增量插入、行内翻译与停止', async () => {
    const reported: string[][] = [];
    const engine = new HighlightEngine({
      root: document.body,
      matcher: matcher(),
      dictionary: dict,
      inlineTranslation: 'after',
      onLemmasChanged: (l) => reported.push(l),
    });
    engine.start();
    await flush();
    expect(document.querySelectorAll('hnw-mark').length).toBe(2);
    expect(document.querySelector('hnw-mark hnw-tr')?.getAttribute('data-tr')).toBe('放弃');
    expect(document.querySelector('hnw-mark')?.textContent).toBe('abandoned');

    const div = document.createElement('div');
    div.textContent = 'Officials scrutinized it.';
    document.body.appendChild(div);
    await flush();
    expect(div.querySelector('hnw-mark')?.getAttribute('data-lemma')).toBe('scrutinize');
    expect(new Set(engine.matchedLemmas)).toEqual(new Set(['abandon', 'premise', 'scrutinize']));

    engine.removeLemma('premise');
    expect(document.querySelectorAll('hnw-mark[data-lemma="premise"]').length).toBe(0);

    engine.stop();
    expect(document.querySelectorAll('hnw-mark').length).toBe(0);
    expect(document.body.textContent).toContain('They abandoned the premise.');
  });
});

describe('shortenTranslation', () => {
  it('取第一个义项并去词性', () => {
    expect(shortenTranslation('vt. 放弃, 抛弃')).toBe('放弃');
  });
});
