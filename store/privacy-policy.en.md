# Highlight New Words Privacy Policy

Effective date: October 1, 2026 (applies to version 3.0.0 and later)

"Highlight New Words" (the "extension") is an open-source browser extension; the source code is at https://github.com/xqdd/highlight_new_words . The extension **has no developer server, and does not collect, sell or share any personal data. It contains no analytics or ad tracking.**

## 1. Data processed on your device

- **Page text**: the content script reads the text of pages you open and compares it with your word books locally to highlight words. Page text is never stored and never leaves your device.
- **Your settings and word lists**: settings, known words, imported word books and word books synced from Youdao/Eudic are kept in the browser's extension storage (`storage.local`).
- **Tab URLs**: the toolbar badge count is kept per tab in the browser's session storage (`storage.session`) and cleared when the tab navigates or the browser closes. The popup reads the current URL only to show the site name and to let you turn highlighting on or off for that site.
- **Credentials**: the Eudic API token and WebDAV username/password are stored only on your device. They are excluded from sync by default and are uploaded to the sync location you chose only if you tick "upload with sync" for that credential.
- **Pronunciation**: speech uses the text-to-speech engine provided by your browser or operating system and only reads the word you clicked. Some browser voices may be synthesized online by the browser vendor; this is controlled by the browser and the extension receives none of that data.

## 2. Network requests that happen only when you turn a feature on

Requests go directly from your browser to the services below, never through an intermediate server. The only one on by default is the Youdao word book source (as in previous versions): at most once a day, when the extension starts, it reads your Youdao word book using only the Youdao login cookie already in your browser. If you are not logged in, the read fails, nothing is stored, and the extension shows that Youdao needs setup; you can turn the source off in the settings.

| Feature | Recipient | What is sent | Purpose |
| --- | --- | --- | --- |
| Youdao word book source | Youdao Dictionary `dict.youdao.com` | Your Youdao login cookie, attached automatically by the browser; the word being removed or re-added | Read your Youdao word books; remove or re-add words as you configured |
| Eudic word book source | Eudic `api.frdic.com`, `my.eudic.net`, `dict.eudic.net` | The Eudic API token you entered, or your Eudic login cookie attached by the browser; the word being added or removed | Read your Eudic word books and categories; add or remove words as you configured |
| WebDAV sync | The WebDAV server you entered | Your WebDAV credentials; sync data (settings, known words, imported word books, and credentials only if you chose so) | Back up and sync on your own server |
| Browser account sync | Your browser vendor's sync service (e.g. Google or Microsoft account) | Compressed sync data (as above) | Sync between devices signed in to the same browser account |

These services handle data under their own privacy policies. You can turn off any source or sync method in the extension settings at any time. Uninstalling the extension deletes all data stored on your device (data in the browser's sync storage is managed by the browser).

## 3. What we do not do

- We do not send page content, browsing history or your word lists to the developer or to any third party not listed above.
- We do not use analytics, telemetry, crash reporting or advertising SDKs.
- We do not load or execute remote code; built-in word lists and dictionaries ship inside the extension.
- We do not sell or transfer user data, or use it for any purpose unrelated to highlighting words.

## 4. Permissions

The purpose of each browser permission is documented in `store/permissions.md` in the source repository.

## 5. Changes and contact

When this policy changes, this page and its effective date will be updated, and changes to how data is handled will be noted in the extension's release notes. Questions and feedback: https://github.com/xqdd/highlight_new_words/issues
