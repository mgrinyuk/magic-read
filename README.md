# Magic Read — Handoff Package

Two standalone, dependency-free HTML mockups built to your stack's conventions
(vanilla JS, `showScreen()` panels, CSS custom properties, inline `<symbol>`
sprite, Inter + Noto Sans SC, 700px shell + bottom tab bar). No build step.
Each can be opened directly in a browser and translated into your real
`index.html` / `style.css` / `app.js`.

| File | Screen | Stages |
|------|--------|--------|
| `reader.html` | **Reader** | setup → reader → exercises (menu → type 1 / type 2) |
| `speak-spotlight.html` | **Speak** | setup → practice (listen / record / feedback) → finish |

A **dev jump-bar** is pinned at the top of each file so you can preview every
stage. **Delete it on integration** (it's clearly marked, as is every demo-only
stub).

---

## reader.html

### Stages
1. **Setup** — `Paste / Library / Saved` tabs; selectable text tiles → *Start reading*.
2. **Reader** — one continuous, flowing passage (NOT sentence-cards). Toggles:
   - **Pinyin** → adds ruby pinyin above each word (`.han.show-pinyin`).
   - **Translate** → shows an interlinear English gloss under each paragraph (`.han.show-trans`).
   - **Voice** → bottom-sheet voice picker.
   - **🐢 Slow** → in the playback dock.
   - Tap any word → bottom-sheet with pinyin, part of speech, meaning, **Save to cards**.
   - **Bookmark** (top-right) → saves the whole text.
   - Playback dock: play/pause, progress, sentence counter, speed.
3. **Exercises** — a **menu** to choose the exercise type, then:
   - **Type 1 — Put the words in order** (tap tiles into slots, check, shake on wrong).
   - **Type 2 — Choose the missing word** (cloze multiple-choice).
   - Completing both → celebration screen.

### Integration points (search `INTEGRATION` in the file)
1. **TTS playback** (`togglePlay` / `runPlay`) — replace the interval timer with
   Google TTS for the active text + selected voice (`VOICES[S.voice]`); advance
   `S.active` from real audio sentence boundaries instead of a fixed tick.
2. **Slow toggle** (`toggleSlow`) — map to TTS `speakingRate`.
3. **Word data + lookup** — every token already carries `{hz, py, en, pos}`.
   Swap the inline `PASSAGE` for your tokeniser output (pinyin-pro + your dictionary).
4. **Save word to flashcards** (`saveWord`) — Supabase `flashcards` insert/delete.
5. **Bookmark / save text** (`toggleBookmark`) — Supabase `saved_texts`.
6. **Library / Saved lists** (`LIBRARY` / `SAVED` arrays) — Supabase queries.
7. **Exercise content** (`EX1_TARGET` / `EX1_BANK` / `EX2`) — generate the
   word-order target and the cloze options from the active text.

### Data shapes
```js
// token (word)
{ hz:'中国', py:'zhōngguó', en:'China', pos:'noun', word:true }
// token (punctuation)
{ hz:'。', word:false }

// passage = [ { trans:'<full paragraph translation>', sentences:[ [token,…], … ] }, … ]
```

---

## speak-spotlight.html

Pronunciation practice ("Spotlight" direction). The big mic is the hero: tap to
record, it fills with colour, then becomes a score ring. Per-word colouring,
positive burst on a good result, a **Finish** screen with overall score + a
tappable per-sentence recap that **updates the score when you re-practise**.

### Integration points
1. **Recording** (`onMicTap` / `onListen`) — your Azure speech SDK + `MediaRecorder`
   (and Google TTS for *Listen*). Replace the fake 2.3s timer.
2. **Scoring** (`applyScore(result)`) — feed Azure's JSON straight in. Expected:
   ```js
   { score, accuracy, fluency, completeness,
     words:[ { text:'中', status:'good' | 'ok' | 'bad' }, … ] }
   ```
   Azure already returns per-word accuracy — bucket it into `good/ok/bad` at
   your thresholds (the mockup uses 85 / 70).
- Delete-on-integration: the dev jump-bar and `fakeScore()` / `fakeScore`-style synths.

---

## Notes for both
- **Theme tokens** are declared in `:root` and mirror your existing reader/speak
  palettes (`--primary #E5267E`, `--cyan`, `--yellow`, `--good` …). Map them onto
  your real variables rather than hard-coding colours.
- **Sprite ids** are prefixed `#i-…` (reader) and `#sonic-i-…` (speak) — rename to
  match your actual sprite symbol ids.
- **Tab bar** markup is included to complete the mockup; you already have one —
  reuse yours and drop the `renderTabbar()` helper.
- All interactive state lives in a single `S` object per file — easy to lift into
  your `app.js` module pattern.
