# Store Listing (English)

[TOC]

Targets: Chrome Web Store and Microsoft Edge Add-ons (Firefox is not listed for now). Limits and the date they were verified are recorded in docs/release.md.

## 1. Name and Summary (from the package manifest, shared by both stores)

Name and summary come from `public/_locales/en/messages.json` (`appName`, `appDesc`). Both stores read them from the manifest; they cannot be edited in the dashboards, so a change requires a new package.

| Field | Current value | Limit | Status |
| --- | --- | --- | --- |
| Name `appName` | Highlight New Words – Vocabulary Builder for Youdao, Eudic, CET & IELTS | Chrome: max 75 chars | 71 chars, OK |
| Summary `appDesc` | Highlight new words from Youdao/Eudic word books and graded lists (CET, IELTS, TOEFL, GRE) on web pages, with inline glosses | Chrome: max 132 chars | 124 chars, OK |

## 2. Detailed Description - Chrome Web Store

Plain text only (no HTML/Markdown); keep under 16,000 characters; no keyword stuffing. The text below is about 3,780 characters and was checked against the current build on 2026-10-01. The interface is currently in Simplified Chinese, which the description states up front.

```text
Highlight New Words is a vocabulary builder and word highlighter for English learning: it marks the words you are studying on any web page and in YouTube captions, taken from your Youdao or Eudic word book or from built-in CET, IELTS and TOEFL lists. Hover (or tap on mobile) to see phonetics, meaning and word forms, and mark a word as known in one click so it never shows up again.
Note: the interface and the built-in glosses are in Simplified Chinese.

CHOOSE WHAT TO LEARN
- Built-in graded word books: Chinese exam lists (Zhongkao, Gaokao, CET-4, CET-6, postgraduate entrance, TEM-4, TEM-8), IELTS, TOEFL, SAT, GRE; CEFR levels A2 to C2; COCA frequency bands. Combine them freely; pick B2 to highlight B2 and above.
- Sync your cloud word books from Youdao Dictionary and Eudic. Each remote word book becomes a separate book with its own sync status; Eudic's "mastered words" list can be synced as a known-words list.
- Import your own lists: TXT, CSV, TSV, Youdao XML export, Eudic export, Anki plain-text export.

READ WITHOUT INTERRUPTION
- Inline glosses after or above each highlighted word, switchable at any time.
- Word card with phonetics, pronunciation, full definitions, exam tags and word-form notes such as "past tense of run".
- Choose how the card opens: hover (adjustable delay), hold a modifier key while hovering, or click; tap on touch screens.
- Lemmatization: running and ran both count as run; marking a word as known hides all of its forms.
- Many highlight styles (background, marker, underline, wavy, dotted, colored text), per-book colors, automatic contrast on dark pages.
- Code block highlighting (off by default): mark new words in code comments and strings on technical pages; online editors and input fields are left alone.

YOUTUBE CAPTIONS
- New words in captions are highlighted, with short glosses above the word or after it; auto-generated captions are highlighted only.
- Press Alt+L to pause the video and open the current-caption panel: the sentence is shown large, every word can be looked up, and you can step to the previous or next sentence or resume playback from there.
- Optional: pause automatically while the mouse is over the captions and resume when it leaves.

MOBILE AND TOUCH
- Works on mobile browsers such as Microsoft Edge for Android, with a touch-friendly bottom card.
- A floating button at the screen edge lists the new words on the page (mark them as known in one tap) and offers a word-pick mode (tap any word to look it up), quick settings (inline glosses, word books) and sync status. On YouTube video pages it opens the current-caption panel directly. Drag it anywhere or hide it per site.

WORD BOOKS, KNOWN WORDS AND SYNC
- "Add to word book" on the card saves a word to a local word book or to your Youdao / Eudic cloud word book.
- When marking a word as known, choose which known-words lists to write to and which word books (local or cloud) to remove it from; by default it only goes to the local known-words list. Undo is available for 10 minutes.
- Import and export your known-words list.
- Settings, known words and imported books can be synced or backed up in several ways, used together if you like: your browser account; WebDAV (Nextcloud, Synology, Jianguoyun and other servers you own); or a manual backup file, imported with merge or overwrite. Credentials such as the Eudic token or WebDAV password are not uploaded unless you opt in.

MORE
- Turn highlighting on or off per site; the toolbar badge shows how many new words are on the page, and the popup lists them along with sync status.
- Page text is matched locally and never uploaded. The extension has no developer server and no analytics.

Privacy policy: <privacy policy URL>
Feedback: https://github.com/xqdd/highlight_new_words/issues
```

## 3. Detailed Description - Microsoft Edge Add-ons

Limit: 250 to 10,000 characters and it must describe the full functionality. Reuse section 2 (it covers every feature; about 3,840 characters with the line below) and add this line after the first paragraph:

```text
Works on Microsoft Edge for desktop and Edge for Android.
```

## 4. Edge Search Terms

Limit: at most 7 terms, 21 words in total, 30 characters per term; not shown to users. The 7 terms below have 18 words in total; the longest is 22 characters.

```text
vocabulary builder
word highlighter
English learning
Youdao Eudic word book
CET IELTS TOEFL
English reading
learn English words
```

## 5. Category and Other Fields

| Field | Chrome | Edge |
| --- | --- | --- |
| Category | Education | Education |
| Website / support | https://github.com/xqdd/highlight_new_words | same |
| Mature content | No | No |
| Screenshots | store/images/screenshots-en, 1280x800; upload `1` to `5` (max 5) | upload all six in the same folder (max 6) |
| Small promo tile | store/images/promo-small-440x280.png (required) | same (optional) |
| Marquee promo tile | store/images/promo-marquee-1400x560.png (optional) | same (optional) |
| Icon / logo | 128x128 in the package; store icon store/images/icon-store-128.png | logo store/images/logo-edge-300.png (300x300) |
