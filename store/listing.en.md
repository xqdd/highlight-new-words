# Store Listing (English)

[TOC]

Targets: Chrome Web Store and Microsoft Edge Add-ons (Firefox is not listed for now). Release instructions: [docs/release.md](../docs/release.md).

## 1. Name and Summary (from the package manifest, shared by both stores)

Name and summary come from `public/_locales/en/messages.json` (`appName`, `appDesc`). Both stores read them from the manifest; they cannot be edited in the dashboards, so a change requires a new package.

| Field | Current value | Limit | Status |
| --- | --- | --- | --- |
| Name `appName` | Highlight New Words: English Reading & Vocabulary | Chrome: max 75 chars | OK |
| Summary `appDesc` | Read English with word highlights, Chinese glosses, word-prefix emphasis and grammar cues. Custom themes and YouTube captions. | Chrome: max 132 chars | OK |

## 2. Detailed Description - Chrome Web Store

Plain text only (no HTML/Markdown); keep under 16,000 characters. Avoid keyword stuffing. The text below describes version 3.1.0. The interface is currently in Simplified Chinese, which the description states up front.

```text
Keep reading English in its original form, with vocabulary glosses, word-prefix emphasis and visual grammar cues you can tailor to your preferences. Highlight New Words also marks the words you are studying on web pages and in YouTube captions, from your Youdao or Eudic word books or the built-in graded lists. Hover (or tap on mobile) for phonetics, meaning and word forms, and mark a word as known to stop highlighting it.
Note: the interface and the built-in glosses are in Simplified Chinese.

CUSTOMIZE YOUR ENGLISH READING
- Optional reading aids, off by default: word-prefix emphasis (bionic reading), parts of speech and semantic cues, preserving the page's original layout.
- Eleven word classes include pronouns, determiners, prepositions, conjunctions and numerals; four semantic cues cover negation, logical connections, quantities and proper names. Control each independently.
- Choose from 81 themes using text colors, solid/dotted/wavy underlines, subtle backgrounds, markers, colored bold or mixed styles. Customize each item's style and color. Global and feature presets remember your custom settings separately.
- Choose whether reading styles or vocabulary styles take priority, including when showing glosses only. Select a short phrase to look it up in the bundled dictionary.
- Analysis and phrase lookup run locally, without an LLM or translation service. Automatic labels may be ambiguous. Reading aids do not promise faster reading or native-level proficiency.

CHOOSE WHAT TO LEARN
- Built-in graded word books covering Chinese school, university and graduate entrance exams and common study-abroad tests, plus CEFR levels, COCA frequency bands, a general core list and subject lists for academic, business, medical and computing English. Combine them freely; pick B2 to highlight B2 and above.
- Sync your cloud word books from Youdao Dictionary and Eudic. Each remote word book becomes a separate book with its own sync status; Eudic's "mastered words" list can be synced as a known-words list.
- Import your own lists from plain-text or spreadsheet files, or from word lists exported by Youdao, Eudic or Anki.

READ WITHOUT INTERRUPTION
- Inline glosses after or above each highlighted word, switchable at any time.
- Word card with phonetics, pronunciation, full definitions, exam tags and word-form notes such as "past tense of run".
- Choose how the card opens: hover (adjustable delay), hold a modifier key while hovering, or click; tap on touch screens.
- Lemmatization: running and ran both count as run; marking a word as known hides all of its forms.
- Many highlight style presets (or show glosses only, without highlighting), per-book colors, automatic contrast on dark pages.
- Code block highlighting (off by default): mark new words in code comments and strings on technical pages; online editors and input fields are left alone.

YOUTUBE CAPTIONS
- New words in captions are highlighted, with short glosses above, below or after the word.
- Press Alt+L to pause the video and open the current-caption panel: the sentence is shown large, every word can be looked up, and you can step to the previous or next sentence or resume playback from there.
- Optional: pause automatically while the mouse is over the captions and resume when it leaves.

MOBILE AND TOUCH
- Works on mobile browsers such as Microsoft Edge for Android, with a touch-friendly bottom card.
- A floating button at the screen edge lists the new words on the page (mark them as known in one tap) and offers a word-pick mode (tap any word to look it up), quick settings (inline glosses, word books) and sync status. On YouTube video pages it opens the current-caption panel directly. Drag it anywhere or hide it per site.

WORD BOOKS, KNOWN WORDS AND SYNC
- "Add to word book" on the card saves a word to a local word book or to your Youdao / Eudic cloud word book.
- When marking a word as known, choose which known-words lists to write to and which word books (local or cloud) to remove it from; by default it only goes to the local known-words list. Undo is available for 10 minutes.
- Import and export your known-words list. Any word book can also serve as a known-words list; for example, set B2 as known to stop highlighting words below B2.
- Settings, known words and imported books can be synced or backed up in several ways, used together if you like: your browser account; WebDAV on a server you own; or a manual backup file, imported with merge or overwrite. Credentials such as the Eudic token or WebDAV password are not uploaded unless you opt in.

MORE
- Site allowlists and blocklists support domains, wildcards and restricted regular expressions. Reading aids can use separate rules or inherit the global rules. The toolbar badge and popup show page words and sync status.
- Page text is matched locally and never uploaded. The extension has no developer server and no analytics.

Feedback: https://github.com/xqdd/highlight-new-words/issues
```

## 3. Detailed Description - Microsoft Edge Add-ons

Limit: 250 to 10,000 characters and it must describe the full functionality. Reuse section 2 and add this line after the first paragraph:

```text
Works on Microsoft Edge for desktop and Edge for Android.
```

## 4. Edge Search Terms

Limit: at most 7 terms, 21 words in total, 30 characters per term; not shown to users. The 7 terms below have 17 words in total; the longest is 22 characters.

```text
vocabulary builder
word highlighter
English learning
Youdao Eudic word book
reading themes
English reading
learn English words
```

## 5. Category and Other Fields

| Field | Chrome | Edge |
| --- | --- | --- |
| Category | Education | Education |
| Website / support | https://github.com/xqdd/highlight-new-words | same |
| Mature content | No | No |
| Screenshots | store/images/screenshots-en, 1280x800; upload `1` to `5` (max 5) | upload all six in the same folder (max 6) |
| Small promo tile | store/images/promo-small-440x280.png (required) | same (optional) |
| Marquee promo tile | store/images/promo-marquee-1400x560.png (optional) | same (optional) |
| Icon / logo | 128x128 in the package; store icon store/images/icon-store-128.png | logo store/images/logo-edge-300.png (300x300) |
