# 权限用途与隐私表单

[TOC]

本文是 Chrome 网上应用店“隐私权”标签页与 Edge 合作伙伴中心“Privacy”页的填写稿，每项给出中文说明和可直接粘贴的英文。权限以当前 chrome 产物的 manifest 为准（`wxt.config.ts` 中的 `permissions` / `host_permissions`），权限有增减时必须同步更新本文。

## 一、单一用途（Single purpose）

- 中文：在用户浏览的网页上高亮需要学习的英语单词（来自内置分级词书或用户自己的生词本），并显示释义，帮助用户在阅读中记单词。
- English: Highlights English words the user is learning (from built-in graded word lists or the user's own word books) on web pages and shows their meanings, so users can build vocabulary while reading.

## 二、权限说明

| 权限 | 用途 | 英文填写稿 |
| --- | --- | --- |
| `storage` | 保存设置、熟词本、导入的词书、同步下来的云端生词本；`storage.sync` 用于用户开启的跨设备同步 | Stores the user's settings, known-words list, imported word books and cached cloud word books locally. storage.sync is used only when the user enables cross-device sync. |
| `unlimitedStorage` | 云端生词本与熟词本可能有数万词，加上词典缓存会超过默认 10MB 配额 | Users' cloud word books and known-words lists can contain tens of thousands of entries, which can exceed the default 10 MB local storage quota. |
| `tts` | 卡片和弹窗中的发音按钮、可选的自动发音 | Pronounces a word when the user clicks the speaker button in the word card or popup (and optionally when a card opens). |
| `tabs` | 弹窗读取当前标签页网址以显示站点名、按网站开关高亮；向当前页内容脚本查询本页生词；开启高亮后刷新标签页；工具栏徽章按标签页显示生词数（网址变化时清零） | Reads the active tab's URL so the popup can show the site and toggle highlighting per site, queries the page's content script for the words found, reloads the tab after the user enables highlighting, and keeps the per-tab badge count in sync when the tab navigates. |
| `cookies` | ⚠ 当前代码未调用 cookies API（有道/欧路请求依靠 host 权限由浏览器自动携带 cookie）。**发布前由 background 模块确认后移除**，见 /tmp/gauntlet/release/issues.md；若确需保留，必须写出真实调用点 | — |
| 主机权限 `http://*/*`、`https://*/*` | ① 内容脚本需在用户打开的任意英文网页上运行才能高亮单词；② 后台请求用户开启的生词本来源：有道 `dict.youdao.com`、欧路 `my.eudic.net`、`dict.eudic.net`、`api.frdic.com`，以及用户自填的 WebDAV 服务器 | The content script must run on any page the user reads to find and highlight words; matching happens locally. The background also contacts services the user explicitly connects: Youdao (dict.youdao.com), Eudic (my.eudic.net, dict.eudic.net, api.frdic.com) and, if configured, the user's own WebDAV server. |
| 主机权限 `file://*/*` | 在本地保存的 HTML 网页上同样高亮（浏览器默认不允许，需要用户在扩展详情中手动开启“允许访问文件网址”） | Highlights words in local HTML files the user opens, if the user turns on "Allow access to file URLs". |
| `web_accessible_resources: data/*` | 内置词书和词典数据随扩展打包，由内容脚本按需读取，不从网络下载 | Built-in word lists and dictionary data are bundled with the extension and read by the content script on demand; nothing is downloaded from the network. |

## 三、远程代码

选择“否，我没有使用远程代码”。全部脚本随扩展包发布；内置词书/词典是扩展包内的 JSON 数据；对有道/欧路/WebDAV 的请求只收发数据（JSON/XML/文本），不执行返回内容。

English: No. All code is bundled in the package. Word lists and dictionary data are bundled JSON files. Requests to Youdao, Eudic or WebDAV only exchange data and never execute returned content.

## 四、数据使用披露

两家商店的勾选项相同（个人身份信息、健康信息、财务和付款信息、身份验证信息、个人通讯、位置、网络记录、用户活动、网站内容）。按“数据离开本机发给开发者或第三方”判断：

| 类别 | 是否勾选 | 依据 |
| --- | --- | --- |
| 身份验证信息 | **勾选（保守披露）** | 用户主动连接有道/欧路/WebDAV 时，扩展会把用户的登录 cookie（由浏览器自动携带）、欧路 API token、WebDAV 账号密码发给**对应服务本身**，仅用于读取/修改用户自己的生词本或备份；不发给开发者 |
| 网站内容 | 不勾选 | 内容脚本只在本地读取页面文字做匹配，不上传 |
| 网络记录 / 用户活动 | 不勾选 | 工具栏徽章用到的标签页网址只保存在本机 `storage.session`，不上传 |
| 其他类别 | 不勾选 | 不涉及 |

三项认证全部勾选（均属实）：

- 不出售或转让用户数据给第三方（批准的用例除外）；
- 不将用户数据用于与单一用途无关的目的；
- 不将用户数据用于判断信用或放贷。

## 五、隐私政策网址

填托管后的 [privacy-policy.md](privacy-policy.md) / [privacy-policy.en.md](privacy-policy.en.md) 地址（建议 GitHub Pages，见 [docs/release.md](../docs/release.md)）。两家商店都要求网址可公开访问，且内容与上面的披露一致。
