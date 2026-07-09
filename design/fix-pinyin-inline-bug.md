# Bug fix: pinyin renders inline with characters during playback

## What's wrong

When the Pinyin pill is ON, pinyin syllables appear **inline mixed into the character flow**
(e.g. "著名de的míngshèng名胜gǔjì古迹") instead of appearing as small text **stacked above**
each word. The bottom-right corner of the broken screenshot shows a sentence that IS rendering
correctly (pinyin above, character below), so the CSS is partially working — the problem is
that most words are not getting the stacked structure.

## Files to read first

- `frontend/index.html` — find `#screen-read-reader`, `#rdHan`, `.rd-toolbar`
- `frontend/style.css` — search for `.rd-word`, `.rd-han`, `.show-pinyin`
- `frontend/app.js` — search for `rdWordHTML`, `rdRenderPassage`, `rdSegment`, `rdUpdateHighlight`

## Root cause to diagnose

Check these three things in order:

### 1. Is `rdWordHTML` producing the right HTML?

The function must produce this exact structure for every word:
```html
<span class="rd-word" data-word="著名" data-pinyin="zhùmíng">
  <small>zhùmíng</small>
  <span class="rd-hz">著名</span>
</span>
```
The `<small>` must be INSIDE the `inline-flex column` span, NOT a sibling of it.
If it's a sibling, the pinyin will appear inline.

### 2. Is the segmenter returning pinyin embedded inside `w.word`?

Log what `/api/segment` returns for a sentence. If `w.word` already contains pinyin
characters mixed in (e.g. `"zhùmíng著名"` or `"著名zhùmíng"`), the pinyin is being
appended to the word string and then rendered as visible text.

Fix: strip any Latin/pinyin characters from `w.word` before passing it to `rdWordHTML`.
The pinyin should come from `w.pinyin` only. Example guard:
```js
// In rdRenderPassage, where words are mapped:
words.map(w => rdWordHTML(w.word, w.pinyin))
// Make sure w.word contains ONLY the Chinese characters/punctuation.
// If the API embeds pinyin in the word field, use w.hanzi or w.hz instead.
```

### 3. Is the CSS selector matching the right element?

The CSS rule that hides pinyin by default and shows it when toggled must be:
```css
.rd-word small { display: none; }
.rd-han.show-pinyin .rd-word small { display: block; }
```
And `#rdHan` in `index.html` must have the class `rd-han`:
```html
<div class="rd-han" id="rdHan"></div>
```
If the element only has `id="rdHan"` but NOT `class="rd-han"`, the selector
`.rd-han.show-pinyin .rd-word small` will never match and the `small` will stay
`display: none` — but that alone wouldn't produce the inline mixing.

Also verify that NO other CSS rule sets `small { display: inline }` or
`.rd-word small { display: inline }` that could override the `none` default.

## The fix

After diagnosing the root cause above, apply whichever of these applies:

**If the issue is in `rdWordHTML` HTML structure**, fix the function so it always
produces the nested structure:
```js
function rdWordHTML(word, py) {
  if (/^[\s\p{P}，。！？；：、""''（）…]+$/u.test(word)) {
    return `<span class="rd-punc">${escapeHtml(word)}</span>`;
  }
  return `<span class="rd-word" data-word="${escapeHtml(word)}" data-pinyin="${escapeHtml(py || '')}">` +
         `<small>${escapeHtml(py || '')}</small>` +
         `<span class="rd-hz">${escapeHtml(word)}</span>` +
         `</span>`;
}
```

**If the issue is pinyin embedded in `w.word`**, find where `rdRenderPassage` calls
`rdSegment` and extract only the hanzi field:
```js
// Use whichever field name the API uses for the raw characters:
words.map(w => rdWordHTML(w.word || w.hz || w.hanzi, w.pinyin || w.py || ''))
```

**If the issue is a missing `rd-han` class on `#rdHan`**, add it to `index.html`:
```html
<!-- Change: -->
<div id="rdHan"></div>
<!-- To: -->
<div class="rd-han" id="rdHan"></div>
```

**If there is a CSS conflict**, add specificity to the show-pinyin rule in `style.css`:
```css
.rd-han.show-pinyin .rd-word > small {
  display: block !important;
}
```

## Expected result after fix

- Pinyin pill OFF → only Chinese characters visible, no Latin text in the passage
- Pinyin pill ON → small pinyin text appears **above** each word, characters remain below
- During playback → the active sentence highlights in pink, characters do NOT change;
  pinyin stays above (if pill is on) or hidden (if pill is off)
- Tapping a word → opens the word sheet; no change to the passage text

## What NOT to change

Do not touch the playback logic (`rdPlayFrom`, `rdUpdateHighlight`, `rdUpdateDock`).
Do not change the `show-pinyin` / `show-trans` class toggle logic.
The bug is in rendering only — not in the play state.
