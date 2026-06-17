# Magic Read — Discovery & Flow Questions (v2, grounded in the current codebase)

Rewritten after reading the actual app. **Part A** = things already built/decided — just confirm or correct (fast).
**Part B** = real open decisions that block design. **Part C** = nice-to-have direction.
Answer inline under each `→`.

---

# PART A — Confirm or correct (already in the code)

## A1. Tiers & limits
The frontend currently encodes free limits as:
`3 texts/day · 10 pronunciation checks/day · 5 saved texts · 2 decks · 100 cards`.
The Azure setup doc instead says `FREE_DAILY_PRONUNCIATION_LIMIT = 20/day`.

**A1.1 ◆** Which numbers are correct/current? (10 or 20 pronunciation checks? confirm the rest)
→

**A1.2** Three account states exist: **Guest** (browser fallback scoring, no Azure), **Free signed-in** (daily quotas), **Pro** (unlimited). Keep all three?
→

**A1.3** There's a **trial** badge + "After that: X/day" copy in the code. Confirm: free users start on a trial, then drop to the limits above? How long is the trial, and what does it include?
→

## A2. Pricing & billing
Stripe is live: **Monthly $6.99 · Annual $49 (save ~41%) · Lifetime $89**, flipping `profiles.plan` to `pro`.

**A2.1** Keep these three price points, or revisit?
→

**A2.2** Lifetime never downgrades; subs downgrade on cancel. Keep lifetime as an option?
→

## A3. What Pro unlocks (today)
Right now Pro effectively = unlimited texts + pronunciation + more decks/cards/saved texts.

**A3.1 ◆** Is "unlimited" the *whole* Pro pitch, or do you want Pro to also unlock **exclusive features** (videos, premium library, tone feedback, calligraphy, export)? This decides how strong the paywall feels.
→

## A4. Auth & account
Currently **email + password** (with password reset) via Supabase. Guest mode supported.

**A4.1** Add social login (Google / Apple)? (matters for mobile app store conversion)
→

**A4.2** Profile menu today: upgrade, plan badge, password reset, log out. Anything missing you want? (settings, UI-language switch, help)
→

## A5. Languages
Learning targets (8): **zh, ru, ja, en, de, es, fr, tr**. UI is localized into **5**: en, ru, zh, tr, de.

**A5.1** Confirm both lists. Any launch priority order among targets?
→

**A5.2** Pronunciation scoring is strongest for `zh-CN` (per-word/phoneme); prosody is **English-only**. Which target languages get AI scoring **at launch** — all 8 or a subset?
→

## A6. Existing screens
Built screens: Onboarding (language + skill level) · Reader · Flashcards · Calligraphy(Writing) · Auth · Marketing.

**A6.1 ◆** Is my job to **re-skin these existing screens** into the Sonic design, or design net-new screens you'll rebuild? (changes how I hand off)
→

**A6.2** "Write" is actually **Calligraphy worksheets (zh/ru only)**. Keep it labeled "Write", rename to "Calligraphy", or fold it elsewhere?
→

**A6.3** Reading already has **exercises** and **grammar** notes. Keep both prominent in the redesign?
→

---

# PART B — Open decisions (these block design work)

## B1. Home / dashboard (NEW — not built yet)
My redesign added a Home dashboard (Spoken/Read/Saved stats, streak, action grid). The current app opens straight into the reader with a "← Home" button.

**B1.1 ◆** Do you want a real **Home dashboard** screen, or keep reader-as-home?
→

**B1.2** If yes: which stats matter? (the code has no streak/stats yet — building from scratch). Streak? Daily goal? Words learned?
→

**B1.3** The action grid in the mockup is Speak / Read / Videos / Write / Cards. Correct set and order? (Speak featured?)
→

## B2. Paywall UX
Contextual **inline** upgrade prompts already exist (e.g. "You've used your 10 free pronunciation checks today. Upgrade to Pro →").

**B2.1 ◆** Keep these as **inline prompts**, or upgrade to the **modal popups** from my mockup? Or both (inline for soft nudges, modal at hard limits)?
→

**B2.2** Which limits should trigger an upgrade nudge? (pronunciation/day, texts/day, deck #3, card #101, saved text #6, + any new ones like video)
→

**B2.3** Tone — soft/dismissible everywhere, or hard-block once a daily limit is truly exhausted?
→

**B2.4** Want a persistent upgrade surface (Home banner / usage meter), or only contextual?
→

## B3. Video feature (NEW — not built)
**B3.1 ◆** Source — curated in-app library / user-pasted YouTube link / both?
→

**B3.2** Captions = tappable pinyin + translation (reuse the reader). Plus "speak this line" scoring? Save words from captions?
→

**B3.3** Free, or Pro-only? (strong candidate for a Pro hook per A3.1)
→

**B3.4** Playback needs: slow, loop-a-line, toggle captions?
→

## B4. Flashcards model
Today: deck-based, manual navigation, speaking practice, PDF export. **No spaced repetition.**

**B4.1 ◆** Add **SRS** (Again/Good/Easy scheduling like my mockup), or keep the simpler deck model?
→

**B4.2** Cards already hold word + pinyin + translation + example + audio + speaking practice. Keep all? Anything to cut/add?
→

**B4.3** Should saved words from reading/video auto-flow into a default deck, or always manual?
→

## B5. Naming & branding
**B5.1 ◆** App name is still TBD ("Magic Read" undersells pronunciation). Candidates? Any constraint (keep/drop "Read", domain owned, etc.)?
→

**B5.2** Free badge = `lite`, paid badge = `Pro ✨` (already in code). Keep this naming?
→

**B5.3** Confirm the **Sonic** palette (magenta + cyan, light-grey bg) is locked for build.
→

**B5.4** Keep the spark/diamond logo mark, or open to a new one?
→

---

# PART C — Direction & priorities (answer if you have a view)

**C1** Tone of voice for UI copy — encouraging coach / clean & neutral / playful? (drives the copy pass)
→

**C2** Tone-specific feedback ("这 zhè — tone was off") is *possible* from existing Azure data but not surfaced. Priority for launch?
→

**C3** Retention: notifications (streak/words-due/weekly recap)? Or out of scope for now?
→

**C4** Single most important metric right now — activation / retention / Pro conversion?
→

**C5** If only **one** screen ships perfectly, which? (likely Speaking)
→

**C6** Anything explicitly **out of scope** for v1, so I don't design it?
→

---

*Fastest path: answer the **◆** items (≈9) and I can start on the flow update, paywall, video screen, and the re-skin. The rest refine it.*
