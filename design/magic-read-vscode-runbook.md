# Magic Read — VS Code reskin runbook (step by step)

Paste these prompts into the Claude extension **one at a time, in order**. After each one: run the app, check the screen, review the git diff, and commit before pasting the next. This keeps every change small and reversible.

> The single all-in-one version is in `magic-read-vscode-kickoff-prompt.md`. Use **this** file if you'd rather go one controlled step at a time (recommended).

---

## Before you start
1. Open the repo folder in VS Code.
2. Confirm these reference files are in the repo root: `magic-read-phase1-handoff.md`, `magic-read-ui-copy.md`, and the `*-sonic.html` mockups.
3. In the VS Code terminal, make a branch:
   ```
   git checkout -b sonic-reskin
   ```

---

## STEP 1 — Prime the assistant (paste first, once)

```
You're going to reskin this app (Magic Read) into a new "Sonic" design and apply final copy. It's a RESKIN, not a rewrite — preserve all existing functionality (Supabase auth, Stripe, Azure scoring, Google TTS, translation, PDF export).

First, read these files in the repo root and treat them as the source of truth:
- magic-read-phase1-handoff.md  (the full spec — follow it)
- magic-read-ui-copy.md          (final UI copy)
- the *-sonic.html files          (the exact visual target)

Rules for the whole job:
- Mobile-first: content max 700px centered on desktop, full-bleed under 720px.
- Work one screen at a time. After each change, stop and show me the git diff. Don't move on until I say so.
- Don't touch backend billing/auth logic. Backend items are listed in handoff §7 — flag them but don't build them unless I ask.
- Ask before adding any dependency or build step.

Confirm you've read the three sources and summarize the work order from the handoff. Then WAIT — don't change anything yet.
```

✅ After: it should list the plan. If it looks right, continue.

---

## STEP 2 — Design tokens

```
Do handoff §2 only: in frontend/style.css, replace the :root palette with the Sonic tokens, add the Inter + Noto Sans SC font links to index.html, and search/replace the retired indigo variables (--brand, --brand-dark). Show me the diff. Don't change any layout yet.
```
✅ Run the app — colors should shift to magenta/cyan on light grey. Commit:
```
git add -A && git commit -m "reskin: Sonic design tokens"
```

---

## STEP 3 — Global shell + tab bar + logo

```
Do handoff §3: wrap the app in a 700px centered shell (full-bleed under 720px), add the bottom tab bar (Home/Read/Speak/Cards/Video) from the mockups, and recolor the logo to magenta-on-white. Show me the diff.
```
✅ Check shell centers on desktop, fills a phone viewport. Commit: `reskin: app shell + tab bar`.

---

## STEP 4 — Onboarding

```
Reskin #screen-onboarding per handoff §4 and onboarding-flow-sonic.html: REMOVE the skill/level step (#onboarding-step-b) entirely, keep the language step with headline "Choose languages", and add the 7-day trial-start screen after it. Keep the existing Supabase auth working; add Google + Apple buttons to the UI (leave the provider wiring as a TODO). Show me the diff.
```
✅ Commit: `reskin: onboarding (level step removed + trial start)`.

---

## STEP 5 — Home dashboard (NEW screen)

```
Build the new Home dashboard from home-dashboard-sonic.html (handoff §4). Greeting + trial/free badge, streak card, 3 stat tiles (words read/spoken/practiced), a "Continue" resume card, and the action grid with Speak featured. Use placeholder numbers for stats and streak for now — I'll wire the backend counters later. Make Home the landing screen after onboarding and the Home tab target. Show me the diff.
```
✅ Commit: `feat: home dashboard (placeholder stats)`.

---

## STEP 6 — Reader

```
Reskin #screen-main per reader-screen-sonic.html (handoff §4): word click popover shows pinyin · translation · save together (save lives in the popover); add "Saved texts" to the toolbar; REMOVE the grammar notes UI; add a new word-ordering exercise (scrambled tiles → correct order, Check/Skip) alongside the existing exercises. Keep listen/TTS, tap-to-define, and save-word working. Show me the diff.
```
✅ Commit: `reskin: reader (popover save, saved texts, word-order exercise, grammar removed)`.

---

## STEP 7 — Speaking

```
Reskin the speaking screen per speaking-paywall-sonic.html. Add the lite usage meter "{n}/20 left" (always visible on free), and a tone-feedback block under the score using exactly: "Sounds clean!", "Check the tone!", "Check the sound!", "Work on fluency!". Reuse the per-word data from frontend/azure-pronunciation.js. Don't change scoring logic. Show me the diff.
```
✅ Commit: `reskin: speaking (usage meter + tone feedback)`.

---

## STEP 8 — Flashcards

```
Reskin #screen-flashcards per flashcards-screen-sonic.html: keep decks, deck select, new deck, import, Export PDF, and speaking practice. Add SRS review buttons Again/Good/Easy (UI + a scheduling stub — flag the backend fields as TODO per handoff §7). REMOVE the example sentence (#flashcardSentence / #flashcardSentencePinyin). Clean stray symbols from #flashcardTranslation. Change the prompt to "How well do you know it?". Show me the diff.
```
✅ Commit: `reskin: flashcards (SRS, example removed, cleaned translation)`.

---

## STEP 9 — Account menu

```
Reskin the profile/account menu (#profileMenuBtn) to the Account view in loose-ends-sonic.html. Add "Manage subscription" (link to the Stripe billing portal — stub the URL) and "App language". Keep Upgrade, Personal data, Saved words, About, Help & support, Log out. Show me the diff.
```
✅ Commit: `reskin: account menu (manage subscription + app language)`.

---

## STEP 10 — Calligraphy + Landing

```
Reskin #screen-writing (calligraphy) — visual only, keep the worksheet flow and the "Write" label. Then reskin the landing/hero and #how-it-works per hero-sonic.html, with the headline "Laser-focus on your pronunciation." Show me the diff.
```
✅ Commit: `reskin: calligraphy + landing`.

---

## STEP 11 — Limits & paywall copy

```
In frontend/app.js: set userPlan.limits.pronunciationPerDay = 20 (was 10). Update UPGRADE_MESSAGES to the copy in magic-read-ui-copy.md §7 (per-limit titles/subheads, "all 20", etc.) and present them as a dismissible modal at hard limits while keeping the inline usage meter visible on lite. Do NOT set AZURE_PRONUNCIATION = true yet. Show me the diff.
```
✅ Commit: `feat: free limit 20 + paywall copy/modal`.

---

## STEP 12 — Final QA

```
Go through the QA checklist in handoff §9 against the current state. List anything not matching the mockups or copy, and propose fixes (don't apply them yet).
```
✅ Review the list, then approve fixes screen by screen. Merge when happy:
```
git checkout main && git merge sonic-reskin
```

---

## Backend items (separate pass — when you're ready)
These need a developer or a focused backend prompt; they're not part of the visual reskin:
- Stats + streak counters (words read/spoken/practiced) — Supabase columns + increment hooks.
- SRS scheduling fields (ease, interval, due date) + review-update endpoint.
- Per-activity progress saving (so "Continue" works).
- Google + Apple auth providers in Supabase.
- `FREE_DAILY_PRONUNCIATION_LIMIT=20` in backend/.env + Render, then flip `AZURE_PRONUNCIATION = true`.

Prompt to start that pass:
```
Now the backend items in magic-read-phase1-handoff.md §7. Start with the stats + streak counters: propose the Supabase schema changes and the increment points in server.js, show me the plan before writing code.
```

---

## If something breaks
- Each screen is its own commit — `git revert <hash>` or `git checkout <hash> -- <file>` to roll back just that one.
- If a screen drifts from the design, paste the matching `*-sonic.html` and say: "match this exactly."
- Never let it refactor multiple screens in one diff — if it tries, say "one screen at a time."
