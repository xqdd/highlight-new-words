# 审核备注

[TOC]

Edge 提交时填入“Notes for certification”；Chrome 没有专门的备注框，审核被拒申诉时可引用同样内容。审核员多用英文，直接粘贴第二节。

## 一、中文要点

- 无需账号即可测试核心功能：安装后默认启用“大学英语六级”词书，打开任意英文网页（如 BBC、维基百科英文版）即可看到高亮；悬停或点按高亮词出现释义卡片。
- 有道/欧路生词本同步是可选功能，需要用户自己的账号；欧路使用用户在欧路官网生成的 OpenAPI token。审核无需测试账号也能验证其余功能。
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

Optional features that need the user's own account: syncing word books from Youdao Dictionary (uses the user's existing login cookie on dict.youdao.com) and Eudic (uses an API token the user generates on the Eudic website). They are off by default.

No remote code: all scripts are bundled; built-in word lists and dictionary data are JSON files in the package's data/ folder. The UI is in Simplified Chinese.
Source code: https://github.com/xqdd/highlight_new_words
```
