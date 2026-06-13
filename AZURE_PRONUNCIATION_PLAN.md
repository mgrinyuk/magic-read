# Azure Pronunciation Assessment — Architecture & Setup

This replaces the browser-based "pronunciation score" (which measured *did the
recognizer transcribe the right words*, not *was the pronunciation correct*) with
**Azure Speech Pronunciation Assessment**, which scores accuracy at the word and
phoneme level.

## What Azure actually gives you (read this first)

- **Per-word / per-phoneme accuracy** — supported for `zh-CN`. Wrong-tone
  production lowers the accuracy score, and you get per-word error types
  (mispronunciation, omission, insertion). This is the real upgrade.
- **Prosody** (sentence intonation/rhythm) — **English only**. Not available for
  Mandarin. So market this as *"per-syllable pronunciation accuracy on any text
  you paste,"* not as a dedicated tone diagnosis engine.

## Architecture

Browser Speech SDK + a server token endpoint as the metering gate:

1. User taps "your turn." The browser calls `POST /api/speech-token`.
2. The server (Express, on Render) checks the user's plan and daily quota,
   then mints a short-lived Azure token. **The Azure key never reaches the
   browser.** One token = one check, so the server meters at the only point it
   controls.
3. The browser streams mic audio straight to Azure with the reference text and
   gets back scores, which render in the existing result box.

**Tiers:**
- **Guest** → token endpoint returns 401; app falls back to the old browser
  scoring. No Azure cost.
- **Free + signed in** → `FREE_DAILY_PRONUNCIATION_LIMIT` checks/day (default 20).
- **Pro** (`profiles.plan = 'pro'`) → unlimited.

**Cost:** ~$1.32 per hour of audio, prorated per second — an ~8-second check is
about $0.003. This is why it sits behind auth + quota.

## What was built

Backend (`backend/`)
- `server.js` — added `supabaseAdmin` client, Azure config, `requireUser`
  middleware, and `POST /api/speech-token` (entitlement + quota + Azure token).
- `pronunciation-setup.sql` — Supabase tables/functions (run once).
- `.env` — added placeholder keys (fill these in).

Frontend (`frontend/`)
- `azure-pronunciation.js` — new module: loads the Speech SDK, fetches the token,
  runs the assessment, returns scores + per-word results, renders the output.
- `app.js` — imports the module; `record()` and `startFlashcardSpeakingPractice()`
  now try Azure first and fall back to legacy scoring. Gated by the
  `AZURE_PRONUNCIATION` flag (currently `false`).
- `style.css` — styles for the result display.

**Nothing changes in the live app until you flip the flag** (see step 5).

## Setup steps (do these in order)

1. **Create an Azure Speech resource** in the Azure portal (free F0 tier works to
   start). Copy its **Key** and **Region** (e.g. `westeurope`).

2. **Get the Supabase service-role key**: Supabase Dashboard → Project Settings →
   API → `service_role` secret. (Server-only — never put it in the frontend.)

3. **Fill in `backend/.env`:**
   ```
   AZURE_SPEECH_KEY=<your azure key>
   AZURE_SPEECH_REGION=<your azure region, e.g. westeurope>
   SUPABASE_SERVICE_ROLE_KEY=<your supabase service_role key>
   FREE_DAILY_PRONUNCIATION_LIMIT=20
   ```
   On Render, add these same vars in the service's Environment settings.

4. **Run the database setup**: open `backend/pronunciation-setup.sql`, paste it
   into Supabase → SQL Editor, and run it. Then mark yourself as pro for testing:
   ```sql
   update public.profiles set plan = 'pro' where id = '<your-user-uuid>';
   ```
   (uuid is in Supabase → Authentication → Users.)

5. **Turn it on**: in `frontend/app.js`, set `const AZURE_PRONUNCIATION = true;`
   and deploy.

6. **Test**: sign in, paste a Chinese sentence, tap "your turn," and confirm you
   see per-word colored scores. Sign out and confirm guests still get the old
   scoring.

## Follow-on (not built yet)

- **Billing**: the `pro` tier reads `profiles.plan`, but there's no payment flow
  yet. Until you add one (e.g. Stripe writing `plan = 'pro'`), grant pro manually
  via the SQL above.
- **Tone-specific feedback**: you can map low-accuracy syllables back to their
  pinyin tone and surface "这 (zhè) — tone was off" in the UI, built on the
  per-word data the module already returns.
