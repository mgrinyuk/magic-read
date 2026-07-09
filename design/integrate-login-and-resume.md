# Integrating Google/Apple login + "Continue where you left off"

Same pattern as before: some clicking in dashboards, then a prompt pasted into the VS Code Claude extension.

---

# A. Google + Apple login

Supabase handles the OAuth for you — you just register the app with Google/Apple, paste two keys into Supabase, then wire the buttons. **Note:** provider dashboards change their wording often, so for the exact current screens follow Supabase's own guides (Authentication → Providers → Google / Apple → "Setup" link). The pieces below are what you'll need either way.

## A1. Google (do this first — it's quick and free)
1. **Google Cloud Console** → create a project (or use one).
2. Configure the **OAuth consent screen** (External, app name, your email).
3. Create **Credentials → OAuth client ID → Web application**.
4. Under **Authorized redirect URIs**, add your Supabase callback:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   (Find `<your-project-ref>` in Supabase → Project Settings → API.)
5. Copy the **Client ID** and **Client secret**.
6. **Supabase → Authentication → Providers → Google** → enable, paste the Client ID + Secret, save.

## A2. Apple (more involved — needs a paid Apple Developer account)
Only required if you want Apple sign-in (and you'll need it for the iOS app later). If you don't have an Apple Developer account ($99/yr) yet, **skip Apple for now and ship Google** — you can add Apple later.
1. **Apple Developer** → create an **App ID**, then a **Services ID** (this becomes the client_id).
2. Enable **Sign in with Apple**; add your domain and the Supabase callback URL (same `…/auth/v1/callback`).
3. Create a **Key** for Sign in with Apple; use it to generate the **client secret** (a signed JWT — Supabase's Apple guide shows how, or it can generate it).
4. **Supabase → Authentication → Providers → Apple** → enable, paste the Services ID + secret, save.

## A3. Wire the buttons (VS Code)
Your sign-up screen already has the Google/Apple buttons in the design. Paste this into the VS Code Claude extension:
```
Wire the existing Google and Apple buttons on the auth screen to Supabase OAuth.
- On click, call supabase.auth.signInWithOAuth({ provider: 'google' (or 'apple'), options: { redirectTo: <the app's URL> } }).
- After the redirect back, make sure the session is picked up and the user lands on the onboarding/home flow like an email login does.
- New OAuth users should get a profile row + 7-day trial automatically (the on_auth_user_created trigger already does this — just confirm it fires for OAuth signups).
- Keep the existing email/password login working.
Show me the diff and how to test each provider.
```

**Test:** click "Continue with Google", approve, confirm you land logged in and a `profiles` row exists with `trial_ends_at` set.

---

# B. "Continue where you left off"

This needs a small table (to remember the last spot) and code to save/read it.

## B1. Run the SQL (Supabase SQL editor)
Open `backend/04-progress-setup.sql`, paste its contents, click **Run**. It creates a `user_progress` table the browser can read/write for its own rows.

## B2. Wire saving + the resume card (VS Code)
Paste this into the VS Code Claude extension:
```
I added a user_progress table (columns: user_id, activity, item_id, position jsonb, title, updated_at; the user can read/write their own rows via RLS).
Wire "continue where you left off":
1. SAVE progress as the user works — upsert a row keyed (user_id, activity, item_id):
   - reading: activity 'reading', item_id = the text id, position = { "sentence": <index> }, title = the text's name. Save when the current sentence changes.
   - speaking: activity 'speaking', same item_id/position shape.
   - video (Phase 2, stub for now): activity 'video', position = { "seconds": <t>, "line": <i> }.
   - flashcards: activity 'flashcards', item_id = deck id, position = { "card": <index> }, title = deck name.
   Upsert via supabase.from('user_progress').upsert(...). Debounce so it doesn't write on every tick.
2. RESUME: on the Home dashboard, query the user's most recent row
   (select * from user_progress where user_id = auth.uid() order by updated_at desc limit 1)
   and fill the "Continue" card with its title + progress; tapping it reopens that activity at the saved position.
   If there's no row, hide the Continue card.
Show me the diff.
```

**Test:** read a few sentences, go Home — the Continue card should show that text; tap it and confirm it reopens at the right sentence.

---

## Order
1. Google (A1 + A3) — quick win.
2. Resume (B1 + B2) — independent, can do anytime.
3. Apple (A2) — when you have an Apple Developer account.
