# What to do next — clear steps

Two places you'll work:
- **Supabase SQL editor** → database. You paste SQL and click **Run**.
- **VS Code Claude extension** → the app code. You paste a **prompt** and it edits the files.

Do the steps in order. After each VS Code prompt, run the app and check it before moving on.

---

## ✅ Step 1 — Stats database (DONE)
You already ran `backend/02-stats-streak-setup.sql` in Supabase. Nothing more here.

---

## Step 2 — Make the app count and show stats
The database can now store stats, but the app doesn't fill them in yet. Fix that in VS Code.

**Paste this into the VS Code Claude extension:**
```
In server.js, the my-plan endpoint already reads the user_stats table. Now make stats actually get recorded and shown:
1. Call the Postgres function record_activity(user_id, read, spoken, practiced, current_date) at the right moments — after reading sentences (words_read), after a pronunciation/speaking check (words_spoken), and after a flashcard review (words_practiced). Use the signed-in user's id and the UTC day, the same way the existing pronunciation/text counters work.
2. Make sure the my-plan response includes words_read, words_spoken, words_practiced and current_streak.
3. In the frontend Home dashboard, show those real values instead of the placeholder numbers.
Show me the diff and tell me how to test it.
```
**Then:** open the app, do a little reading/speaking, and confirm the Home numbers move.

---

## Step 3 — Turn on real pronunciation scoring (20/day)
**3a. In Supabase / Render — not SQL, just settings:** in `backend/.env` (and in Render → your service → Environment) set:
```
FREE_DAILY_PRONUNCIATION_LIMIT=20
```

**3b. Paste this into VS Code Claude:**
```
Set the free daily pronunciation limit to 20 everywhere and turn the feature on:
- Confirm server.js reads FREE_DAILY_PRONUNCIATION_LIMIT (now 20).
- In frontend/app.js set userPlan.limits.pronunciationPerDay = 20.
- Set AZURE_PRONUNCIATION = true.
Show me the diff and exactly how to test that scoring works and the limit triggers the upgrade popup.
```

---

## Step 4 — Flashcard spaced repetition (SRS)
**4a. In Supabase SQL editor:** open `backend/03-srs-setup.sql`, paste its contents, click **Run**.

**4b. Paste this into VS Code Claude:**
```
I've added SRS columns to the flashcards table: srs_ease, srs_interval, srs_due, srs_reps, srs_lapses, srs_last_reviewed.
Wire the flashcard review to use them:
- When the user taps Again / Good / Easy, compute the next interval (simple SM-2: Again resets to the start, Good grows the interval, Easy grows it more) and save srs_due plus the other fields back to that card.
- In review, show cards that are due first (srs_due <= today, and brand-new cards).
- Show the "due" count (e.g. on the Home "Cards" tile).
Show me the diff.
```

---

## Step 5 — Later / optional
When you're ready (not required to launch the reskin):
- **Google + Apple login** — add the providers in Supabase Auth, then in VS Code: "wire the Google and Apple buttons to Supabase OAuth."
- **"Continue where you left off"** — save the last position per activity so the resume card works.

---

## Quick reference — which file/setting for what
| Thing | Where | Action |
|---|---|---|
| Stats tables | Supabase SQL | ✅ ran `02-stats-streak-setup.sql` |
| Record + show stats | VS Code | Step 2 prompt |
| 20/day limit | `.env` + Render | `FREE_DAILY_PRONUNCIATION_LIMIT=20` |
| Turn on scoring | VS Code | Step 3b prompt |
| SRS fields | Supabase SQL | run `03-srs-setup.sql` |
| SRS logic | VS Code | Step 4b prompt |
