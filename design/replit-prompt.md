# Prompt: Rebuild Magic Read from scratch on Replit

Build a Chinese (and multi-language) reading + pronunciation learning web app called **Magic Read** (production domain `magicread.app`). The existing backend is on Render at `https://magic-read.onrender.com`. Replicate everything below exactly.

---

## Overview

Magic Read is a **vanilla JS single-page application** with a Node/Express backend. There is **no frontend framework** — no React, no Vue. The UI is one `index.html` file where screens are `<section class="app-screen">` elements toggled by adding/removing the `active` class. The backend is ESM (`"type": "module"`) Express.

The primary learning language is **Chinese (Mandarin, Simplified)** but the app also supports Russian, Turkish, German, Spanish, French, and Japanese. The user interface language is English.

---

## Project structure

```
/
├── frontend/
│   ├── index.html          # entire SPA — all screens in one file
│   ├── app.js              # all client logic (~8 000 lines, ESM)
│   ├── style.css           # all styles (~6 000 lines)
│   ├── azure-pronunciation.js   # Azure Speech SDK wrapper
│   ├── ui-text.js          # UI string constants (versioned with ?v= query)
│   └── mode-copy.js        # per-mode marketing copy
├── backend/
│   ├── server.js           # Express entry point (~2 000 lines, ESM)
│   ├── services/
│   │   ├── captionService.js   # Supadata YouTube transcript fetch
│   │   └── translateService.js # Google Cloud Translation wrapper
│   ├── lib/
│   │   ├── activityRules.js    # record_activity RPC arg builder (typed/legacy)
│   │   ├── planRules.js        # isLifetimeOfferEligible()
│   │   └── tbank.js            # T-Bank order ID, token signing
│   ├── data/
│   │   └── dictionaries/
│   │       └── cedict_ts.u8    # CC-CEDICT dictionary file (required)
│   ├── fonts/
│   │   ├── NotoSansSC-Regular.ttf   # Chinese PDF export
│   │   └── ClassRoomCursive.ttf     # Cyrillic/Latin writing sheet
│   └── google-tts-key.json   # NOT committed — loaded via env var
├── pronunciation-setup.sql   # Supabase migrations (run in order)
├── 02-stats-streak-setup.sql
├── 03-srs-setup.sql
├── 04-progress-setup.sql
├── 05-captions-cache.sql
├── 06-video-usage-setup.sql
├── 07-tbank-payments-setup.sql
└── package.json              # backend deps
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS (ESM), single HTML file, CSS custom properties |
| Backend | Node.js 20+, Express 5 (ESM), `"type": "module"` |
| Auth + DB | Supabase (Postgres + Auth) |
| TTS | Google Cloud Text-to-Speech (Wavenet, SSML marks) |
| Translation | Google Cloud Translation API v2 |
| Pronunciation | Azure Cognitive Services Speech SDK (browser-side) + backend token minting |
| Chinese NLP | `pinyin-pro` npm package + `Intl.Segmenter("zh")` + CC-CEDICT dictionary |
| YouTube captions | Supadata API (`mode=native`, no AI generation) |
| Payments (global) | Stripe (monthly / annual subscriptions + lifetime one-time payment) |
| Payments (Russia) | T-Bank (Tinkoff) — hosted checkout, SBP/cards, SHA-256 token signing |
| PDF export | PDFKit |
| CSV parsing | Papaparse |
| Grammar library | Google Sheets (read via Sheets API v4) |
| Packaging | Capacitor (iOS — not part of this rebuild) |

---

## Environment variables

All must be set in Replit Secrets (or `.env`):

```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Google TTS + Translate
GOOGLE_TTS_KEY_JSON=          # full JSON of a service account key (stringify it)
GOOGLE_APPLICATION_CREDENTIALS=  # (alternative) path to key file
LOAD_CEDICT=true              # set to "true" to load CC-CEDICT into memory at startup

# Azure Speech (pronunciation)
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=          # e.g. "eastus"

# Stripe (global billing)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=         # Stripe Price ID
STRIPE_PRICE_ANNUAL=          # Stripe Price ID
STRIPE_PRICE_LIFETIME=        # Stripe Price ID (one-time payment)

# T-Bank (Russian market)
TBANK_TERMINAL_KEY=
TBANK_PASSWORD=
TBANK_API_URL=https://securepay.tinkoff.ru/v2
TBANK_NOTIFICATION_URL=https://<your-domain>/api/tbank/notification
TBANK_RETURN_URL=https://magicread.app

# Supadata (YouTube captions)
SUPADATA_API_KEY=

# Google Sheets (grammar articles + game texts)
GOOGLE_SHEETS_API_KEY=
GRAMMAR_SHEET_ID=             # Google Spreadsheet ID
GAME_TEXTS_SHEET_URL=         # Public CSV export URL of game texts sheet

# Plan / quota limits (all have defaults — only override to change them)
FREE_DAILY_TEXT_LIMIT=3
FREE_DAILY_PRONUNCIATION_LIMIT=20
FREE_MAX_SAVED_TEXTS=5
FREE_MAX_DECKS=2
FREE_MAX_CARDS=100
FREE_VIDEO_TRIAL_LIMIT=3
LIFETIME_OFFER_ENABLED=false
LIFETIME_OFFER_WINDOW_DAYS=7

# Admin
ADMIN_SECRET=                 # bearer token for /api/admin/* routes

# Server
PORT=3000
```

---

## Backend — `package.json`

```json
{
  "type": "module",
  "scripts": { "start": "node backend/server.js" },
  "dependencies": {
    "express": "^5",
    "cors": "^2",
    "dotenv": "^16",
    "express-rate-limit": "^7",
    "@supabase/supabase-js": "^2",
    "@google-cloud/text-to-speech": "^5",
    "@google-cloud/translate": "^8",
    "pinyin-pro": "^3",
    "googleapis": "^140",
    "pdfkit": "^0.15",
    "papaparse": "^5",
    "stripe": "^17"
  }
}
```

---

## Supabase schema — run migrations in this order

### 1. `pronunciation-setup.sql`
Tables and stored procedures for auth and quota tracking:

```sql
-- profiles: one row per user
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  plan             text not null default 'free',   -- 'free' | 'pro'
  trial_ends_at    timestamptz,
  stripe_customer_id text,
  plan_ends_at     timestamptz,      -- null = unlimited (lifetime or Stripe)
  plan_provider    text,             -- 'stripe' | 'tbank' | 'lifetime' | null
  created_at       timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);

-- Auto-create profile + 7-day trial on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, trial_ends_at)
  values (new.id, now() + interval '7 days')
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- pronunciation_usage: per-user, per-UTC-day counter
create table if not exists public.pronunciation_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.pronunciation_usage enable row level security;

create or replace function public.increment_pronunciation_usage(p_user_id uuid, p_day date)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.pronunciation_usage (user_id, day, count) values (p_user_id, p_day, 1)
  on conflict (user_id, day) do update set count = public.pronunciation_usage.count + 1;
end; $$;

-- text_processing_usage: per-user, per-day counter for text submissions
create table if not exists public.text_processing_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.text_processing_usage enable row level security;

create or replace function public.increment_text_usage(p_user_id uuid, p_day date)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.text_processing_usage (user_id, day, count) values (p_user_id, p_day, 1)
  on conflict (user_id, day) do update set count = public.text_processing_usage.count + 1;
end; $$;
```

### 2. `02-stats-streak-setup.sql`
```sql
create table if not exists public.user_stats (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  words_read       int  not null default 0,
  words_spoken     int  not null default 0,
  words_practiced  int  not null default 0,
  current_streak   int  not null default 0,
  longest_streak   int  not null default 0,
  last_active_date date,
  updated_at       timestamptz not null default now()
);
alter table public.user_stats enable row level security;
create policy "read own stats" on public.user_stats for select using (auth.uid() = user_id);

-- Atomic: add word counts + advance streak once per day
create or replace function public.record_activity(
  p_user_id uuid, p_read int, p_spoken int, p_practiced int, p_day date
) returns void language plpgsql security definer set search_path = public as $$
declare v_last date;
begin
  insert into public.user_stats (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select last_active_date into v_last from public.user_stats where user_id = p_user_id for update;
  update public.user_stats set
    words_read      = words_read      + greatest(p_read, 0),
    words_spoken    = words_spoken    + greatest(p_spoken, 0),
    words_practiced = words_practiced + greatest(p_practiced, 0),
    current_streak = case
      when v_last = p_day                      then current_streak
      when v_last = p_day - interval '1 day'   then current_streak + 1
      else 1 end,
    last_active_date = greatest(coalesce(v_last, p_day), p_day),
    updated_at = now()
  where user_id = p_user_id;
  update public.user_stats set longest_streak = greatest(longest_streak, current_streak)
  where user_id = p_user_id;
end; $$;
```

### 3. `03-srs-setup.sql` — adds SRS columns to flashcards
```sql
-- assumes flashcards table already exists (created by your library feature)
alter table public.flashcards add column if not exists srs_ease     real not null default 2.5;
alter table public.flashcards add column if not exists srs_interval int  not null default 0;
alter table public.flashcards add column if not exists srs_due      date;
alter table public.flashcards add column if not exists srs_reps     int  not null default 0;
alter table public.flashcards add column if not exists srs_lapses   int  not null default 0;
alter table public.flashcards add column if not exists srs_last_reviewed timestamptz;
create index if not exists flashcards_srs_due_idx on public.flashcards (srs_due);
```

### 4. `04-progress-setup.sql` — resume card
```sql
create table if not exists public.user_progress (
  user_id    uuid not null references auth.users(id) on delete cascade,
  activity   text not null,   -- 'reading' | 'speaking' | 'video' | 'flashcards'
  item_id    text not null,
  position   jsonb not null default '{}'::jsonb,
  title      text,
  updated_at timestamptz not null default now(),
  primary key (user_id, activity, item_id)
);
create index if not exists user_progress_recent_idx on public.user_progress (user_id, updated_at desc);
alter table public.user_progress enable row level security;
create policy "own progress select" on public.user_progress for select using (auth.uid() = user_id);
create policy "own progress upsert" on public.user_progress for insert with check (auth.uid() = user_id);
create policy "own progress update" on public.user_progress for update using (auth.uid() = user_id);
```

### 5. `05-captions-cache.sql` — video captions cache
```sql
create table if not exists public.video_captions (
  video_id   text not null,
  lang       text not null,
  source     text not null,   -- 'supadata' | 'no_captions'
  captions   jsonb not null,
  created_at timestamptz not null default now(),
  primary key (video_id, lang)
);
alter table public.video_captions enable row level security;
-- No RLS policy — backend-only via service role key
```

### 6. `06-video-usage-setup.sql` — lifetime video opens counter
```sql
create table if not exists public.video_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  opens   int not null default 0
);
alter table public.video_usage enable row level security;
```

### 7. `07-tbank-payments-setup.sql` — T-Bank payments
```sql
create table if not exists public.tbank_payments (
  payment_id text primary key,
  order_id   text not null unique,
  user_id    uuid not null references auth.users(id) on delete cascade,
  plan_code  text not null check (plan_code in ('monthly', 'annual')),
  amount     bigint not null,
  status     text not null default 'CONFIRMED',
  created_at timestamptz not null default now()
);
alter table public.tbank_payments enable row level security;

-- Atomic: insert payment + grant time-limited Pro
create or replace function public.apply_tbank_payment(
  p_user_id uuid, p_payment_id text, p_order_id text, p_plan_code text, p_amount bigint
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_rows int; v_interval interval; v_unlimited boolean;
begin
  if p_plan_code = 'monthly' and p_amount = 60000 then v_interval := interval '30 days';
  elsif p_plan_code = 'annual' and p_amount = 500000 then v_interval := interval '365 days';
  else raise exception 'Invalid T-Bank plan or amount'; end if;
  insert into public.tbank_payments (payment_id, order_id, user_id, plan_code, amount)
  values (p_payment_id, p_order_id, p_user_id, p_plan_code, p_amount)
  on conflict (payment_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;
  select plan = 'pro' and plan_ends_at is null into v_unlimited
  from public.profiles where id = p_user_id for update;
  update public.profiles set
    plan = 'pro',
    plan_provider = case when v_unlimited then plan_provider else 'tbank' end,
    plan_ends_at = case when v_unlimited then null
      else greatest(coalesce(plan_ends_at, now()), now()) + v_interval end
  where id = p_user_id;
  return true;
end; $$;
revoke all on function public.apply_tbank_payment(uuid,text,text,text,bigint) from public;
grant execute on function public.apply_tbank_payment(uuid,text,text,text,bigint) to service_role;
```

### Other tables (create manually or via additional SQL)

```sql
-- saved_texts: user's library of saved passages
create table if not exists public.saved_texts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text,
  text       text not null,
  lang       text not null default 'zh',
  created_at timestamptz not null default now()
);
alter table public.saved_texts enable row level security;
create policy "own saved_texts" on public.saved_texts using (auth.uid() = user_id);

-- flashcard_decks
create table if not exists public.flashcard_decks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  lang       text not null default 'zh',
  created_at timestamptz not null default now()
);
alter table public.flashcard_decks enable row level security;
create policy "own decks" on public.flashcard_decks using (auth.uid() = user_id);

-- flashcards (SRS columns added by migration 03)
create table if not exists public.flashcards (
  id         uuid primary key default gen_random_uuid(),
  deck_id    uuid not null references public.flashcard_decks(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  word       text not null,
  pinyin     text,
  definition text,
  created_at timestamptz not null default now()
);
alter table public.flashcards enable row level security;
create policy "own flashcards" on public.flashcards using (auth.uid() = user_id);
```

---

## Backend API — all endpoints

### Middleware (in order)
1. `cors()` — allow all origins
2. `express.static('../frontend')` — serve frontend files
3. `/api/stripe-webhook` — raw body, registered BEFORE `express.json()`
4. `express.json()` + `express.urlencoded()`
5. `globalLimiter` — 300 req / 15 min per IP (guests + authed)

### Rate limiters
- `ttsLimiter`: 80 req/hour for guests (skipped for authed users)
- `translateLimiter`: 100 req/hour for guests
- `dictionaryLimiter`: 600 req/hour for guests

### Auth middleware
- `extractUser(req, res, next)` — reads `Authorization: Bearer <jwt>`, calls `supabase.auth.getUser()`, sets `req.user` (null if guest/invalid)
- `requireUser(req, res, next)` — 401 if `req.user` is null
- `requireAdmin(req, res, next)` — checks `x-admin-secret` header against `ADMIN_SECRET`

### Plan resolver — `getUserPlan(userId)`
Central function used by every quota endpoint. Reads `profiles.plan`, `profiles.plan_ends_at`, `profiles.plan_provider`, `profiles.trial_ends_at` and returns:
- `plan`: `'free'` | `'pro'` (paid only)
- `effectivePlan`: `'free'` | `'pro'` (paid OR active 7-day trial)
- `trialActive`: boolean
- `isPaidPro`, `isLifetimePro`, `planEndsAt`, `planProvider`, `lifetimeOfferEligible`

**Rule**: a user is `effectivePlan='pro'` if they are a paid Pro OR still inside their `trial_ends_at` window. All quota endpoints use `effectivePlan`.

---

### Content endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/game-texts?lang=zh` | none | List all game texts from Google Sheet (id, title, level, topic, cardCount) |
| `GET` | `/api/game-texts/:id?lang=zh` | none | Full text record + split into sentences |
| `POST` | `/api/split-text` | none | `{ text }` → `{ sentences: [] }` |
| `POST` | `/api/segment` | none | `{ text }` → `{ words: [{word, pinyin}] }` using Intl.Segmenter + pinyin-pro |
| `POST` | `/api/segment-many` | none | `{ texts: [] }` → batch segmentation |
| `POST` | `/api/dictionary` | optional | `{ word }` → CC-CEDICT lookup → `{ entries: [{simplified, traditional, pinyin, definitions}] }` |
| `POST` | `/api/pinyin` | none | `{ text }` → `{ pinyin }` raw string |
| `POST` | `/api/tts` | optional | `{ text, sourceLang, speakingRate?, voiceName?, words? }` → `{ audioBase64, mimeType, timepoints }`. When `words[]` supplied, uses SSML `<mark>` for word-level timing. |
| `POST` | `/api/translate` | optional | `{ sentence, sourceLang, targetLang }` → `{ translation }` |

**TTS voice map** (default voices):
- `zh` → `cmn-CN-Wavenet-D`
- `ru` → `ru-RU-Wavenet-A`
- `tr` → `tr-TR-Wavenet-A`
- `de` → `de-DE-Wavenet-B`
- `es` → `es-ES-Wavenet-B`
- `fr` → `fr-FR-Wavenet-B`
- `ja` → `ja-JP-Wavenet-B`
- `en` → `en-US-Wavenet-D`

Frontend can override `voiceName` for an alternative voice.

---

### Grammar endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/grammar` | none | `{ sentence, sourceLang }` → `{ items: [{label, matchedText, articleId, shortExplanation}] }` — marker matching against cached Google Sheet |
| `GET` | `/api/grammar/:id?lang=zh` | none | Single grammar article by id |
| `GET` | `/api/grammar-list?lang=zh` | none | All articles (summary only) |
| `POST` | `/api/admin/reload-grammar` | admin | Flush + reload grammar cache from Sheet |

Grammar is loaded from Google Sheets (`GrammarZH`, `GrammarRu`, `GrammarTR`, `GrammarDe`, `GrammarEs`, `GrammarFr`, `GrammarJa` tabs). Sheet columns: `id, title, level, category, shortExplanation, fullExplanation, markers, ex1_ch, ex1_py, ex2_ch, ex2_py, ex3_ch, ex3_py`. Markers are comma-separated strings. Cache TTL: 5 minutes.

---

### PDF export endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/create-writing-sheet` | none | `{ text, sourceLang }` → PDF writing practice sheet (Chinese: character grid; Russian/Turkish: lined cursive sheet) |
| `POST` | `/api/export-flashcard-deck` | none | `{ deckName, words[] }` → PDF character grid for a deck |

---

### Auth / plan endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/my-plan` | required | Returns plan info + today's usage counters + lifetime stats. Full response shape: `{ plan, effectivePlan, planEndsAt, planProvider, isPaidPro, isLifetimePro, trialEndsAt, trialActive, lifetimeOfferEligible, tbankAvailable, textUsedToday, pronouncedToday, videosOpened, wordsRead, wordsSpoken, wordsPracticed, currentStreak, limits: { textPerDay, pronunciationPerDay, savedTexts, decks, cards, videosPerTrial } }` |
| `POST` | `/api/record-activity` | required | `{ type: 'words_read'|'words_spoken'|'words_practiced', count }` → increments user_stats + advances streak. Always returns `{ ok: true }`. |

---

### Quota check endpoints (all POST, all require auth)

Each returns `{ allowed: true }` or `429` with `{ error, code, used, limit }`.

| Path | Code on block | What it checks |
|---|---|---|
| `/api/check-text-quota` | `TEXT_QUOTA_EXCEEDED` | `FREE_DAILY_TEXT_LIMIT` texts per day (increments on call) |
| `/api/check-video-quota` | `VIDEO_QUOTA_EXCEEDED` | `FREE_VIDEO_TRIAL_LIMIT` lifetime opens (trial only); Pro = unlimited; expired trial = always blocked |
| `/api/check-save-text-quota` | `SAVE_TEXT_QUOTA_EXCEEDED` | `FREE_MAX_SAVED_TEXTS` total saved texts |
| `/api/check-deck-quota` | `DECK_QUOTA_EXCEEDED` / `CARD_QUOTA_EXCEEDED` | `FREE_MAX_DECKS` decks + `FREE_MAX_CARDS` total cards. Body: `{ intent: 'new-deck'|'add-card' }` to check only one. |

---

### Pronunciation (Azure) endpoint

```
POST /api/speech-token
Auth: required
```
- Checks quota (`FREE_DAILY_PRONUNCIATION_LIMIT` per UTC day) for non-Pro users, increments via `increment_pronunciation_usage` RPC.
- Calls Azure `issueToken` endpoint to mint a ~10 min token.
- Returns `{ token, region, plan }`.
- The Azure SDK is loaded **browser-side** (`azure-pronunciation.js`); the key never reaches the browser.

---

### Billing endpoints — Stripe

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/stripe-webhook` | Stripe sig | Handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → flips `profiles.plan` |
| `POST` | `/api/create-checkout-session` | required | `{ priceType: 'monthly'|'annual'|'lifetime' }` → Stripe Checkout URL. Lifetime only allowed during `lifetimeOfferEligible` window. |
| `POST` | `/api/create-billing-portal-session` | required | → Stripe Billing Portal URL |
| `GET` | `/api/subscription-status` | required | Returns active/tier/dates/cancelable/canUpgradeToAnnual |
| `POST` | `/api/upgrade-to-annual` | required | Swap monthly → annual subscription in Stripe |
| `POST` | `/api/cancel-subscription` | required | `cancel_at_period_end = true` |
| `POST` | `/api/resume-subscription` | required | `cancel_at_period_end = false` |

Stripe webhook MUST be registered with raw body parser BEFORE `express.json()`. Webhook events to subscribe: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.

---

### Billing endpoints — T-Bank (Russia)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/tbank/create-payment` | required | `{ plan: 'monthly'|'annual' }` → calls T-Bank Init API → `{ url, paymentId, orderId }` |
| `POST` | `/api/tbank/notification` | T-Bank token | Webhook: verifies SHA-256 token, calls `apply_tbank_payment` RPC, grants time-limited Pro |

T-Bank amounts in kopecks: monthly = 60 000 (600 RUB), annual = 500 000 (5 000 RUB).
Order ID format: `mr_{planCode}_{base64url(userId)}_{timestamp_base36}`.

---

### Video captions endpoint

```
GET /api/video-captions?videoId=<11-char>&lang=zh&targetLang=en
Auth: required
```

1. Check positive cache in `video_captions` → return if found.
2. Check negative cache (sentinel row with `lang='__none__'`, 30-day TTL) → return `{ needsGeneration: true }` if fresh.
3. Call Supadata `mode=native` for `lang`, then fall back to default lang.
4. If no captions exist, write negative cache sentinel.
5. Enrich: batch-translate all lines; add `pinyin` + `tokens` for Chinese (`isZh`).
6. Cache enriched captions (fire-and-forget).
7. Return `{ captions, source, cached }`.

Caption shape:
```json
{
  "start": 1.234,
  "dur": 2.5,
  "text": "你好世界",
  "translation": "Hello world",
  "pinyin": "nǐ hǎo shì jiè",
  "tokens": [{ "word": "你好", "pinyin": "nǐ hǎo" }, { "word": "世界", "pinyin": "shì jiè" }]
}
```

---

## Frontend — screens

The SPA uses a single `showScreen(id)` function:
```js
function showScreen(id) {
  document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(id);
  screen.classList.add('active');
  document.body.classList.toggle('video-active', id === 'screen-video');
  if (id !== 'screen-video') {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}
```

**The `body.video-active` class is critical** — it locks the body to `height: 100dvh; overflow: hidden` so the video player fills the screen without page scroll.

### Screen list

| Screen ID | Purpose |
|---|---|
| `screen-main` | Home dashboard (stats, streak, resume card, quick-start composer) |
| `screen-read-setup` | Reading mode setup: source language picker, level badge, text input or library picker |
| `screen-read-reader` | Active reader: passage rendered as tappable word spans, toolbar (pinyin/translation toggles, speed, voice), playback controls, word sheet (bottom sheet), sentence-level grammar tips |
| `screen-read-exercise` | Post-reading exercises: fill-in-the-blank (word bank chips → slots) |
| `screen-speak-setup` | Speaking mode setup: same text as read setup but entering pronunciation coach flow |
| `screen-speak-practice` | Active pronunciation drill: mic button, sentence display, score ring (SVG), Azure assessment results |
| `screen-speak-complete` | Completion: overall score, per-sentence recap chips |
| `screen-flashcards` | SRS flashcard review: flip cards, rate Again/Hard/Good/Easy, progress bar |
| `screen-writing` | Writing practice: character grid display + PDF export |
| `screen-video` | YouTube video player + synchronized caption overlay with Chinese word taps |
| `screen-account` | Account/profile: plan badge, usage stats, upgrade buttons, subscription management |

---

## Frontend — key patterns

### 1. appMode
```js
let appMode = 'reading'; // 'reading' | 'pronunciation'
```
Set when the user chooses their activity. Controls which flow runs after text submission.

### 2. Reader rendering
After `/api/segment` returns `{ words: [{word, pinyin}] }`, the reader renders each sentence as:
```html
<p class="rd-sent" data-idx="0">
  <span class="rd-word" data-word="你好" data-pinyin="nǐ hǎo">
    <small>nǐ hǎo</small>
    <span class="rd-hz">你好</span>
  </span>
  <span class="rd-punc">。</span>
</p>
```
- The passage container is `<div class="rd-han" id="rdHan">` — the `rd-han` class is required for CSS selectors.
- Pinyin is hidden by default. The "Pinyin" toolbar toggle adds `show-pinyin` class to `#rdHan`.
- CSS: `.rd-word { display: inline-flex; flex-direction: column; align-items: center; }` / `.rd-word small { display: none; }` / `.rd-han.show-pinyin .rd-word small { display: block; }`
- Active playback sentence gets class `active` on the `rd-sent` element (not the words).

### 3. TTS with word timing
The frontend sends `{ text, words: [wordStrings] }` to `/api/tts`. The backend builds SSML with `<mark name="wN"/>` before each word and requests `SSML_MARK` timepoints. The response `timepoints` array maps mark names to audio offsets (seconds). The reader uses these offsets + `requestAnimationFrame` to advance `sent.active` and word highlights during playback.

### 4. Bottom sheets
Two bottom sheets exist as fixed overlays:
- `#sheet-voice` — voice picker (lists available Wavenet voices for current language)
- `#sheet-word` — word detail (pinyin, definition from CC-CEDICT, example sentences, grammar tip, "Add to deck" button)

Both share a `#scrim` backdrop. Opening: `scrim.hidden = false; sheet.classList.add('open')`. Closing: remove `.open`, then `scrim.hidden = true` after CSS transition.

### 5. Exercises (`#screen-read-exercise`)
After reading, exercises present fill-in-the-blank sentences. Each exercise:
```html
<div class="rd-ex-item">
  <p class="rd-ex-sentence"><!-- sentence with <span class="slot"> gaps --></p>
  <div class="rd-ex-chips"><!-- draggable/tappable option chips --></div>
</div>
```
User drags a chip into a slot; correct = chip turns green, incorrect = red shake.

### 6. Pronunciation flow
1. User enters text → `appMode = 'pronunciation'` → navigate to `screen-speak-practice`
2. Each sentence shown one at a time.
3. Tap mic button → `assessPronunciation(referenceText, lang, { tokenUrl, fetchWithAuth })` from `azure-pronunciation.js`.
4. Result rendered by `renderAssessment(result, lang)` — color-coded per-word accuracy.
5. Low-scoring chunks drilled individually (up to `DRILL_MAX_ATTEMPTS`).
6. After all sentences, navigate to `screen-speak-complete`.

### 7. Video screen
- User pastes a YouTube URL → extract video ID → call `/api/check-video-quota` → call `/api/video-captions`.
- Video plays in an embedded `<iframe>` (YouTube IFrame API) or `<video>` element.
- Caption overlay syncs with `timeupdate` events; each caption line tappable for word detail.
- `body.video-active` locks scroll (see `showScreen` above).

### 8. Flashcards (SRS)
- SM-2 variant scheduling: intervals 1 → 3 → 7 → … days based on ease factor.
- "Again" → reset to interval 0, decrement ease; "Easy" → jump to longer interval.
- Updates `flashcards.srs_due`, `srs_interval`, `srs_ease`, `srs_reps`, `srs_lapses`, `srs_last_reviewed` directly in Supabase from the browser.

### 9. Plan + upgrade UI
`fetchMyPlan()` calls `/api/my-plan` and stores the result globally. The account screen (`screen-account`) reads it to:
- Show "Pro ✨" badge vs "Free" + streak/stats
- Show upgrade CTA with 3 plan options (monthly, annual, lifetime if eligible)
- Show T-Bank payment option if `tbankAvailable` is true (Russian market)
- Show subscription management (cancel/resume/upgrade-to-annual) for paid users

### 10. Auth (Supabase)
```js
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```
- Sign up / sign in via `supabase.auth.signUp()` / `signInWithPassword()` / `signInWithOtp()` (magic link).
- Session persisted in `localStorage` by the Supabase client automatically.
- All authenticated API calls send `Authorization: Bearer ${session.access_token}` header via a `fetchWithAuth(url, opts)` helper.

---

## CSS conventions

```css
:root {
  --primary: #FF6B6B;   /* coral/pink — main accent, active states */
  --cyan: #4ECDC4;      /* teal — secondary accent */
  --good: #52B788;      /* green — correct/score-good */
  --warn: #FFB703;      /* amber — warning/score-medium */
  --bad: #E63946;       /* red — error/score-low */
  --bg: #FAFAF8;        /* off-white page background */
  --card: #FFFFFF;      /* card background */
  --text: #2D2D2D;      /* primary text */
  --muted: #9B9B9B;     /* secondary/hint text */
  --border: #E8E8E8;    /* dividers */
}
```

Key layout classes:
- `.app-shell` — full-height flex container (header + `.main` + bottom nav)
- `.app-screen` — `display: none` by default; `.app-screen.active { display: block }` (or flex for some screens)
- `.main` — scrollable content area, `padding-bottom: calc(96px + env(safe-area-inset-bottom))`
- Bottom nav: `.nav-bar` with 5 icon buttons
- `body.video-active .app-shell { height: 100dvh !important; overflow: hidden !important; }` — video scroll lock

Reader-specific:
- `.rd-han` — passage container
- `.rd-word` — `inline-flex; flex-direction: column; align-items: center; cursor: pointer`
- `.rd-hz` — character span inside word
- `.rd-sent.active` — active playback sentence (background highlight `--primary` at ~15% opacity)
- `.rd-han.show-pinyin .rd-word small` — visible when pinyin pill is ON
- `.rd-han.show-trans .rd-sent-trans` — translation line shown per-sentence when trans pill is ON

Speak-specific:
- `.sp-*` prefix for all speaking screen classes
- Score ring: SVG `<circle>` with `stroke-dasharray` / `stroke-dashoffset` animation

---

## Chinese text processing pipeline

1. **Segmentation**: `Intl.Segmenter("zh", { granularity: "word" })` → segments, filter empty
2. **Pinyin**: `pinyin(word, { toneType: "symbol", type: "array" }).join(" ")` from `pinyin-pro`
3. **Dictionary**: CC-CEDICT (`cedict_ts.u8`) loaded into memory map `{ simplified: [entries] }` at startup (only if `LOAD_CEDICT=true`)
4. **Grammar hints**: marker matching against Google Sheet grammar library
5. **TTS**: SSML with `<mark>` tags, word-level timepoints for reader sync

---

## Game texts (built-in lessons)

The app fetches curated lesson texts from a Google Sheet CSV:
- `GET /api/game-texts?lang=zh` → list of available lessons with metadata
- `GET /api/game-texts/:id?lang=zh` → full lesson text split into sentences

Sheet columns: `id, title, level, topic, lang, text, sentence_count`. URL configured via `GAME_TEXTS_SHEET_URL` env var (publicly accessible CSV export link).

---

## Activity tracking

After completing a reading session, the frontend calls:
```
POST /api/record-activity
{ "type": "words_read", "count": 42 }
```
After pronunciation: `"type": "words_spoken"`. After flashcards: `"type": "words_practiced"`.

The backend calls the `record_activity` Postgres function which atomically:
1. Upserts the word counter deltas
2. Advances the streak (once per UTC day)
3. Updates `longest_streak`

---

## Lifetime offer logic

After a user's 7-day trial expires, a "special lifetime offer" can be unlocked (configurable window via `LIFETIME_OFFER_WINDOW_DAYS`). `isLifetimeOfferEligible()` from `lib/planRules.js` returns true only if:
- `LIFETIME_OFFER_ENABLED=true` in env
- User is not already Pro
- `trialEndsAt` is within `windowDays` days in the past

---

## Key implementation notes

1. **Stripe webhook MUST use raw body** — register it before `express.json()` middleware.
2. **Supabase service role key** bypasses RLS — use only server-side. All quota tables have RLS enabled with no public policies.
3. **CC-CEDICT load** is controlled by `LOAD_CEDICT=true` env — the file is ~30 MB and takes a moment to parse. On Replit free tier it may need to stay disabled.
4. **T-Bank token** is a SHA-256 hash of sorted concatenated scalar field values (including `Password`). See `lib/tbank.js`.
5. **Azure SDK** is loaded from CDN in the browser (`azure-pronunciation.js`). The backend only mints short-lived tokens; the actual audio recording + scoring happens in the browser.
6. **Grammar cache** refreshes every 5 minutes. Use `POST /api/admin/reload-grammar` with the `x-admin-secret` header to force a reload.
7. **Negative caption cache** (sentinel with `lang='__none__'`) prevents Supadata credit waste on videos without captions. TTL is 30 days.
8. **`body.video-active` class** must be toggled by `showScreen()` — without it the video screen will have a broken scroll lock.
9. **No build step** — the frontend is served as-is by `express.static`. Import maps or CDN imports handle ESM dependencies (Supabase client from jsDelivr CDN).
10. **`pinyin-pro` is backend-only** — do not try to import it in the browser; use the `/api/pinyin` or `/api/segment` endpoints instead.
