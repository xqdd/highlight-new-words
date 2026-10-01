# 审核备注

[TOC]

Edge 提交时填入“Notes for certification”；Chrome 没有专门的备注框，审核被拒申诉时可引用同样内容。审核员多用英文，直接粘贴第二节。

## 一、中文要点

- 无需账号即可测试核心功能：安装后默认启用“大学英语六级”词书，打开任意英文网页（如 BBC、维基百科英文版）即可看到高亮；悬停或点按高亮词出现释义卡片。
- YouTube 字幕：打开任意带英文字幕的视频并打开字幕（CC），字幕中的生词被高亮，单词上方显示简短释义；按 Alt+L 暂停视频并打开“当前字幕面板”，可点词查释义、切换上一句/下一句，按 Esc 关闭并继续播放。
- 手机悬浮球：在 Edge for Android（或桌面浏览器开发者工具的触屏手机模拟）中打开英文网页，屏幕右侧出现悬浮球，点按打开菜单，可看到本页生词、取词模式、快捷设置和同步状态；在 YouTube 视频页点按悬浮球直接打开当前字幕面板。桌面端不显示悬浮球。
- 有道生词本来源默认启用（与旧版一致），欧路默认关闭。启用的有道来源在扩展启动时最多每天一次向 `dict.youdao.com` 读取用户的有道生词本，只依靠浏览器里已有的有道登录 cookie；未登录时这次读取失败，不保存任何数据、不再重试，弹窗底部提示“有道词典：未登录”、悬浮球菜单底栏显示“有道词典待设置”。除此之外不向任何服务发送数据。欧路需要用户在欧路官网生成的 OpenAPI token。审核无需测试账号也能验证其余功能。
- 无远程代码；内置词书与词典是扩展包内 `data/` 目录下的 JSON。
- 构建产物由 WXT（Vite）打包压缩，源码公开在 GitHub。

## 二、English (paste this)

```text
How to test (no account needed):
1. After installing, the "CET-6" word book is enabled by default.
2. Open any English article, e.g. https://en.wikipedia.org/wiki/Climate_change . Words from the enabled word book are highlighted.
3. Hover a highlighted word (tap on mobile) to open the word card: phonetics, meaning, "mark as known".
4. Click the toolbar icon: the popup lists the words found on the page and lets you switch word books, toggle inline translations and turn highlighting off for the site.
5. The options page (gear icon) has word books, highlight styles, known words and sync settings.
6. YouTube captions: open any YouTube video with English captions and turn captions (CC) on. New words in the captions are highlighted with short glosses above them. Press Alt+L to pause the video and open the current-caption panel; tap words to look them up, switch to the previous or next sentence, and press Esc to close it and resume playback.
7. Mobile floating button: open an English page in Edge for Android (or in desktop DevTools device emulation with touch). A floating button appears at the right edge; tap it to open a sheet with the new words on the page, word-pick mode, quick settings and sync status. On a YouTube video page, tapping it opens the current-caption panel directly. The button is not shown on desktop.

Optional word book sources: the Youdao Dictionary source is enabled by default (as in previous versions) and the Eudic source is off by default. When enabled, Youdao is read from dict.youdao.com at most once a day when the extension starts, using only the user's existing Youdao login cookie in the browser. If the user is not logged in, that read fails, nothing is stored, it is not retried that day, and the popup footer shows "Youdao: not logged in" (有道词典：未登录) while the floating-button sheet shows "Youdao needs setup" (有道词典待设置). Nothing else is sent anywhere. Eudic uses an API token the user generates on the Eudic website.

No remote code: all scripts are bundled; built-in word lists and dictionary data are JSON files in the package's data/ folder. The UI is in Simplified Chinese.
Source code: https://github.com/xqdd/highlight_new_words
```
