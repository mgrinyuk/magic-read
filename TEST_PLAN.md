# Magic Read — Final Test Plan

Work through the sections in order (earlier ones set up data for later ones).
Check off items as you go. When something fails, write a bug report using the
template at the bottom and keep testing — don't stop at the first failure.

Test on at least: **desktop Chrome** and **iPhone Safari** (most divergent).
If time allows: desktop Safari, Android Chrome.

---

## 1. Logged-out experience

- [ ] Landing page loads with hero, "How it works", footer (Blog / Privacy / Terms / Cookies / Refunds / Imprint links all open)
- [ ] UI language switcher in header changes landing copy (spot-check Русский and 中文)
- [ ] "Start speaking — it's free" / "Start reading" CTAs lead to signup, not into the app
- [ ] Directly opening an app URL while logged out shows the landing page, never app screens
- [ ] Blog pages open and render

## 2. Auth & onboarding

- [ ] Sign up with a fresh email → onboarding screen appears
- [ ] Onboarding: pick "I speak" / "I learn" languages → lands on dashboard
- [ ] Log out → landing page returns (no app UI leaks)
- [ ] Log back in → dashboard resumes with your languages remembered
- [ ] Wrong password shows a readable error (in the selected UI language)

## 3. Home dashboard

- [ ] Greeting, streak, and action buttons render without layout breakage
- [ ] Language controls ("I speak / I learn") change languages and persist after reload
- [ ] Header language picker behavior on dashboard (⚠️ known issue: currently hidden for signed-in users — verify what you actually want here)
- [ ] Each action button opens the right screen (Read, Speak, Flashcards, Video, Writing)
- [ ] Completing any activity updates streak/stats after returning to dashboard

## 4. Reader

**Setup**
- [ ] Paste tab: paste a real text (try Chinese AND one non-Chinese language) → Start reading works
- [ ] Library tab: pick a library text → opens in reader
- [ ] Saved tab: empty state first, then shows texts after you bookmark one
- [ ] Free quota: "X of N texts today" counter shows and blocks past the limit with an upgrade prompt (not an error)

**Reading**
- [ ] Text renders as flowing paragraphs; tap any word → popup with pinyin, meaning, part of speech
- [ ] Pinyin toggle: ruby pinyin appears above words, and disappears cleanly when off
- [ ] Translate toggle: paragraph translation appears/disappears
- [ ] Play: audio plays sentence by sentence, active sentence highlights and advances in sync
- [ ] Pause / resume works mid-sentence; sentence counter is correct
- [ ] 🐢 Slow toggle audibly slows playback
- [ ] Voice picker: switching voice changes the audio voice
- [ ] "Save to cards" on a word → confirm it appears later in Flashcards
- [ ] Bookmark (top-right) saves the text → appears in Saved tab

**Exercises**
- [ ] Exercise menu appears after reading; count of exercises scales with text length (max 5)
- [ ] Word-order exercise: correct answer accepted, wrong answer shakes, can retry
- [ ] Cloze (missing word): options come from the actual text; correct/wrong handled
- [ ] Finishing all exercises → celebration screen → activity recorded on dashboard

## 5. Speak (pronunciation)

- [ ] Setup: paste text or arrive from reader → practice screen
- [ ] Listen button plays TTS of the current sentence
- [ ] Mic permission prompt appears once; denying it shows a helpful message, not a crash
- [ ] Record → per-word colors (green/amber/red) + overall score ring appear
- [ ] Scores look sane (garbled speech scores low, good speech scores high)
- [ ] Next/previous sentence navigation works
- [ ] Finish screen: overall score + per-sentence recap; re-practicing a sentence updates its score
- [ ] Free daily pronunciation limit: hitting it shows upgrade prompt, not an error
- [ ] **Safari specifically**: flashcard/speak recognition responds fast (recent fix — verify)

## 6. Flashcards (SRS)

- [ ] Words saved from reader appear in the deck
- [ ] Review session: flip card, grade it, next card appears; session ends cleanly
- [ ] Spaced repetition: reviewed cards don't immediately reappear
- [ ] Speaking a card (voice answer) works, including on Safari
- [ ] Deck export works (`/api/export-flashcard-deck`) — file downloads and opens
- [ ] Free limits: max decks / max cards enforced with upgrade prompt

## 7. Video

- [ ] Paste a YouTube URL → video plays in the hosted player
- [ ] Captions load and are synced; tapping a caption word gives lookup (if supported)
- [ ] Bad URL / video without captions → readable error, not a spinner forever
- [ ] Free video quota enforced with upgrade prompt
- [ ] Watched video appears in history (if enabled)

## 8. Writing

- [ ] Create a writing worksheet from a text → PDF generates and downloads
- [ ] PDF opens and characters render correctly (fonts embedded, no boxes/□)

## 9. Payments & plans — ⚠️ use Stripe TEST mode or be ready to refund yourself

- [ ] Free plan state shows correctly in profile/account (trial badge, limits)
- [ ] Upgrade picker shows Stripe plans AND T-Bank month/year options
- [ ] Stripe checkout completes (test card `4242 4242 4242 4242`) → plan flips to Pro, quotas lift
- [ ] Billing portal opens; cancel → plan shows as canceling; resume works
- [ ] T-Bank payment page opens with correct RUB price (stored in kopecks — verify displayed amount!)
- [ ] Lifetime offer: only appears with the feature flag on, after trial, inside the window (skip if flag is off)
- [ ] After upgrade, "X of N today" counters and upgrade prompts disappear

## 10. Account & cross-cutting

- [ ] Account screen: email, plan, language settings all correct; changes persist
- [ ] Switch UI language while logged in → all app screens localized (spot-check RU + 中文; look for untranslated strings or overflowing buttons)
- [ ] Mobile layout: tab bar reachable, no horizontal scroll, safe-area at the bottom on iPhone
- [ ] Refresh in the middle of each main screen → you return somewhere sensible, not a blank page
- [ ] Two tabs open at once don't corrupt state (e.g., streak counted once)
- [ ] Check browser console on each major screen — report any red errors even if the UI looks fine

---

# How to report bugs (template)

One bug per report. Copy this block:

```
BUG #<number>: <one-line summary>

Where: <URL + screen, e.g. "magicread.app, Reader, exercise menu">
Account: <email you were logged in with, plan (free/trial/pro), UI language, learning pair (e.g. EN→ZH)>
Device: <e.g. iPhone 15 Safari / MacBook Chrome>

Steps:
1. <exact steps, including the exact text you pasted if relevant>
2. ...

Expected: <what should have happened>
Actual: <what happened — quote exact error text if any>

When: <date + approx. time with timezone — lets me match server logs>
Extras: <screenshot, console errors (F12 → Console), failing request from Network tab>
```

What matters most, in order: **exact steps to reproduce**, the **pasted text/URL** that triggered it, and **exact error wording**. A screenshot is worth a lot; a console screenshot is worth more. If it's intermittent, say how many times out of how many tries.

Severity tags (optional but helpful): `[blocker]` can't proceed / data loss / payment wrong · `[bug]` feature misbehaves · `[polish]` visual/text issue.
