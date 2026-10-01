import { registerSiteSkipRule } from '../../engine/dom';
import { registerFloatAction } from '../../floatball/registry';
import type { SiteAdapter, SiteContext } from '../types';
import { CaptionDecorator } from './captions';
import { AD_SHOWING_CLASS, CAPTION_CONTAINER_CLASS, createSkipRule, getPlayer, getVideo, isYouTubeHost } from './dom';
import { HoverPause } from './hover';
import { CaptionPanel } from './panel';
import { PauseController } from './playback';
import { CaptionHistory, TimedtextSource } from './track';

/** 播放器/字幕容器检查间隔（ms）：YouTube 是 SPA，播放器与字幕容器可能在导航后重建 */
const ATTACH_POLL_MS = 1000;

/** 当前视频 id：/watch?v=…（桌面与 m.youtube.com）、/embed/<id>、/shorts/<id> */
export function currentVideoId(loc: Pick<Location, 'pathname' | 'search'> = location): string {
  const v = new URLSearchParams(loc.search).get('v');
  if (v) return v;
  const m = loc.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/);
  return m?.[1] ?? '';
}

/** 是否视频页（有主播放器的观看页 / 内嵌播放器） */
function isVideoPage(): boolean {
  return location.pathname === '/watch' || location.pathname.startsWith('/embed/') || location.pathname.startsWith('/live/');
}

/** Alt+L：打开/关闭当前字幕面板（不与 YouTube 自带快捷键冲突：YouTube 的 l 是快进 10 秒，不带 Alt） */
function isPanelShortcut(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyL';
}

/**
 * YouTube 适配层（v9）：
 * 1. 范围：只标注 #movie_player 内的字幕；控件、章节标题、其他播放器（侧栏预览）、自动字幕提示一律跳过（engine 跳过规则）
 * 2. 字幕内生词译文：默认上方注解，可改为词后或只高亮，不撑破 YouTube 的字幕排版（CaptionDecorator）
 * 3. 当前字幕面板：触屏点悬浮球（primary 功能项）或桌面 Alt+L 打开，暂停并逐词查看（CaptionPanel）
 * 4. 桌面悬停字幕自动暂停（默认关，HoverPause）
 * 暂停/恢复统一走 PauseController：只恢复由我们发起的暂停。
 */
export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  matches: isYouTubeHost,
  start(ctx: SiteContext) {
    const doc = ctx.doc;
    const stops: Array<() => void> = [];
    stops.push(registerSiteSkipRule(createSkipRule(() => ctx.getSettings().youtube.captions)));

    // 广告中不暂停（广告和正片共用 video 元素）
    const pause = new PauseController(doc, () => getVideo(doc), () => !getPlayer(doc)?.classList.contains(AD_SHOWING_CLASS));
    const history = new CaptionHistory();
    const timedtext = new TimedtextSource(location.origin);
    timedtext.start();
    const decorator = new CaptionDecorator(ctx, (text) =>
      history.record(currentVideoId(), text, Math.round((getVideo(doc)?.currentTime ?? 0) * 1000)),
    );
    const panel = new CaptionPanel(ctx, pause, { timedtext, history, videoId: () => currentVideoId() });
    const hover = new HoverPause(ctx, pause, () => panel.host, () => panel.isOpen);

    // 悬浮球（只在触屏显示）：视频页点球直接打开当前字幕面板，菜单里也有这一项
    stops.push(
      registerFloatAction({
        id: 'youtube-captions',
        label: '当前字幕',
        hint: '暂停视频，逐词查看',
        primary: true,
        available: () => isVideoPage() && !!getPlayer(doc),
        run: () => void panel.open(),
      }),
    );

    // 字幕容器绑定：播放器在 SPA 导航后才出现/重建，定时检查（只是两次 getElementById 级别的查询）
    const attach = () => {
      const c = getPlayer(doc)?.querySelector(`:scope > .${CAPTION_CONTAINER_CLASS}`) ?? null;
      decorator.attach(c);
    };
    const timer = setInterval(attach, ATTACH_POLL_MS);
    doc.addEventListener('yt-navigate-finish', attach);
    attach();

    const onKey = (e: KeyboardEvent) => {
      if (!isPanelShortcut(e) || !getPlayer(doc) || !ctx.isActive()) return;
      e.preventDefault();
      e.stopPropagation();
      panel.toggle();
    };
    // window 捕获阶段：早于 YouTube 自己的快捷键处理
    window.addEventListener('keydown', onKey, true);

    // 视频切换（SPA 导航）时关闭面板
    const onNavigate = () => panel.close({ resume: false });
    doc.addEventListener('yt-navigate-start', onNavigate);

    hover.sync();
    decorator.refresh();
    stops.push(
      ctx.onSettingsChange(() => {
        hover.sync();
        decorator.refresh();
      }),
    );

    return () => {
      stops.forEach((s) => s());
      clearInterval(timer);
      doc.removeEventListener('yt-navigate-finish', attach);
      doc.removeEventListener('yt-navigate-start', onNavigate);
      window.removeEventListener('keydown', onKey, true);
      hover.destroy();
      panel.destroy();
      decorator.destroy();
      timedtext.stop();
      pause.destroy();
    };
  },
};
