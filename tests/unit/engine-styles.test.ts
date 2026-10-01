import { describe, expect, it } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createSetWordBook } from '@/core/wordbook/registry';
import type { Dictionary } from '@/core/dict/types';
import { createDefaultSettings } from '@/core/settings/defaults';
import { normalizeSettings } from '@/core/settings/migrate';
import { BUILTIN_THEMES, TRANSLATION_PRESETS, V5_PRESET_IDS, findTheme } from '@/core/theme/themes';
import {
  applyThemePreset,
  applyTranslationPreset,
  markStyleToCss,
  matchTranslationPreset,
  resolveMarkStyle,
  resolveTranslationStyle,
} from '@/core/theme/resolve';
import { DARK_PAGE_BG, LIGHT_PAGE_BG, contrast, ensureContrast, parseColor } from '@/content/engine/color';
import { tokenizeCode } from '@/content/engine/code';
import { HighlightEngine } from '@/content/engine/engine';
import { highlightTextNode } from '@/content/engine/highlighter';
import { collectTextNodes } from '@/content/engine/scanner';
import { buildPageCss } from '@/content/engine/style';

const book = createSetWordBook(
  { id: 'cet6', name: 'cet6', nameEn: 'cet6', short: '六级', kind: 'builtin', category: 'exam', level: 4, size: 0 },
  ['abandon', 'premium', 'element', 'volatile', 'scrutinize', 'commit', 'meticulous'],
);
const matcher = () => new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [book], known: new Set() });
const match = (w: string) => matcher().match(w);
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('v5 样式契约', () => {
  it('旧主题 id 全部保留，新增至少 10 套命名预设且 id 唯一', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    for (const old of ['amber', 'mint', 'sky', 'rose', 'violet', 'wavy', 'dotted', 'ink', 'orange-text', 'teal-text', 'dashed-orange', 'wavy-red', 'underline-tint', 'marker-lime']) {
      expect(ids).toContain(old);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(V5_PRESET_IDS.length).toBeGreaterThanOrEqual(10);
    for (const id of V5_PRESET_IDS) expect(findTheme(id)?.name).toBeTruthy();
  });

  it('旧样式（无 v5 字段）渲染与旧版一致', () => {
    const css = markStyleToCss({ background: 'rgba(255, 196, 0, 0.30)', color: '', underline: 'none', underlineColor: '' });
    expect(css).toBe('background-color: rgba(255, 196, 0, 0.30); text-decoration: inherit');
    const ul = markStyleToCss({ background: '', color: '', underline: 'wavy', underlineColor: '#f59e0b' });
    expect(ul).toContain('text-decoration-style: wavy');
    expect(ul).toContain('text-decoration-thickness: 1.5px');
    expect(ul).toContain('text-underline-offset: 3px');
  });

  it('各维度可组合：双线/粗细/偏移/字重/斜体/马克笔/胶囊/透明度/边框', () => {
    const css = markStyleToCss({
      background: '#ffd500',
      backgroundKind: 'marker',
      backgroundOpacity: 0.5,
      color: '#c2410c',
      underline: 'solid',
      underlineDouble: true,
      underlineColor: '#7c3aed',
      underlineThickness: 1,
      underlineOffset: 2,
      fontWeight: 'bold',
      italic: true,
      border: 'dashed',
      borderColor: '#0d9488',
    });
    expect(css).toContain('text-decoration-style: double');
    expect(css).toContain('text-decoration-thickness: 1px');
    expect(css).toContain('text-underline-offset: 2px');
    expect(css).toContain('font-weight: 700');
    expect(css).toContain('font-style: italic');
    expect(css).toContain('background-image: linear-gradient(to bottom, transparent 52%, color-mix(in srgb, #ffd500 50%, transparent) 58%');
    expect(css).toContain('outline: 1px dashed #0d9488');
    // 不占布局空间：不出现 padding / border
    expect(css).not.toMatch(/padding|(^|;\s*)border:/);
    const pill = markStyleToCss({ background: 'rgba(139,92,246,.2)', backgroundKind: 'pill', color: '', underline: 'none', underlineColor: '' });
    expect(pill).toContain('border-radius: 1em');
    expect(pill).toContain('box-shadow: 0 0 0 .16em');
  });

  it('“仅括号译文”等预设携带建议译文模式，applyThemePreset 一并应用', () => {
    const s = createDefaultSettings();
    applyThemePreset(s, 'gloss-only');
    expect(s.style.themeId).toBe('gloss-only');
    expect(s.inlineTranslation.mode).toBe('after');
    applyThemePreset(s, 'quiz-blur');
    expect(s.inlineTranslation.blur).toBe(true);
    applyThemePreset(s, 'ruby-gloss');
    expect(s.inlineTranslation).toMatchObject({ mode: 'ruby', blur: false });
    // 不带译文建议的预设不改动译文设置
    applyThemePreset(s, 'highlighter');
    expect(s.inlineTranslation.mode).toBe('ruby');
  });

  it('每套预设在亮色页与暗色页可读：文字色对比度、装饰色可见', () => {
    for (const t of BUILTIN_THEMES) {
      const m = t.mark;
      if (m.color) {
        const light = ensureContrast(m.color, LIGHT_PAGE_BG, 3) ?? m.color;
        const dark = ensureContrast(m.color, DARK_PAGE_BG, 4.5) ?? m.color;
        const bgOpaque = parseColor(m.background)?.a ?? 0;
        if (bgOpaque < 0.6) {
          expect(contrast(parseColor(light)!, LIGHT_PAGE_BG), `${t.id} light`).toBeGreaterThanOrEqual(3);
          expect(contrast(parseColor(dark)!, DARK_PAGE_BG), `${t.id} dark`).toBeGreaterThanOrEqual(4.5);
        }
      }
      if (V5_PRESET_IDS.includes(t.id) && m.underline !== 'none') {
        const c = ensureContrast(m.underlineColor, DARK_PAGE_BG, 3) ?? m.underlineColor;
        expect(contrast(parseColor(c)!, DARK_PAGE_BG), `${t.id} 线色`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('页面 CSS：深色上下文暖色底改为文字色 + 下划线、冷色底压低不透明度；链接内保留链接色与下划线、只用底色', () => {
    const s = createDefaultSettings();
    s.style.themeId = 'highlighter';
    const css = buildPageCss(s);
    // 荧光黄在深色页上不再铺暗橄榄色带
    expect(css).toContain('hnw-mark:where([data-hnw-dark])>hnw-w{background-color:transparent;background-image:none;box-shadow:none;color:rgb(255, 213, 0);text-decoration-line:underline');
    // 深色链接里补回浅底
    expect(css).toContain('hnw-mark:where([data-hnw-link][data-hnw-dark])>hnw-w{background-color:color-mix(in srgb,rgb(255, 213, 0) 24%,transparent)}');
    // 标题里的底色降级为下划线
    expect(css).toContain(':is(h1,h2,h3,h4,h5,h6) hnw-mark>hnw-w{background-color:transparent;background-image:none;box-shadow:none;text-decoration-line:underline');
    // 冷色半透明底在深色页上保留（不改成文字色）
    s.style.themeId = 'pill';
    expect(buildPageCss(s)).not.toContain('hnw-mark:where([data-hnw-dark])>hnw-w{background-color:transparent');
    s.style.themeId = 'bold-accent';
    const css2 = buildPageCss(s);
    expect(css2).toContain('hnw-mark:where([data-hnw-link])>hnw-w{color:inherit;text-decoration-line:none;outline:none;background-color:color-mix(in srgb,#c2410c 20%,transparent)}');
    s.style.themeId = 'wavy-line';
    // 装饰线类样式在链接里同样让位：去掉自身波浪线，改用同色浅底
    expect(buildPageCss(s)).toContain('hnw-mark:where([data-hnw-link])>hnw-w{color:inherit;text-decoration-line:none;outline:none;background-color:color-mix(in srgb,#f43f5e 20%,transparent)}');
    // 代码中装饰线收为 1px 直线；只有同段重复省略的不显示括注，链接、标题、受限容器照常显示
    expect(css2).toContain('hnw-mark[data-hnw-code]>hnw-w{text-decoration-style:solid!important;text-decoration-thickness:1px!important');
    expect(css2).not.toContain('html[data-hnw-tr="after"] hnw-mark[data-hnw-link]>hnw-tr');
    expect(css2).not.toContain('html[data-hnw-tr="after"] :is(h1,h2,h3,h4,h5,h6) hnw-mark>hnw-tr');
    expect(css2).not.toContain('html[data-hnw-tr="after"] hnw-mark[data-hnw-tight]>hnw-tr');
    expect(css2).toContain('html[data-hnw-tr="after"] hnw-mark[data-hnw-nogloss]>hnw-tr');
    // ruby 模式下受限容器的译文改为词后括注
    s.inlineTranslation.mode = 'ruby';
    expect(buildPageCss(s)).toContain(':is(html[data-hnw-tr="ruby"],html[data-hnw-tr="below"]) hnw-mark[data-hnw-tight]>hnw-tr[data-tr]::before{content:"(" attr(data-tr) ")"}');
    // 词下方：同一套 ruby 规则，只多 ruby-position:under
    expect(buildPageCss(s)).toContain('html[data-hnw-tr="below"] hnw-mark{ruby-position:under}');
    s.inlineTranslation.mode = 'off';
    // 按词书覆盖的 v5 字段也能生效
    s.style.perBook.cet6 = { mark: { underline: 'wavy', underlineColor: '#f43f5e', italic: true } };
    expect(resolveMarkStyle(s, 'cet6').italic).toBe(true);
    expect(buildPageCss(s)).toContain('hnw-mark[data-book="cet6"]>hnw-w{');
  });

  it('译文样式：颜色/透明度/字号可调，有缺省值并夹在合理范围', () => {
    const s = createDefaultSettings();
    s.inlineTranslation = { mode: 'after', color: '#64748b', opacity: 0.05, fontScale: 2 };
    expect(resolveTranslationStyle(s)).toEqual({
      mode: 'after',
      blur: false,
      color: '#64748b',
      opacity: 0.2,
      fontScale: 1,
      bracket: 'paren',
      background: '',
      italic: false,
      bold: false,
    });
    const css = buildPageCss(s);
    expect(css).toContain('font-size:1em;line-height:1;opacity:0.2;color:#64748b;');
    s.inlineTranslation = { mode: 'ruby' };
    expect(resolveTranslationStyle(s)).toMatchObject({ opacity: 0.7, fontScale: 0.55 });
  });

  it('译文括号：各选项生成对应 content，none 不加括号；缺省仍是半角括号且不追加底色/斜体/加粗', () => {
    const s = createDefaultSettings();
    s.inlineTranslation = { mode: 'after' };
    const base = buildPageCss(s);
    expect(base).toContain('html[data-hnw-tr="after"] hnw-tr::before{content:"(" attr(data-tr) ")"}');
    expect(base).toContain('vertical-align:baseline}');
    expect(base).not.toContain('font-style:italic');
    const cases: [NonNullable<typeof s.inlineTranslation.bracket>, string][] = [
      ['fullwidth', '"（" attr(data-tr) "）"'],
      ['square', '"[" attr(data-tr) "]"'],
      ['lenticular', '"【" attr(data-tr) "】"'],
      ['none', 'attr(data-tr)'],
    ];
    for (const [bracket, content] of cases) {
      s.inlineTranslation = { mode: 'after', bracket };
      const css = buildPageCss(s);
      expect(css).toContain(`html[data-hnw-tr="after"] hnw-tr::before{content:${content}}`);
      // 受限容器中 ruby 退回的词后括注同样使用所选括号
      s.inlineTranslation = { mode: 'ruby', bracket };
      expect(buildPageCss(s)).toContain(`hnw-mark[data-hnw-tight]>hnw-tr[data-tr]::before{content:${content}}`);
    }
    s.inlineTranslation = { mode: 'after', background: 'rgba(20, 184, 166, 0.14)', italic: true, bold: true, color: '#64748b' };
    const look = buildPageCss(s);
    expect(look).toContain('background:rgba(20, 184, 166, 0.14);padding:0 .3em;border-radius:.3em;font-style:italic;font-weight:700');
    // 深色上下文提亮译文颜色
    expect(look).toMatch(/hnw-mark\[data-hnw-dark\]>hnw-tr\{color:rgb\(/);
  });

  it('译文样式预设：应用后匹配该预设，经典清回缺省，微调后为自定义', () => {
    expect(new Set(TRANSLATION_PRESETS.map((p) => p.id)).size).toBe(TRANSLATION_PRESETS.length);
    const s = createDefaultSettings();
    s.inlineTranslation = { mode: 'after', blur: true, oncePerParagraph: false, opacity: 0.4 };
    expect(matchTranslationPreset(s.inlineTranslation)).toBeUndefined();
    for (const p of TRANSLATION_PRESETS) {
      applyTranslationPreset(s, p.id);
      expect(matchTranslationPreset(s.inlineTranslation)?.id).toBe(p.id);
      // 预设不改模式、模糊自测与同段只显示一次
      expect(s.inlineTranslation).toMatchObject({ mode: 'after', blur: true, oncePerParagraph: false });
    }
    applyTranslationPreset(s, 'classic');
    expect(s.inlineTranslation.opacity).toBeUndefined();
    expect(s.inlineTranslation.bold).toBeUndefined();
    // 显式写成模式缺省值、颜色大小写不同也视为匹配
    s.inlineTranslation = { mode: 'ruby', color: '', opacity: 0.7, bracket: 'paren' };
    expect(matchTranslationPreset(s.inlineTranslation)?.id).toBe('classic');
    s.inlineTranslation = { mode: 'after', color: '#6B7280', opacity: 0.9, bracket: 'square' };
    expect(matchTranslationPreset(s.inlineTranslation)?.id).toBe('square-gray');
    s.inlineTranslation = { ...s.inlineTranslation, italic: true };
    expect(matchTranslationPreset(s.inlineTranslation)).toBeUndefined();
  });

  it('旧设置缺少 v5/v8 字段时 normalizeSettings 补齐默认值', () => {
    const s = normalizeSettings({ inlineTranslation: { mode: 'ruby' } });
    expect(s.inlineTranslation).toMatchObject({ mode: 'ruby', blur: false });
    expect(s.code).toEqual({ enabled: false, scope: 'comments', display: 'hover' });
  });
});

describe('代码块（v8）', () => {
  it('标识符拆分：camelCase / PascalCase / snake_case / kebab-case / 数字', () => {
    const words = (s: string) => tokenizeCode(s).map((t) => t.word);
    expect(words('getElementById')).toEqual(['get', 'Element', 'By', 'Id']);
    expect(words('XMLHttpRequest')).toEqual(['XML', 'Http', 'Request']);
    expect(words('user_name2_field')).toEqual(['user', 'name', 'field']);
    expect(words('abandon-premium')).toEqual(['abandon', 'premium']);
    const t = tokenizeCode('x.getElementById')[2]!;
    expect('x.getElementById'.slice(t.start, t.end)).toBe('Element');
  });

  it('默认关闭；开启后按范围处理，编辑器始终跳过', () => {
    document.body.innerHTML = `<pre><code><span class="hljs-comment">// abandon it</span>
const volatileElement = 1;</code></pre><p>see <code>scrutinizeInput</code></p>
      <div class="monaco-editor"><div>abandon</div></div><div class="cm-editor"><div class="cm-line">abandon</div></div>`;
    expect(collectTextNodes(document.body).map((t) => t.data)).toEqual(['see ']);
    const comments = collectTextNodes(document.body, undefined, { codeEnabled: true, codeScope: 'comments' }).map((t) => t.data);
    expect(comments).toEqual(['// abandon it', 'see ']);
    const all = collectTextNodes(document.body, undefined, { codeEnabled: true, codeScope: 'all' }).map((t) => t.data.trim());
    expect(all).toEqual(['// abandon it', 'const volatileElement = 1;', 'see', 'scrutinizeInput']);
  });

  it('GitHub 新代码视图（div 行，无 pre/code）同样受开关与范围控制', () => {
    document.body.innerHTML = `<div class="react-code-lines"><div class="react-code-text react-code-line-contents"><div>
      <div class="react-file-line html-div" data-testid="code-cell"><span class="pl-c">// abandon the directory</span></div>
      <div class="react-file-line html-div" data-testid="code-cell"><span class="pl-k">import</span> volatileElement <span class="pl-s">'premium'</span></div>
      </div></div></div><p>see it</p>`;
    expect(collectTextNodes(document.body).map((t) => t.data)).toEqual(['see it']);
    const comments = collectTextNodes(document.body, undefined, { codeEnabled: true, codeScope: 'comments' }).map((t) => t.data);
    expect(comments).toEqual(['// abandon the directory', "'premium'", 'see it']);
    const all = collectTextNodes(document.body, undefined, { codeEnabled: true, codeScope: 'all' }).map((t) => t.data.trim());
    expect(all).toContain('volatileElement');
  });

  it('代码中高亮落在子串上、跳过编程熟词、不插入译文，复制文本不变', async () => {
    document.body.innerHTML = `<pre><code>function getElementById(premium) { return abandonDefault; }</code></pre>`;
    const dict: Dictionary = {
      lookup: async (w) => ({ word: w, short: '译' }),
      lookupMany: async (ws) => new Map([...ws].map((w) => [w, { word: w, short: '译' }])),
    };
    const engine = new HighlightEngine({
      root: document.body,
      matcher: new WordMatcher({ lemmatizer: new SimpleLemmatizer(), books: [createSetWordBook(book.meta, ['element', 'premium', 'abandon', 'default', 'function', 'return'])], known: new Set() }),
      dictionary: dict,
      inlineTranslation: 'after',
      code: { enabled: true, scope: 'all', display: 'hover' },
    });
    engine.start();
    await flush();
    const marks = [...document.querySelectorAll('hnw-mark')];
    expect(marks.map((m) => m.textContent)).toEqual(['Element', 'premium', 'abandon']);
    expect(marks.every((m) => m.getAttribute('data-hnw-code') === 'identifier')).toBe(true);
    expect(document.querySelectorAll('hnw-tr').length).toBe(0);
    expect(document.querySelector('pre')!.textContent).toBe('function getElementById(premium) { return abandonDefault; }');
    engine.stop();
  });
});

describe('受限容器、链接与译文', () => {
  const dict: Dictionary = {
    lookup: async (w) => ({ word: w, short: w === 'committee' ? '委员会' : 'v. 放弃' }),
    lookupMany: async (ws) => new Map([...ws].filter((w) => w !== 'nothing').map((w) => [w, { word: w, short: w === 'committee' ? 'n. 委员会' : 'v. 放弃' }])),
  };
  it('nowrap / ellipsis / 按钮中的 mark 标记为受限，行内 nowrap 不算；链接内标记 data-hnw-link', async () => {
    document.body.innerHTML = `<div style="white-space:nowrap">abandon a</div><div style="text-overflow:ellipsis;overflow:hidden">abandon b</div>
      <button>abandon c</button><p>free <a href="#">abandon</a> d</p><p>list <span style="white-space:nowrap"><a href="#">abandon</a></span> e</p>`;
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: dict, inlineTranslation: 'after' });
    engine.start();
    await flush();
    const marks = [...document.querySelectorAll('hnw-mark')];
    expect(marks.map((m) => m.hasAttribute('data-hnw-tight'))).toEqual([true, true, true, false, false]);
    expect(marks.map((m) => m.hasAttribute('data-hnw-link'))).toEqual([false, false, false, true, true]);
    engine.stop();
  });

  it('派生词优先用自身词条的释义（committee 不译成 commit 的释义）', async () => {
    document.body.innerHTML = '<p>the committee will abandon it</p>';
    const lemmatizer = { candidates: (w: string) => (w.toLowerCase() === 'committee' ? ['committee', 'commit'] : new SimpleLemmatizer().candidates(w)) };
    const engine = new HighlightEngine({
      root: document.body,
      matcher: new WordMatcher({ lemmatizer, books: [book], known: new Set() }),
      dictionary: dict,
      inlineTranslation: 'after',
    });
    engine.start();
    await flush();
    const trs = [...document.querySelectorAll('hnw-mark')].map((m) => [m.getAttribute('data-lemma'), m.querySelector('hnw-tr')?.getAttribute('data-tr')]);
    expect(trs).toEqual([
      ['commit', '委员会'],
      ['abandon', '放弃'],
    ]);
    engine.stop();
  });

  it('ruby 模式在创建 mark 时预留注解；模糊自测点按切换清晰且不冒泡到卡片', async () => {
    document.body.innerHTML = '<p>they abandon it</p>';
    let slow: (() => void) | undefined;
    const slowDict: Dictionary = {
      ...dict,
      lookupMany: (ws) => new Promise((r) => (slow = () => r(new Map([...ws].map((w) => [w, { word: w, short: '放弃' }]))))),
    };
    const engine = new HighlightEngine({ root: document.body, matcher: matcher(), dictionary: slowDict, inlineTranslation: 'ruby', translationBlur: true });
    engine.start();
    await flush();
    const tr = document.querySelector('hnw-mark hnw-tr')!;
    expect(tr).not.toBeNull();
    expect(tr.hasAttribute('data-tr')).toBe(false); // 占位：行高已预留，释义未到
    slow!();
    await flush();
    expect(tr.getAttribute('data-tr')).toBe('放弃');
    let bubbled = 0;
    document.addEventListener('click', () => bubbled++, true);
    tr.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(tr.hasAttribute('data-hnw-revealed')).toBe(true);
    expect(bubbled).toBe(0);
    engine.stop();
  });
});
