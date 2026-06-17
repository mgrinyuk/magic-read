# Magic Read — UI Copy

Source strings for every screen, in a clean &amp; neutral voice. **Edit any line directly** — strike, rewrite, or leave comments.
`{…}` = a value the app fills in (e.g. `{n}`, `{days}`, `{lang}`). Buttons are written in **Sentence case**.

---

## 0. Brand & global

- App name: **Magic Read**
- Free badge: **lite** · Paid badge: **Pro**
- One-line descriptor: Pronunciation practice on the texts you actually want to read.
- Tab bar labels: Home · Read · Speak · Cards · Video

---

## 1. Onboarding

### Sign-in
- Headline: **Speak the texts that matter to you**
- Subhead: Listen, repeat, and get word-by-word pronunciation scores on anything you paste.
- Demo caption: tap a word to hear it scored
- Buttons: Continue with Google · Continue with Apple · Sign up with email
- Divider: or
- Footer: Already have an account? **Log in**

### Languages (step 1 of 2)
- Headline: **Which languages?**
- Subhead: You can change these later in settings.
- Fields: I speak · I'm learning

### Level (step 2 of 2)
- Headline: **What's your level in Chinese?** *(uses the chosen language)*
- Subhead: We'll tune text difficulty to match.
- Options:
  - A1 — Beginner — Just starting out
  - A2 — Elementary — Know the basics
  - B1 — Intermediate — Can hold a conversation
  - Not sure — Take a 2-minute placement
- Button: Continue

### Trial start
- Headline: **Your 7-day Pro trial starts now**
- Subhead: Full access for 7 days — no charge until it ends.
- Included: Unlimited pronunciation checks · Videos with smart captions · All flashcard decks &amp; calligraphy export
- Button: Start learning

---

## 2. Home / dashboard

- Greeting: **Hello, {name}**
- Trial badge: Pro trial · {days} days left
- Free badge: Free plan
- Streak title: {n}-day streak
- Streak subtitle: Practice today to keep it going
- Stats labels: Words read · Words spoken · Words practiced
- Resume card label: Continue reading
- Section heading: **What do you want to do?**
- Action tiles: Speak · Read · Cards · Videos · Write
- Speak tile description (featured): Score your pronunciation on any text
- Cards tile badge: {n} due

### Usage meter (free, post-trial)
- Title: Today's free limits
- Rows: Pronunciation · New texts
- Remaining: {n} left
- Button: Upgrade

---

## 3. Reading

- Title: **Reading**
- Toolbar: Listen · Slow · Pinyin · Translate
- Level badge: {level}
- Word popover: part-of-speech line e.g. "noun · place"
- Save button: (saves word to a deck) — tooltip: Save word
- Progress: Sentence {n} / {total}
- Primary button: Practice speaking this
- Save text (header bookmark): Save text

### Exercise — word ordering
- Tag: Exercise
- Heading: **Put the words in order**
- Prompt: Build the sentence that means: **"{translation}"**
- Buttons: Check · Skip
- Correct feedback: Correct — nicely done.
- Incorrect feedback: Not quite. Tap a tile to move it back and try again.

---

## 4. Speaking

- Title: **Speaking**
- Subtitle: Sentence {n} of {total}
- Toolbar: Slow · Pinyin · Translate
- Usage meter (lite): label "Today's checks" · "{n}/{total} left"
- Overall score label: (number only, e.g. 75)
- Tone feedback heading: Tone feedback
- Per-word notes (examples — keep short, factual):
  - tones clean
  - tone 2 landed flat
  - {syllable} (tone {n}) too low
  - a little rushed
- Repeat card label: Repeat this word
- Repeat tip: {pinyin} · keep tone {n} high and level
- Controls: Listen · (mic, no label) · Skip
- Encouragement after a good score: Clear — that one's solid.
- Prompt to record: Tap the mic and say it aloud.

---

## 5. Video

- Title: **Video**
- URL bar placeholder: Paste a YouTube link
- Button: Load
- Free badge: {n} free video left *(trial)*
- Transport: −5s · Play / Pause · Slow
- Caption line actions: Listen · Speak this line
- Tap-to-save hint: tap any word to save it
- Translation: shown under each line (no label)

### No captions found (empty state)
- Heading: **No captions found**
- Body: This video doesn't have a transcript we can read. Try another link, or let us generate captions automatically.
- Buttons: Try another video · Auto-generate captions **(Pro)**

---

## 6. Flashcards

- Title: **Flashcards**
- Counter: {n} / {total}
- Deck row: deck name + "{n} cards"
- Deck actions: New deck · Export PDF · Import words · Delete deck
- Card audio: Play · Slow
- Speaking button: Say it
- Review prompt: How well did you know it?
- Review buttons (with intervals): Again ({<1 min}) · Good ({2 days}) · Easy ({6 days})
- Empty deck state heading: No cards yet
- Empty deck state body: Save words while reading or watching, then review them here.

---

## 7. Upgrade & paywall

### Usage nudge (inline, before limit)
- {n} free {checks/texts} left today.

### Upgrade popup (reused for each limit — swap the first two lines)
- Pronunciation limit — Title: **You're out of today's free checks**
  - Subhead: You've used all {n} pronunciation checks for today. Go Pro for unlimited practice — no daily cap.
- Texts limit — Title: **That's your free texts for today**
  - Subhead: You've added {n} texts today. Go Pro to add as many as you like.
- Video limit — Title: **Videos are a Pro feature**
  - Subhead: You've used your {n} trial videos. Go Pro to keep learning from any video.
- Deck/card limit — Title: **You've reached the free limit**
  - Subhead: Free decks are capped at {n}. Go Pro for unlimited decks and cards.

- Unlocks list: Unlimited pronunciation checks · Videos with smart captions · Calligraphy worksheet export
- Plans: Annual — $49/yr — **Save 41%** · Monthly — $6.99/mo
- Lifetime line (only in offer window): ★ Lifetime $89 — available this week only
- Primary button: Upgrade to Pro
- Dismiss: Maybe later
- Reassurance: Your free checks reset tomorrow.

---

## 8. Account

- Title: **Account**
- Plan badge: Pro trial · {days} days left  /  Free plan  /  Pro
- Upgrade row: **Upgrade to Pro** — Keep unlimited access after your trial
- Menu: Manage subscription · Personal data · Saved words ({n}) · App language ({lang}) · About · Help & support
- Log out

---

## 9. System & error messages (from current app — revise tone)

- No speech detected: I didn't hear anything. Tap and speak again.
- Mic blocked: Microphone access is off. Allow it in settings and try again.
- Recording stopped: Recording stopped. Tap to try again.
- Service busy: The pronunciation service is busy. Please try again in a moment.
- Generic scoring error: Something went wrong scoring your speech. Please try again.
- Offline: You're offline. Reconnect to keep practicing.
- Saved confirmation: Saved to {deck}.
- Text too long (free): That text is over the free length limit. Go Pro for longer texts.

---

## 10. Landing page (marketing)

- Eyebrow: Pronunciation scoring powered by Azure AI
- Headline: **Hear every word you get wrong.**
- Subhead: Paste any foreign text, listen sentence by sentence, then speak it aloud. Get instant word-by-word pronunciation scores on the texts you actually want to read.
- Primary CTA: Start speaking — it's free
- Secondary CTA: Hear a demo
- Languages line: 8 languages: 中文 · Русский · 日本語 · English · +4
- Nav: How it works · Languages · For teachers · Pricing · Sign in

---

*Tell me which sections to rework and I'll fold revisions back into the screens. Open questions worth deciding while you revise: (1) what we call "Write" in the tab/tile vs. its calligraphy purpose; (2) exact tone-feedback phrasings you want standardized; (3) whether the trial video count is 3 (used here) or 1.*
