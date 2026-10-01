/**
 * YouTube 播放器 DOM 约定（选择器集中在此，YouTube 改版时只改这里）。
 * 结构（桌面与 m.youtube.com 一致，2026-10 实测）：
 * `#movie_player > .ytp-caption-window-container > .caption-window[.ytp-caption-window-rollup] > .captions-text > .caption-visual-line > .ytp-caption-segment`
 * - 人工字幕（pop-on）每条整窗重建；自动生成字幕（roll-up）窗口带 `ytp-caption-window-rollup`，高度固定、overflow:hidden，逐词原位追加
 * - 自动字幕开头的 “English (auto-generated) / Click ⚙ for settings” 提示是一个单独的 `ytp-caption-window-top` 窗口
 * - 侧栏推荐位的悬停预览播放器也是 `.html5-video-player`，但 id 不是 movie_player
 */
export const PLAYER_ID = 'movie_player';
export const PLAYER_CLASS = 'html5-video-player';
export const CAPTION_CONTAINER_CLASS = 'ytp-caption-window-container';
export const CAPTION_WINDOW_SELECTOR = `#${PLAYER_ID} .${CAPTION_CONTAINER_CLASS} .caption-window`;
export const CAPTION_SEGMENT_CLASS = 'ytp-caption-segment';
/** 自动生成字幕（roll-up）窗口：高度固定，不能加字幕内译文 */
export const ROLLUP_CLASS = 'ytp-caption-window-rollup';
/** 播放器控件自动隐藏时播放器根元素带此类名（控件出现后字幕整体上移） */
export const AUTOHIDE_CLASS = 'ytp-autohide';
/** 播放广告时播放器根元素带此类名 */
export const AD_SHOWING_CLASS = 'ad-showing';
export const CHROME_BOTTOM_CLASS = 'ytp-chrome-bottom';

/** 我们加在字幕窗口上的标记：自动字幕提示窗口（engine 跳过其子树） */
export const ATTR_YT_HINT = 'data-hnw-yt-hint';
/** 我们加在字幕内 hnw-mark 上的单词上方注解文本（CSS ::after 渲染，不进入 textContent） */
export const ATTR_YT_GLOSS = 'data-hnw-yt-gloss';
/**
 * 我们加在字幕窗口上的译文模式：above（上方注解）/ after（词后小字）；不设置 = 只高亮。
 * 按窗口设置：自动生成字幕窗口与提示窗口不设置；after 放不下（超出播放器宽度）的窗口单独改成 above
 */
export const ATTR_YT_GM = 'data-hnw-yt-gm';
export const YT_STYLE_ID = 'hnw-yt-style';

/** YouTube 站点（含 m. 与 www.；YouTube Music 的播放器结构不同，不处理） */
export function isYouTubeHost(hostname: string): boolean {
  if (hostname === 'music.youtube.com') return false;
  return hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtube-nocookie.com' || hostname.endsWith('.youtube-nocookie.com');
}

/** 自动字幕提示（英文界面为 “English (auto-generated)” 与 “Click ⚙ for settings”） */
export function isAutoCaptionHint(text: string): boolean {
  return /\(auto-generated\)|\bclick\b.{0,6}\bfor settings\b/i.test(text);
}

export function getPlayer(doc: Document): HTMLElement | null {
  return doc.getElementById(PLAYER_ID);
}

/** 主播放器的视频元素（广告与正片共用同一个 video） */
export function getVideo(doc: Document): HTMLVideoElement | null {
  return getPlayer(doc)?.querySelector<HTMLVideoElement>('video') ?? null;
}

/** 元素是否位于主播放器字幕容器内 */
export function inMainCaptions(el: Element): boolean {
  const c = el.closest(`.${CAPTION_CONTAINER_CLASS}`);
  return !!c && c.parentElement?.id === PLAYER_ID;
}

/** 主播放器当前显示的字幕窗口（不含自动字幕提示窗口） */
export function captionWindows(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(CAPTION_WINDOW_SELECTOR)].filter((w) => !w.hasAttribute(ATTR_YT_HINT));
}

/**
 * 视频站页面界面（非正文）：导航、推荐列表、广告、按钮、频道/订阅信息、简介附加区块（转写稿、信息卡、商品）、评论区的标题与作者行等。
 * 视频页只应标注字幕、简介正文与评论正文（以及标题），这些界面文字整棵跳过。
 * YouTube 桌面版（ytd-*）与 m.youtube.com（ytm-*）都用自定义元素，按标签名片段识别（2026-10 实测结构），结果按标签名缓存，单次判断 O(1)。
 */
const UI_TAG_PARTS = [
  // 导航与弹出层
  'MASTHEAD', 'GUIDE', 'TOPBAR', 'PIVOT-BAR', 'APP-DRAWER', 'CHIP', 'MENU', 'TOOLTIP', 'DROPDOWN', 'POPUP-CONTAINER', 'MEALBAR', 'BOTTOM-SHEET',
  // 按钮与徽标
  'BUTTON', 'BADGE',
  // 推荐列表 / 信息流（侧栏、首页、片尾推荐、Shorts 货架）
  'LOCKUP', 'VIDEO-WITH-CONTEXT', 'COMPACT-', 'RICH-GRID', 'RICH-ITEM', 'RICH-SHELF', 'REEL-SHELF', 'SHORTS', 'YTD-VIDEO-RENDERER', 'MEDIA-ITEM',
  'WATCH-NEXT-SECONDARY', 'MERCH-SHELF', 'CAROUSEL',
  // 广告
  'AD-SLOT', 'AD-LAYOUT', 'ADS-RENDERER', 'AD-BADGE', 'AD-AVATAR', 'AD-DETAILS', 'PROMOTED', 'COMPANION',
  // 频道 / 订阅 / 操作栏 / 简介附加区块 / 评论区界面
  'OWNER', 'CHANNEL-NAME', 'BYLINE', 'ACTION-BAR', 'ENGAGEMENT-BAR', 'PANEL-TITLE-HEADER', 'PANEL-HEADER', 'DESCRIPTION-TRANSCRIPT', 'DESCRIPTION-INFOCARDS', 'DESCRIPTION-MUSIC',
  'DESCRIPTION-HEADER', 'DESCRIPTION-COURSE', 'DESCRIPTION-GAMING', 'WATCH-INFO-TEXT',
  'COMMENTS-HEADER', 'COMMENT-SIMPLEBOX', 'PINNED-COMMENT-BADGE',
];
/** 评论作者行、发布时间等没有专属自定义元素的界面块 */
const UI_IDS = new Set(['header-author', 'published-time-text', 'owner-sub-count', 'masthead-container', 'secondary', 'related', 'guide']);
const uiTagCache = new Map<string, boolean>();

export function isYouTubeUiElement(el: Element): boolean {
  if (el.id && UI_IDS.has(el.id)) return true;
  const tag = el.tagName;
  if (tag === 'BUTTON') return true;
  if (!tag.includes('-')) return false;
  let hit = uiTagCache.get(tag);
  if (hit === undefined) {
    hit = (tag.startsWith('AD-') || UI_TAG_PARTS.some((p) => tag.includes(p))) && !tag.includes('CAPTION');
    uiTagCache.set(tag, hit);
  }
  return hit;
}

/**
 * engine 扫描跳过规则（O(1)，只看元素自身与父元素）：
 * - 主播放器的直接子元素中，只放行字幕容器（字幕标注关闭时也跳过）；控件栏、章节标题、片尾推荐、设置菜单等整棵跳过
 * - 其他播放器（侧栏悬停预览等）整个跳过
 * - 自动字幕提示窗口跳过
 * - 页面界面（导航、推荐、广告、按钮等，见 isYouTubeUiElement）跳过
 * engine 处理增量时会逐个祖先调用，因此字幕内的文本也会经过“主播放器的直接子元素”这一层判断。
 */
export function createSkipRule(captionsEnabled: () => boolean): (el: Element) => boolean {
  return (el) => {
    if (isYouTubeUiElement(el)) return true;
    if (el.parentElement?.id === PLAYER_ID) {
      return !el.classList.contains(CAPTION_CONTAINER_CLASS) || !captionsEnabled();
    }
    if (el.id !== PLAYER_ID && el.classList.contains(PLAYER_CLASS)) return true;
    return el.hasAttribute(ATTR_YT_HINT);
  };
}
