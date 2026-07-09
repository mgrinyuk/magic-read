# Magic Read — Phase 1 Implementation Handoff (Sonic reskin + copy)

For the developer/agent doing the reskin in VS Code. Scope = **reskin existing screens + apply final copy + a few structural changes.** Video is **Phase 2** (not in this pass).

**Reference files already in the repo root:**
- Design mockups: `*-sonic.html` (onboarding, home-dashboard, reader, speaking-paywall, video, flashcards, loose-ends, hero)
- Copy source of truth: `magic-read-ui-copy.md` (+ the user's docx revisions, summarized in §8 below)
- These are the visual + copy target. Match layout, spacing, components, and colors.

**Golden rules**
- Preserve all existing functionality (Supabase auth, Stripe, Azure scoring, TTS, translate, PDF export). This is a reskin, not a rewrite.
- Work **screen by screen**, show a git diff after each, don't batch everything blindly.
- Don't touch backend billing/auth logic except the explicit config changes in §6–§7.
- Mobile-first: content column **max 700px, centered on desktop, full-bleed below 720px.**

---

## 1. Order of work
1. **Design tokens** in `frontend/style.css` (§2) — do this first; it reskins everything at once.
2. **Global shell + bottom tab bar + logo** (§3).
3. Screens in this order: Onboarding → Home (new) → Reader → Speaking → Flashcards → Account → Calligraphy → Landing (§4).
4. **Config + copy** (§6, §8).
5. **Backend bits** (§7) — can run in parallel with a backend dev.
6. **QA pass** (§9).

---

## 2. Design tokens — `frontend/style.css`
Replace the `:root` palette. Map old → new (keep variable names where they're used; add the new ones):

```css
:root{
  --bg:#E5E7EE;            /* page behind the app shell */
  --shell:#F4F5F9;         /* app background */
  --surface:#FFFFFF;
  --surface-2:#F1F2F8;     /* was --surface-soft */
  --primary:#E5267E;       /* was --brand  (magenta) */
  --primary-soft:#FF4D9D;
  --cyan:#0AB4D6;          /* was --blue */
  --cyan-ink:#0E7490;      /* cyan text on light */
  --yellow:#F5B400;        /* was --yellow (#f1ff5e) — muted for legibility */
  --amber-ink:#B98300;
  --text:#1C1233;          /* was --text */
  --text-soft:#6A6480;
  --text-dim:#9A93AD;
  --border:#E5E3EE;        /* was --border */
  --good:#16A34A; --close:#D97706; --retry:#E11D48;   /* word scoring */
}
```
- Retire `--brand-dark`, `--brand` (indigo) — search & replace usages with `--primary`/`--text`.
- Fonts: Inter (UI) + Noto Sans SC (Chinese). Add the Google Fonts `<link>` to `index.html` head.
- Per-word scoring colors are `--good` / `--close` / `--retry` everywhere (reading highlights, speaking, video captions).

---

## 3. Global shell, tab bar, logo
- Wrap the app in a `max-width:700px; margin:0 auto` shell; full-bleed under 720px (see any `*-sonic.html` `.app`).
- **Bottom tab bar** (new): Home · Read · Speak · Cards · Video. Sticky bottom, safe-area padding. (Profile moves into the tab-less header/menu.) Tab markup + icons in the mockups (Tabler-style inline SVG sprite).
- **Logo**: keep the spark/diamond mark, recolor **magenta on white** (`--primary` bg, white spark). Wordmark "Magic Read" + italic `lite` in `--cyan-ink`.

---

## 4. Screen-by-screen

### Onboarding — `#screen-onboarding`
- **Remove the skill/level step** (`#onboarding-step-b`) entirely. Flow is now: languages → trial start.
- Keep `#onboardingTargetLang` / `#onboardingSourceLang`. Headline "Choose languages".
- Add a **trial-start screen** after languages: "Your 7-day Pro trial starts now" + 3 includes + "Start learning" (mockup: `onboarding-flow-sonic.html`).
- Sign-in: add Google + Apple buttons (see §7 auth).

### Home dashboard — NEW
- Doesn't exist today (app opens into the reader). Build a new home screen as the post-onboarding landing + Home tab.
- Contents (mockup `home-dashboard-sonic.html`): greeting + trial/free badge; **streak card**; **3 stat tiles** (words read / spoken / practiced); "Continue" resume card; "What do you want to do?" action grid (Speak featured, then Read/Cards/Videos/Write); Cards "{n} due" badge.
- Stats + streak need backend counters (§7).

### Reader — `#screen-main`
- Reskin `#readerStart`, `#textLibraryPanel`, `#fullTextPanel`, `#cardsSection`, `#readingExercise` to Sonic (mockup `reader-screen-sonic.html`).
- **Word popover** (on word click): show **pinyin · translation · save** together — the save lives in the popover, not a separate control.
- Toolbar: Listen · Slow (🐢 emoji) · Pinyin · Translate · **Saved texts** (new entry to library).
- **Remove grammar notes** (delete the grammar UI; `backend/data/grammar/*` can stay unused).
- **Add a new exercise type — word ordering**: scrambled word tiles → user taps into correct order; Check / Skip. Add alongside existing `#readingExercise` types.
- Persist reading position per text (§7 progress).

### Speaking
- Reskin to `speaking-paywall-sonic.html`. Reuse per-word data from `frontend/azure-pronunciation.js`.
- **Usage meter (lite only)**: "Today's checks · {n}/20 left", always visible.
- **Tone feedback** block under the score — standardized strings (§8): Sounds clean! / Check the tone! / Check the sound! / Work on fluency!
- Repeat-this-word card targets the lowest-scoring word.

### Flashcards — `#screen-flashcards`
- Reskin to `flashcards-screen-sonic.html`. Keep decks, `#flashcardDeckSelect`, new deck, import, **Export PDF**, speaking practice (`#flashcardSpeakEasyBtn`/`HardBtn`).
- **Add SRS**: Again / Good / Easy with intervals (needs scheduling fields, §7). Replace manual-only navigation with due-based review.
- **Remove the example sentence** (`#flashcardSentence`, `#flashcardSentencePinyin`).
- **Clean translation strings**: strip stray symbols/markup from `#flashcardTranslation`.
- Review prompt: "How well do you know it?"
- Saved words stay **manual** into decks (no auto-flow).

### Account / profile menu — `#profileMenuBtn` dropdown → full Account screen
- Reskin to the Account view in `loose-ends-sonic.html`.
- Add **Manage subscription** (Stripe billing portal) and **App language** switch.
- Keep: Upgrade row, Personal data, Saved words, About, Help & support, Log out.

### Calligraphy — `#screen-writing`
- Reskin only. Keep the calligraphy worksheet flow (`#createWritingSheetBtn`, `#writingResult`). Tab/tile label stays **"Write"**.

### Landing / marketing — `#how-it-works` + hero
- Reskin to `hero-sonic.html` (light). Headline: **"Laser-focus on your pronunciation."**

### Video — PHASE 2
- Don't build now. Tab can route to a "Coming soon" or be hidden until Phase 2.

---

## 5. Empty / error / loading states
- Use the copy in `magic-read-ui-copy.md` §9. Reskin existing alerts to inline toasts/cards in Sonic.
- Post-trial Home shows the **usage-meter card** + locked Video tile (mockup `loose-ends-sonic.html`).

---

## 6. Config changes (frontend `app.js`)
- `userPlan.limits` → `{ textPerDay: 3, pronunciationPerDay: 20, savedTexts: 5, decks: 2, cards: 100 }` (pronunciation **10 → 20**).
- Trial: 7 days, full Pro access, with a visible trial badge; on expiry drop to the limits above.
- `UPGRADE_MESSAGES`: update copy to `magic-read-ui-copy.md` §7 (per-limit titles + subheads, "all 20", etc.). Convert to the **modal popup** at hard limits while keeping the inline counter visible (persistent usage meter on lite).
- Flip `const AZURE_PRONUNCIATION = true;` once backend quota = 20 is set.

---

## 7. Backend / data (not just CSS)
- **`FREE_DAILY_PRONUNCIATION_LIMIT=20`** in `backend/.env` and on Render (currently 20 in doc but frontend was 10 — make both 20).
- **Stats + streak**: add counters for words read / spoken / practiced and a daily streak (new Supabase columns/table + increment hooks). None exist today.
- **SRS scheduling**: add per-card fields (ease, interval, due date) + a review-update endpoint. Today flashcards are deck-only.
- **Per-activity progress**: persist last position for reading/speaking/video so "Continue" works across the app.
- **Auth**: add Google + Apple providers in Supabase + buttons in the auth screen.
- (Optional) **Lifetime offer window**: only show Lifetime $89 for 1 week post-trial + holiday promos.

---

## 8. Copy & tone
- Source: `magic-read-ui-copy.md` with the user's revisions applied:
  - Onboarding headline "Choose languages"; **no level step**.
  - Tone feedback (standardized): **Sounds clean! / Check the tone! / Check the sound! / Work on fluency!**
  - Flashcard prompt "How well do you know it?"
  - Reader: word actions inside the popover; "Saved texts" in toolbar.
  - Free pronunciation limit = **20/day**.
  - Landing headline "Laser-focus on your pronunciation."
- Localize UI into **all 8 languages** (`frontend/ui-text.js` currently has en/ru/zh/tr/de — add ja/es/fr).
- Voice: clean & neutral everywhere except the upbeat tone-feedback lines.

---

## 9. QA checklist
- [ ] Renders centered ≤700px on desktop, full-bleed on a phone viewport.
- [ ] Light grey background; magenta/cyan accents; scoring colors legible.
- [ ] Existing flows still work: paste→read, listen (TTS), tap-to-define+save, speaking score, flashcard review + PDF export, calligraphy sheet, Stripe upgrade, login/logout.
- [ ] Free limits enforce at 20/3/2/100; usage meter shows on lite; popup at limit is dismissible.
- [ ] Onboarding has no level step; trial badge shows; expires to free correctly.
- [ ] No grammar UI; word-reorder exercise works; flashcards have SRS + no example sentence.
- [ ] All copy matches §8; 8 UI languages load.

---

## Out of scope for Phase 1
Video feature (Phase 2), push/email notifications, leaderboards/gamification beyond streak.
