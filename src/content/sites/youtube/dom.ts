/**
 * YouTube 播放器 DOM 约定（选择器集中在此，YouTube 改版时只改这里）。
 * 结构（桌面与 m.youtube.com 一致，2026-10 实测）：
 * `#movie_player > .ytp-caption-window-container > .caption-window[.ytp-caption-window-rollup] > .captions-text > .caption-visual-line > .ytp-caption-segment`
 * - 人工字幕（pop-on）每条整窗重建；自动生成字幕（roll-up）窗口带 `ytp-caption-window-rollup`，高度固定、overflow:hidden，逐词追加，换行上滚时整行移除再重新插入（见 captions.ts#carryOver）
 * - 自动字幕开头的 “English (auto-generated) / Click ⚙ for settings” 提示是一个单独的 `ytp-caption-window-top` 窗口
 * - 侧栏推荐位的悬停预览播放器也是 `.html5-video-player`，但 id 不是 movie_player
 */
export const PLAYER_ID = 'movie_player';
export const PLAYER_CLASS = 'html5-video-player';
export const CAPTION_CONTAINER_CLASS = 'ytp-caption-window-container';
export const CAPTION_WINDOW_SELECTOR = `#${PLAYER_ID} .${CAPTION_CONTAINER_CLASS} .caption-window`;
export const CAPTION_SEGMENT_CLASS = 'ytp-caption-segment';
/** 自动生成字幕（roll-up）窗口：高度固定、overflow:hidden；手机全屏时字幕内译文的 above/below 在此类窗口中改用 after（见 CaptionDecorator#rollupAsAfter） */
export const ROLLUP_CLASS = 'ytp-caption-window-rollup';
/** 播放器控件自动隐藏时播放器根元素带此类名（控件出现后字幕整体上移） */
export const AUTOHIDE_CLASS = 'ytp-autohide';
/** 播放广告时播放器根元素带此类名 */
export const AD_SHOWING_CLASS = 'ad-showing';
export const CHROME_BOTTOM_CLASS = 'ytp-chrome-bottom';

/** 我们加在字幕窗口上的标记：自动字幕提示窗口。照常标注，只用于“当前字幕”取词时不把提示当字幕内容（captionWindows） */
export const ATTR_YT_HINT = 'data-hnw-yt-hint';
/** 我们加在字幕内 hnw-mark 上的单词上方注解文本（CSS ::after 渲染，不进入 textContent） */
export const ATTR_YT_GLOSS = 'data-hnw-yt-gloss';
/**
 * 我们加在字幕窗口上的译文模式：above（上方注解）/ after（词后小字）；不设置 = 只高亮。
 * 按窗口设置：所有字幕窗口（含自动生成字幕与提示窗口）同样设置；after 放不下（超出播放器宽度）的窗口单独改成 above
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
 * engine 扫描跳过规则：YouTube 页面不做任何特殊跳过（界面、推荐、播放器、自动字幕提示都照常标注，用户决定）；
 * 只在用户关闭“YouTube 字幕中标注生词”（settings.youtube.captions）时跳过字幕容器。
 */
export function createSkipRule(captionsEnabled: () => boolean): (el: Element) => boolean {
  return (el) => el.classList.contains(CAPTION_CONTAINER_CLASS) && !captionsEnabled();
}
