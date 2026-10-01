import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleLemmatizer } from '@/core/lemma/simple';
import { WordMatcher } from '@/core/match/matcher';
import { createDefaultSettings } from '@/core/settings/defaults';
import { normalizeSettings } from '@/core/settings/migrate';
import type { Settings } from '@/core/settings/schema';
import { createSetWordBook } from '@/core/wordbook/registry';
import {
  BALL_SIZE,
  SAFE_BOTTOM,
  SAFE_TOP,
  clampCenterY,
  computeOverlayFrame,
  hostMatches,
  isTouchPrimary,
  parsePos,
  snapPosition,
  syncFootText,
  tokenize,
  toFrameLocal,
  toggleHostRule,
  wordAt,
} from '@/content/floatball/model';
import { createOverlayHost } from '@/content/floatball/host';
import { ballX, IDLE_SCALE, IDLE_VISIBLE } from '@/content/floatball/css';
import { availableFloatActions, overlayRoot, registerFloatAction, registerOverlayHost, relocateOverlayHosts } from '@/content/floatball/registry';
import { CaptionDecorator, buildCaptionCss } from '@/content/sites/youtube/captions';
import { ATTR_YT_GLOSS, ATTR_YT_GM, ATTR_YT_HINT, createSkipRule } from '@/content/sites/youtube/dom';
import { currentVideoId } from '@/content/sites/youtube/index';
import { placeAroundCaptions } from '@/content/sites/youtube/zone';
import { formatTime } from '@/content/sites/youtube/panel';
import { PauseController } from '@/content/sites/youtube/playback';
import { CaptionHistory, buildSentences, normalizeTimedtextUrl, parseJson3, sentenceIndexAt } from '@/content/sites/youtube/track';
import type { SiteContext } from '@/content/sites/types';

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
});

describe('floatball 设置契约', () => {
  it('默认：悬浮球开启、字幕默认上方注解、悬停暂停默认关闭', () => {
    const s = createDefaultSettings();
    expect(s.floatBall).toEqual({ enabled: true, hiddenSites: [] });
    expect(s.youtube.captionTranslation).toBe('above');
    expect(s.youtube.hoverPause).toBe(false);
  });
  it('旧设置缺字段时按默认值补齐', () => {
    const old = createDefaultSettings() as unknown as Record<string, unknown>;
    delete old.floatBall;
    old.youtube = { captions: false };
    const s = normalizeSettings(old);
    expect(s.floatBall.enabled).toBe(true);
    expect(s.youtube).toEqual({ captions: false, hoverPause: false, captionTranslation: 'above' });
  });
});

describe('floatball 纯逻辑', () => {
  it('只在 hover:none + pointer:coarse 时显示', () => {
    expect(isTouchPrimary((q) => q === '(hover: none) and (pointer: coarse)')).toBe(true);
    expect(isTouchPrimary(() => false)).toBe(false);
  });
  it('站点规则含子域名，移出时去掉父域规则', () => {
    expect(hostMatches(['example.com'], 'www.example.com')).toBe(true);
    expect(hostMatches(['example.com'], 'badexample.com')).toBe(false);
    expect(toggleHostRule([], 'm.youtube.com', true)).toEqual(['m.youtube.com']);
    expect(toggleHostRule(['youtube.com', 'a.org'], 'm.youtube.com', false)).toEqual(['a.org']);
  });
  it('位置吸附到较近一侧，垂直位置夹在避让区之间', () => {
    expect(snapPosition(100, 400, 390, 844).side).toBe('left');
    expect(snapPosition(300, 400, 390, 844).side).toBe('right');
    expect(clampCenterY(0, 844)).toBe(SAFE_TOP + BALL_SIZE / 2);
    expect(clampCenterY(1, 844)).toBe(844 - SAFE_BOTTOM - BALL_SIZE / 2);
    const p = snapPosition(380, 5, 390, 844);
    expect(p.y * 844).toBeCloseTo(SAFE_TOP + BALL_SIZE / 2, 0);
  });
  it('解析存储位置：损坏时用默认值', () => {
    expect(parsePos({ side: 'left', y: 0.3 })).toEqual({ side: 'left', y: 0.3 });
    expect(parsePos({ side: 'up', y: 0.3 }).side).toBe('right');
    expect(parsePos({ side: 'left', y: 3 }).side).toBe('right');
    expect(parsePos(null).side).toBe('right');
  });
  it('wordAt 取点按位置的单词（含撇号/连字符，末尾也算）', () => {
    const t = "It's a well-known fact.";
    expect(wordAt(t, 1)?.word).toBe("It's");
    expect(wordAt(t, 8)?.word).toBe('well-known');
    expect(wordAt(t, 22)?.word).toBe('fact');
    expect(wordAt(t, 5)?.word).toBe('a');
    expect(wordAt('  ...  ', 3)).toBeNull();
  });
  it('空闲时缩小贴边，露出至少 20px 的一条', () => {
    const vw = 390;
    const d = BALL_SIZE * IDLE_SCALE;
    // 缩放以球心为原点：可见圆左边缘 = 平移量 + 半径 - 缩放后半径
    const rightLeftEdge = ballX('right', vw, true) + BALL_SIZE / 2 - d / 2;
    expect(vw - rightLeftEdge).toBeCloseTo(IDLE_VISIBLE, 5);
    expect(IDLE_VISIBLE).toBeGreaterThanOrEqual(20);
    expect(IDLE_VISIBLE).toBeLessThan(d);
    const leftRightEdge = ballX('left', vw, true) + BALL_SIZE / 2 + d / 2;
    expect(leftRightEdge).toBeCloseTo(IDLE_VISIBLE, 5);
    expect(ballX('right', vw, false)).toBe(vw - BALL_SIZE - 8);
  });

  it('底栏同步文案：未连接中性灰、成功过再失败才是“同步出错”，不常驻原始报错', () => {
    const item = (name: string, level: 'ok' | 'never' | 'error', text = `${name}：未登录或登录已失效`) => ({ id: name, kind: 'source' as const, name, level, text, lastSyncAt: 0, href: '#sources' });
    expect(syncFootText({ level: 'never', text: 'x', items: [item('有道词典', 'never', '未连接')] })).toEqual({ level: 'off', text: '有道词典未连接' });
    expect(syncFootText({ level: 'never', text: 'x', items: [item('浏览器账号同步', 'ok'), item('有道词典', 'never', '未连接')] })).toEqual({ level: 'off', text: '已同步 1 项 · 有道词典未连接' });
    expect(syncFootText({ level: 'error', text: 'x', items: [item('浏览器账号同步', 'ok'), item('有道', 'error')] })).toEqual({ level: 'error', text: '已同步 1 项 · 有道同步出错' });
    expect(syncFootText({ level: 'ok', text: '已全部同步', items: [item('A', 'ok')] })).toEqual({ level: 'ok', text: '已全部同步' });
  });

  it('tokenize 保留全部原文字符', () => {
    const text = 'So in college, I was a government major,';
    const toks = tokenize(text);
    expect(toks.map((t) => t.text).join('')).toBe(text);
    expect(toks.filter((t) => t.word).map((t) => t.text)).toEqual(['So', 'in', 'college', 'I', 'was', 'a', 'government', 'major']);
  });
});

describe('floatball 注册表与全屏挂载', () => {
  it('功能项按 available 过滤，注销后消失', () => {
    let ok = true;
    const off = registerFloatAction({ id: 'x', label: 'X', available: () => ok, run: () => {} });
    expect(availableFloatActions().map((a) => a.id)).toContain('x');
    ok = false;
    expect(availableFloatActions().map((a) => a.id)).not.toContain('x');
    off();
  });
  it('全屏元素为播放器时，宿主与卡片宿主迁入；body/html 全屏时仍挂 documentElement', () => {
    const player = document.createElement('div');
    document.body.appendChild(player);
    const host = document.createElement('hnw-float-host');
    const card = document.createElement('hnw-card-host');
    document.documentElement.append(host, card);
    const off = registerOverlayHost(host);
    // jsdom 没有 fullscreenElement：用可改写的属性模拟
    let fs: Element | null = player;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fs });
    expect(overlayRoot(document)).toBe(player);
    relocateOverlayHosts(document);
    expect(host.parentElement).toBe(player);
    expect(card.parentElement).toBe(player);
    // 宿主内的点按不冒泡给播放器
    const onPlayerClick = vi.fn();
    player.addEventListener('click', onPlayerClick);
    host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onPlayerClick).not.toHaveBeenCalled();
    fs = document.body;
    relocateOverlayHosts(document);
    expect(host.parentElement).toBe(document.documentElement);
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    off();
    host.remove();
    card.remove();
  });
});

// ---------------- YouTube ----------------

function buildPlayer(lines: string[], rollup = false): HTMLElement {
  document.body.innerHTML = `
    <div id="movie_player" class="html5-video-player">
      <video></video>
      <div class="ytp-caption-window-container">
        <div class="caption-window ytp-caption-window-bottom${rollup ? ' ytp-caption-window-rollup' : ''}">
          <span class="captions-text">${lines.map((l) => `<span class="caption-visual-line"><span class="ytp-caption-segment">${l}</span></span>`).join('')}</span>
        </div>
      </div>
      <div class="ytp-chrome-bottom"><span class="ytp-chapter-title-content">My procrastination</span></div>
    </div>
    <div class="html5-video-player" id="preview"><div class="ytp-caption-window-container"></div></div>`;
  return document.getElementById('movie_player')!;
}

function ctxWith(settings: Settings, glosses: Record<string, string> = {}): SiteContext {
  const lemmatizer = new SimpleLemmatizer();
  return {
    doc: document,
    getSettings: () => settings,
    isActive: () => true,
    getCard: () => null,
    openCard: () => {},
    lookupMany: async (words) => new Map([...words].filter((w) => glosses[w]).map((w) => [w, { word: w, short: glosses[w] }])),
    createMatcher: () => new WordMatcher({ lemmatizer, books: [createSetWordBook({ id: 'b', name: 'b', nameEn: 'b', short: 'b', kind: 'builtin', category: 'exam', level: 1, size: 0 }, ['loom'])], known: new Set() }),
    lemmaCandidates: (w) => lemmatizer.candidates(w),
    pageLemmas: () => [],
    markKnown: async () => ({ ok: true }) as never,
    unmarkKnown: async () => ({ ok: true }),
    onSettingsChange: () => () => {},
  };
}

/** 模拟 engine 已在字幕段中包裹生词 */
function markWord(seg: Element, word: string, lemma: string): HTMLElement {
  const text = seg.textContent!;
  const i = text.indexOf(word);
  seg.innerHTML = `${text.slice(0, i)}<hnw-mark data-lemma="${lemma}" data-books="b"><hnw-w>${word}</hnw-w></hnw-mark>${text.slice(i + word.length)}`;
  return seg.querySelector('hnw-mark')!;
}

describe('YouTube 跳过规则', () => {
  it('不做特殊跳过：控件、其他播放器、提示窗口、界面元素都放行；只在关闭字幕标注时跳过字幕容器', () => {
    const player = buildPlayer(['hello']);
    const rule = createSkipRule(() => true);
    expect(rule(player.querySelector('.ytp-caption-window-container')!)).toBe(false);
    expect(rule(player.querySelector('.ytp-chrome-bottom')!)).toBe(false);
    expect(rule(document.getElementById('preview')!)).toBe(false);
    const w = player.querySelector('.caption-window')!;
    w.setAttribute(ATTR_YT_HINT, '');
    expect(rule(w)).toBe(false);
    for (const tag of ['ytd-masthead', 'yt-lockup-view-model', 'ytd-ad-slot-renderer', 'button', 'ytd-comments-header-renderer']) {
      expect(rule(document.createElement(tag)), tag).toBe(false);
    }
    const off = createSkipRule(() => false);
    expect(off(player.querySelector('.ytp-caption-window-container')!)).toBe(true);
  });
});

describe('YouTube 字幕译文模式', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('默认 above：窗口标记 above，生词写入短释义（页面词形优先、无释义写空串）', async () => {
    const player = buildPlayer(['The deadline was looming and the end']);
    const settings = createDefaultSettings();
    const mark = markWord(player.querySelector('.ytp-caption-segment')!, 'looming', 'loom');
    const texts: string[] = [];
    const dec = new CaptionDecorator(ctxWith(settings, { loom: '隐约出现' }), (t) => texts.push(t));
    dec.attach(player.querySelector('.ytp-caption-window-container'));
    dec.process();
    await flush();
    expect(player.querySelector('.caption-window')!.getAttribute(ATTR_YT_GM)).toBe('above');
    expect(mark.getAttribute(ATTR_YT_GLOSS)).toBe('隐约出现');
    expect(texts.at(-1)).toContain('looming');
    expect(document.getElementById('hnw-yt-style')).not.toBeNull();
    dec.destroy();
    expect(player.querySelector('.caption-window')!.hasAttribute(ATTR_YT_GM)).toBe(false);
  });

  it('after / off 模式；自动生成字幕窗口与提示窗口同样按设置显示译文，提示文字不计入当前字幕', async () => {
    const settings = createDefaultSettings();
    settings.youtube.captionTranslation = 'after';
    let player = buildPlayer(['looming here']);
    const dec = new CaptionDecorator(ctxWith(settings, { loom: '隐约出现' }));
    dec.attach(player.querySelector('.ytp-caption-window-container'));
    dec.process();
    expect(player.querySelector('.caption-window')!.getAttribute(ATTR_YT_GM)).toBe('after');
    settings.youtube.captionTranslation = 'off';
    dec.process();
    expect(player.querySelector('.caption-window')!.hasAttribute(ATTR_YT_GM)).toBe(false);
    dec.destroy();

    settings.youtube.captionTranslation = 'above';
    player = buildPlayer(['looming here'], true);
    const dec2 = new CaptionDecorator(ctxWith(settings));
    dec2.attach(player.querySelector('.ytp-caption-window-container'));
    dec2.process();
    expect(player.querySelector('.caption-window')!.getAttribute(ATTR_YT_GM)).toBe('above');
    dec2.destroy();

    player = buildPlayer(['English (auto-generated)', 'Click ⚙ for settings']);
    const texts: string[] = [];
    const dec3 = new CaptionDecorator(ctxWith(settings), (t) => texts.push(t));
    dec3.attach(player.querySelector('.ytp-caption-window-container'));
    dec3.process();
    const w = player.querySelector('.caption-window')!;
    expect(w.hasAttribute(ATTR_YT_HINT)).toBe(true);
    expect(w.getAttribute(ATTR_YT_GM)).toBe('above');
    expect(texts.at(-1)).toBe('');
    dec3.destroy();
  });

  it('同文整窗重建：沿用旧窗口的标注节点与译文模式（新窗口第一帧就有注解），文本不同不沿用', async () => {
    const settings = createDefaultSettings();
    const player = buildPlayer(['The deadline was looming']);
    const container = player.querySelector('.ytp-caption-window-container')!;
    const mark = markWord(player.querySelector('.ytp-caption-segment')!, 'looming', 'loom');
    const dec = new CaptionDecorator(ctxWith(settings, { loom: '隐约出现' }));
    dec.attach(container);
    dec.process();
    await flush();
    expect(mark.getAttribute(ATTR_YT_GLOSS)).toBe('隐约出现');
    // YouTube 重建：同一任务内移除旧窗口、插入文本相同的新窗口
    const rebuild = (text: string, rollup = false) => {
      const w = document.createElement('div');
      w.className = `caption-window${rollup ? ' ytp-caption-window-rollup' : ''}`;
      w.innerHTML = `<span class="captions-text"><span class="caption-visual-line"><span class="ytp-caption-segment">${text}</span></span></span>`;
      container.replaceChildren(w);
      return w;
    };
    const w1 = rebuild('The deadline was looming');
    await Promise.resolve();
    expect(w1.querySelector('hnw-mark')).toBe(mark);
    expect(w1.getAttribute(ATTR_YT_GM)).toBe('above');
    expect(w1.textContent).toBe('The deadline was looming');
    const w2 = rebuild('Something else entirely');
    await Promise.resolve();
    expect(w2.querySelector('hnw-mark')).toBeNull();
    dec.destroy();
  });

  it('自动生成字幕换行重建字幕行：留下的那一行沿用旧标注节点（不闪烁），窗口译文模式保持', async () => {
    const settings = createDefaultSettings();
    const player = buildPlayer(['to play test, see sneak peeks', 'help with voice acting'], true);
    const container = player.querySelector('.ytp-caption-window-container')!;
    const win = player.querySelector<HTMLElement>('.caption-window')!;
    const [seg1, seg2] = [...player.querySelectorAll<HTMLElement>('.ytp-caption-segment')] as [HTMLElement, HTMLElement];
    markWord(seg1, 'sneak', 'sneak');
    const acting = markWord(seg2, 'acting', 'act');
    const dec = new CaptionDecorator(ctxWith(settings, { act: '表演' }));
    dec.attach(container);
    dec.process();
    await flush();
    // m.youtube.com 实测：换行时移除窗口内全部字幕行，再逐词重建（每个词一个文本节点），留下的那一行文本不变
    const captionsText = win.querySelector('.captions-text')!;
    const line = document.createElement('span');
    line.className = 'caption-visual-line';
    const seg = document.createElement('span');
    seg.className = 'ytp-caption-segment';
    for (const w of ['help', ' with', ' voice', ' acting']) seg.append(w);
    line.append(seg);
    captionsText.replaceChildren(line);
    await Promise.resolve();
    expect(seg.querySelector('hnw-mark')).toBe(acting);
    expect(seg.textContent).toBe('help with voice acting');
    // 之后逐词追加的文本节点照常留在字幕段末尾
    seg.append(' and');
    expect(seg.textContent).toBe('help with voice acting and');
    await Promise.resolve();
    expect(win.getAttribute(ATTR_YT_GM)).toBe('above');
    dec.destroy();
  });

  it('样式：above 逐词 inline-block 向上留位（逐行生效）、触屏注解下限 12px，after 不折行并居中', () => {
    const css = buildCaptionCss();
    expect(css).toContain(`[${ATTR_YT_GM}="above"]`);
    expect(css).toMatch(/hnw-mark\[data-hnw-yt-gloss\][^{]*\{[^}]*display:inline-block!important[^}]*padding-top/);
    // below 与 above 对称：留白在下方，注解贴底
    expect(css).toMatch(/="below"\] hnw-mark\[data-hnw-yt-gloss\][^{]*\{[^}]*display:inline-block!important[^}]*padding-bottom/);
    expect(css).toMatch(/="below"\] hnw-mark\[data-hnw-yt-gloss\][^{]*::after\{[^}]*bottom:0/);
    // 不再给整个字幕段加 padding-top（两行字幕时第二行的注解会压到第一行上）
    expect(css).not.toContain('ytp-caption-segment:has(');
    // 注解字号 ≥ 字幕字号的 55%（桌面/触屏），自带深色底提高对比度
    for (const em of [...css.matchAll(/--hnw-gf:max\(([.\d]+)em,(\d+)px\)/g)]) {
      expect(Number(em[1])).toBeGreaterThanOrEqual(0.55);
      expect(Number(em[2])).toBeGreaterThanOrEqual(12);
    }
    expect(css).toContain('max(.7em,12px)');
    expect(css).toMatch(/::after\{[^}]*background:rgba\(0,0,0,\.86\)/);
    expect(css).toContain('white-space:pre!important');
    expect(css).toContain('justify-content:center');
    // engine 的行内译文在字幕里一律隐藏
    expect(css).toContain('hnw-tr{display:none!important}');
  });
});

describe('YouTube 暂停控制：只恢复我们发起的暂停', () => {
  function fakeVideo() {
    const v = document.createElement('video');
    let paused = false;
    Object.defineProperty(v, 'paused', { get: () => paused });
    v.pause = () => {
      paused = true;
      v.dispatchEvent(new Event('pause'));
    };
    v.play = () => {
      paused = false;
      v.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    document.body.appendChild(v);
    return v;
  }
  it('我们暂停 -> 恢复播放', () => {
    const v = fakeVideo();
    const pc = new PauseController(document, () => v);
    expect(pc.pause()).toBe(true);
    expect(pc.pausedByUs).toBe(true);
    expect(pc.resume()).toBe(true);
    expect(v.paused).toBe(false);
    pc.destroy();
  });
  it('用户本来就暂停 -> 不接管；我们暂停后用户自己播放又暂停 -> 不再恢复', () => {
    const v = fakeVideo();
    const pc = new PauseController(document, () => v);
    v.pause();
    expect(pc.pause()).toBe(false);
    expect(pc.resume()).toBe(false);
    v.play();
    pc.pause();
    v.play(); // 用户点了播放
    v.pause(); // 又自己暂停
    expect(pc.resume()).toBe(false);
    expect(v.paused).toBe(true);
    pc.destroy();
  });
  it('广告中不暂停', () => {
    const v = fakeVideo();
    const pc = new PauseController(document, () => v, () => false);
    expect(pc.pause()).toBe(false);
    pc.destroy();
  });
});

describe('YouTube 字幕数据', () => {
  it('timedtext URL 规范化：只要英文轨，去掉 tlang，强制 json3', () => {
    const r = normalizeTimedtextUrl('/api/timedtext?v=abc&lang=en&fmt=srv3&tlang=zh-Hans&pot=P&kind=asr');
    expect(r?.videoId).toBe('abc');
    expect(r?.asr).toBe(true);
    expect(r?.url).toContain('fmt=json3');
    expect(r?.url).not.toContain('tlang');
    expect(normalizeTimedtextUrl('/api/timedtext?v=abc&lang=fr')).toBeNull();
    expect(normalizeTimedtextUrl('/watch?v=abc')).toBeNull();
  });
  it('json3 解析与按句合并；sentenceIndexAt 取最后一个已开始的句子', () => {
    const cues = parseJson3(
      { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'So in college,' }] }, { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'I was\nhere.' }] }, { tStartMs: 2000, aAppend: 1, segs: [{ utf8: '\n' }] }, { tStartMs: 6000, dDurationMs: 500, segs: [{ utf8: 'Next' }] }] },
      false,
    );
    expect(cues.map((c) => c.text)).toEqual(['So in college,', 'I was here.', 'Next']);
    const sents = buildSentences(cues, false);
    expect(sents.map((s) => s.text)).toEqual(['So in college, I was here.', 'Next']);
    expect(sentenceIndexAt(sents, 500)).toBe(0);
    expect(sentenceIndexAt(sents, 4000)).toBe(0);
    expect(sentenceIndexAt(sents, 6000)).toBe(1);
    expect(sentenceIndexAt([], 1)).toBe(-1);
  });
  it('DOM 字幕历史：自动字幕逐词变长时替换上一条，换视频清空', () => {
    const h = new CaptionHistory();
    h.record('a', 'the dead', 0);
    h.record('a', 'the deadline', 200);
    h.record('a', 'was looming', 1000);
    expect(h.list('a').map((c) => c.text)).toEqual(['the deadline', 'was looming']);
    h.record('b', 'x', 0);
    expect(h.list('a')).toEqual([]);
  });
  it('视频 id 与时间格式', () => {
    expect(currentVideoId({ pathname: '/watch', search: '?v=arj7oStGLkU&t=3' })).toBe('arj7oStGLkU');
    expect(currentVideoId({ pathname: '/embed/arj7oStGLkU', search: '' })).toBe('arj7oStGLkU');
    expect(formatTime(75_000)).toBe('1:15');
    expect(formatTime(3_725_000)).toBe('1:02:05');
  });
});

describe('YouTube 字幕生词卡片避让字幕', () => {
  const card = { width: 360, height: 280 };
  const inter = (p: { top: number; left: number }, b: { left: number; top: number; right: number; bottom: number }) =>
    Math.max(0, Math.min(p.left + card.width, b.right) - Math.max(p.left, b.left)) * Math.max(0, Math.min(p.top + card.height, b.bottom) - Math.max(p.top, b.top));
  it('优先放在字幕块上方并留 8px，水平以单词为中心', () => {
    const block = { left: 300, top: 470, right: 600, bottom: 540 };
    const p = placeAroundCaptions({ left: 420, width: 60 }, block, { left: 16, top: 68, right: 889, bottom: 558 }, card, { width: 1280, height: 800 })!;
    expect(p.above).toBe(true);
    expect(p.top + card.height).toBe(block.top - 8);
    expect(p.left).toBe(450 - 180);
    expect(inter(p, block)).toBe(0);
  });
  it('上方放不下：先放播放器右侧，再放字幕块侧边；均不与字幕相交', () => {
    const block = { left: 300, top: 200, right: 600, bottom: 260 };
    const side = placeAroundCaptions({ left: 420, width: 60 }, block, { left: 16, top: 68, right: 889, bottom: 300 }, card, { width: 1280, height: 800 })!;
    expect(side.left).toBe(889 + 8);
    expect(inter(side, block)).toBe(0);
    // 全屏：播放器占满视口，只能放在字幕块旁边
    const fs = placeAroundCaptions({ left: 420, width: 60 }, block, { left: 0, top: 0, right: 1280, bottom: 800 }, card, { width: 1280, height: 800 })!;
    expect(fs.left).toBe(600 + 8);
    expect(inter(fs, block)).toBe(0);
  });
});

describe('floatball 浮层铺满屏幕可见区域', () => {
  it('页面横向溢出（布局视口被撑宽）时按 visualViewport 取屏幕宽度', () => {
    // 布局视口被 nowrap 导航撑到 700px，屏幕实际只显示 390px
    const f = computeOverlayFrame({ offsetLeft: 0, offsetTop: 0, scale: 1, width: 390, height: 844 }, { width: 700, height: 1515 });
    expect(f).toEqual({ x: 0, y: 0, scale: 1, width: 390, height: 844 });
  });
  it('双指放大并平移后：宿主局部尺寸保持屏幕尺寸，client 坐标正确换算', () => {
    const f = computeOverlayFrame({ offsetLeft: 100, offsetTop: 50, scale: 2, width: 195, height: 422 }, { width: 390, height: 844 });
    expect(f).toEqual({ x: 100, y: 50, scale: 2, width: 390, height: 844 });
    // 可见区域左上角 → (0,0)，右下角 → (390,844)
    expect(toFrameLocal(f, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(toFrameLocal(f, 295, 472)).toEqual({ x: 390, y: 844 });
  });
  it('不支持 visualViewport 时退回布局视口', () => {
    expect(computeOverlayFrame(undefined, { width: 390, height: 844 })).toEqual({ x: 0, y: 0, scale: 1, width: 390, height: 844 });
  });
});

describe('floatball 浮层深浅色与卡片同一判定（按网页背景）', () => {
  const settingsOf = () => normalizeSettings(createDefaultSettings()) as Settings;
  const withSystemDark = (dark: boolean) =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: dark && q.includes('dark'), media: q, addEventListener() {}, removeEventListener() {} }));
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.removeAttribute('style');
    document.documentElement.innerHTML = '<head></head><body></body>';
  });
  for (const system of [false, true]) {
    it(`系统${system ? '深色' : '浅色'} × 网页深色 → 深色；× 网页浅色 → 浅色`, () => {
      withSystemDark(system);
      document.body.style.background = '#111418';
      const o = createOverlayHost(document, 'hnw-test-host', '');
      o.setTheme(settingsOf());
      expect(o.host.getAttribute('data-theme')).toBe('dark');
      document.body.style.background = '#ffffff';
      o.setTheme(settingsOf());
      expect(o.host.getAttribute('data-theme')).toBe('light');
      o.destroy();
    });
  }
});
