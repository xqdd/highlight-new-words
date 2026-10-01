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
  hostMatches,
  isTouchPrimary,
  parsePos,
  snapPosition,
  syncFootText,
  tokenize,
  toggleHostRule,
  wordAt,
} from '@/content/floatball/model';
import { ballX, IDLE_SCALE, IDLE_VISIBLE } from '@/content/floatball/css';
import { availableFloatActions, overlayRoot, registerFloatAction, registerOverlayHost, relocateOverlayHosts } from '@/content/floatball/registry';
import { CaptionDecorator, buildCaptionCss } from '@/content/sites/youtube/captions';
import { ATTR_YT_GLOSS, ATTR_YT_GM, ATTR_YT_HINT, createSkipRule } from '@/content/sites/youtube/dom';
import { currentVideoId } from '@/content/sites/youtube/index';
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
  it('空闲时缩小贴边，只露出一条，不压正文边距以内的文字', () => {
    const vw = 390;
    const d = BALL_SIZE * IDLE_SCALE;
    // 缩放以球心为原点：可见圆左边缘 = 平移量 + 半径 - 缩放后半径
    const rightLeftEdge = ballX('right', vw, true) + BALL_SIZE / 2 - d / 2;
    expect(vw - rightLeftEdge).toBeCloseTo(IDLE_VISIBLE, 5);
    expect(IDLE_VISIBLE).toBeLessThan(16);
    const leftRightEdge = ballX('left', vw, true) + BALL_SIZE / 2 + d / 2;
    expect(leftRightEdge).toBeCloseTo(IDLE_VISIBLE, 5);
    expect(ballX('right', vw, false)).toBe(vw - BALL_SIZE - 8);
  });

  it('底栏同步文案：未登录/失效只提示“待设置”，不常驻原始报错', () => {
    const item = (name: string, level: 'ok' | 'never' | 'error') => ({ id: name, kind: 'source' as const, name, level, text: `${name}：未登录或登录已失效`, lastSyncAt: 0, href: '#sources' });
    expect(syncFootText({ level: 'error', text: '有道：未登录有道或登录已失效', items: [item('有道', 'never')] })).toEqual({ level: 'off', text: '有道待设置' });
    expect(syncFootText({ level: 'error', text: 'x', items: [item('浏览器账号同步', 'ok'), item('有道', 'error')] })).toEqual({ level: 'warn', text: '已同步 1 项 · 有道待设置' });
    expect(syncFootText({ level: 'ok', text: '已全部同步', items: [item('浏览器账号同步', 'ok')] })).toEqual({ level: 'ok', text: '已全部同步' });
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
  it('只放行主播放器的字幕容器；控件、其他播放器、提示窗口跳过', () => {
    const player = buildPlayer(['hello']);
    const rule = createSkipRule(() => true);
    expect(rule(player.querySelector('.ytp-caption-window-container')!)).toBe(false);
    expect(rule(player.querySelector('.ytp-chrome-bottom')!)).toBe(true);
    expect(rule(document.getElementById('preview')!)).toBe(true);
    const off = createSkipRule(() => false);
    expect(off(player.querySelector('.ytp-caption-window-container')!)).toBe(true);
    const w = player.querySelector('.caption-window')!;
    w.setAttribute(ATTR_YT_HINT, '');
    expect(rule(w)).toBe(true);
  });

  it('视频页界面（导航、推荐、广告、按钮、频道信息、评论区标题）跳过，简介与评论正文放行', () => {
    const rule = createSkipRule(() => true);
    const el = (tag: string, id = '') => {
      const e = document.createElement(tag);
      if (id) e.id = id;
      return e;
    };
    for (const tag of ['ytd-masthead', 'ytd-guide-renderer', 'yt-lockup-view-model', 'ytd-compact-video-renderer', 'ytm-video-with-context-renderer',
      'ytd-ad-slot-renderer', 'ad-slot-renderer', 'ytm-promoted-sparkles-web-renderer', 'yt-button-shape', 'button', 'ytd-video-owner-renderer',
      'ytd-merch-shelf-renderer', 'ytd-comments-header-renderer', 'ytd-video-description-transcript-section-renderer', 'ytd-rich-grid-renderer']) {
      expect(rule(el(tag)), tag).toBe(true);
    }
    expect(rule(el('div', 'secondary'))).toBe(true);
    expect(rule(el('div', 'header-author'))).toBe(true);
    for (const tag of ['ytd-text-inline-expander', 'yt-attributed-string', 'ytd-comment-view-model', 'ytd-expander', 'ytm-expandable-video-description-body-renderer', 'ytd-watch-metadata', 'p']) {
      expect(rule(el(tag)), tag).toBe(false);
    }
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

  it('after / off 模式；自动生成字幕窗口与提示窗口不设模式（只高亮）', async () => {
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
    expect(player.querySelector('.caption-window')!.hasAttribute(ATTR_YT_GM)).toBe(false);
    dec2.destroy();

    player = buildPlayer(['English (auto-generated)', 'Click ⚙ for settings']);
    const texts: string[] = [];
    const dec3 = new CaptionDecorator(ctxWith(settings), (t) => texts.push(t));
    dec3.attach(player.querySelector('.ytp-caption-window-container'));
    dec3.process();
    const w = player.querySelector('.caption-window')!;
    expect(w.hasAttribute(ATTR_YT_HINT)).toBe(true);
    expect(w.hasAttribute(ATTR_YT_GM)).toBe(false);
    expect(texts.at(-1)).toBe('');
    dec3.destroy();
  });

  it('样式：above 逐词 inline-block 向上留位（逐行生效）、触屏注解下限 12px，after 不折行并居中', () => {
    const css = buildCaptionCss();
    expect(css).toContain(`[${ATTR_YT_GM}="above"]`);
    expect(css).toMatch(/hnw-mark\[data-hnw-yt-gloss\][^{]*\{[^}]*display:inline-block!important[^}]*padding-top/);
    // 不再给整个字幕段加 padding-top（两行字幕时第二行的注解会压到第一行上）
    expect(css).not.toContain('ytp-caption-segment:has(');
    expect(css).toContain('max(.62em,12px)');
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
