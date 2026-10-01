# Store Listing (English)

[TOC]

Targets: Chrome Web Store and Microsoft Edge Add-ons (Firefox is not listed for now). Limits and the date they were verified are recorded in docs/release.md.

## 1. Name and Summary (from the package manifest, shared by both stores)

Name and summary come from `public/_locales/en/messages.json` (`appName`, `appDesc`). Both stores read them from the manifest; they cannot be edited in the dashboards, so a change requires a new package.

| Field | Current value | Limit | Status |
| --- | --- | --- | --- |
| Name `appName` | Highlight New Words - Youdao/Eudic word book & graded vocabularies | Chrome: max 75 chars | 66 chars, OK |
| Summary `appDesc` | (current value is 164 chars) | Chrome: max 132 chars | **Too long, must be shortened before upload** |

Proposed summary (118 chars):

```text
Highlight words from your Youdao/Eudic word books and graded lists (CET, IELTS, TOEFL, GRE) on web pages, with glosses
```

## 2. Detailed Description - Chrome Web Store

Plain text only (no HTML/Markdown); keep under 16,000 characters; no keyword stuffing. The interface is currently in Simplified Chinese, which the description states up front.

```text
Learning English by reading? Highlight New Words marks the words you are studying on any web page. Hover (or tap on mobile) to see phonetics, meaning and word forms, and mark a word as known in one click so it never shows up again.
Note: the interface and the built-in glosses are in Simplified Chinese.

CHOOSE WHAT TO LEARN
- Built-in graded word books: Chinese exam lists (Zhongkao, Gaokao, CET-4, CET-6, postgraduate entrance, TEM-4, TEM-8), IELTS, TOEFL, SAT, GRE; CEFR levels A2 to C2; COCA frequency bands. Combine them freely; pick B2 to highlight B2 and above.
- Sync your cloud word books from Youdao Dictionary and Eudic. Each remote word book becomes a separate book with its own sync status.
- Import your own lists: TXT, CSV, TSV, Youdao XML export, Eudic export, Anki plain-text export.

READ WITHOUT INTERRUPTION
- Inline glosses after or above each highlighted word, switchable at any time.
- Word card with phonetics, pronunciation, full definitions, exam tags and word-form notes such as "past tense of run".
- Lemmatization: running and ran both count as run; marking a word as known hides all of its forms.
- Many highlight styles (background, marker, underline, wavy, dotted, colored text), per-book colors, automatic contrast on dark pages.

KNOWN WORDS AND SYNC
- Import and export your known-words list. Optionally remove a word from your source word books when you mark it as known (off by default).
- Settings, known words and imported books can sync across devices through your browser account.

MORE
- Turn highlighting on or off per site; the toolbar badge shows how many new words are on the page.
- Works on mobile browsers such as Microsoft Edge for Android, with a touch-friendly bottom card.
- Page text is matched locally and never uploaded. The extension has no developer server and no analytics.

Privacy policy: <privacy policy URL>
Feedback: https://github.com/xqdd/highlight_new_words/issues
```

## 3. Detailed Description - Microsoft Edge Add-ons

Limit: 250 to 10,000 characters and it must describe the full functionality. Reuse section 2 and add this line after the first paragraph:

```text
Works on Microsoft Edge for desktop and Edge for Android.
```

## 4. Edge Search Terms

Limit: at most 7 terms, 21 words in total, 30 characters per term; not shown to users.

```text
vocabulary
word highlighter
English reading
CET
Youdao
Eudic
learn English
```

## 5. Category and Other Fields

| Field | Chrome | Edge |
| --- | --- | --- |
| Category | Education | Education |
| Website / support | https://github.com/xqdd/highlight_new_words | same |
| Mature content | No | No |
| Screenshots | store/images/screenshots-en, five 1280x800 images | same (max 6) |
| Small promo tile | store/images/promo-small-440x280.png (required) | same (optional) |
| Marquee promo tile | store/images/promo-marquee-1400x560.png (optional) | same (optional) |
| Icon / logo | 128x128 in the package; store icon store/images/icon-store-128.png | logo store/images/logo-edge-300.png (300x300) |
