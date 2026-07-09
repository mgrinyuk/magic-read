# Video captions — Supadata integration — VS Code prompt

Replaces the blocked YouTube scrape with the Supadata transcript API (server-side; works for web now and the phone app later). Supadata handles the proxy/bot battle; our server enriches (pinyin + translation) and caches as before. Provider-agnostic wrapper so it can be swapped.

## Before VS Code
1. Get a free Supadata API key (100 credits/mo) from the Supadata dashboard.
2. Add `SUPADATA_API_KEY=...` to `backend/.env` and to Render → Environment.

## Paste this into the VS Code Claude extension (whole thing — it self-stages)

```
We're replacing the broken YouTube caption scrape with the Supadata transcript API (server-side, so it works for web now and the phone app later). Supadata handles the proxy/bot battle; our server just calls it, then enriches (pinyin + translation) and caches exactly as before. Keep it provider-agnostic so we can swap later. No new heavy deps beyond a fetch call; existing captions only (do NOT enable Supadata's AI auto-generation — we don't want surprise transcription cost). Work in stages, show me the diff after each, and stop for my OK between stages.

Read Supadata's current YouTube transcript API docs for the exact request/response shape before coding (endpoint, the x-api-key header, the params for video id + language, how it returns lines with timing, and how it reports available languages / "no transcript").

STAGE 1 — Backend wrapper + rewire the endpoint
1. Add a small provider-agnostic helper, e.g. fetchTranscript(videoId, preferredLang) in backend/services/ (new file or alongside translateService). It calls Supadata using process.env.SUPADATA_API_KEY and returns a NORMALIZED result: { lines: [{ start, dur, text }] (seconds), language } — or null if the video has no usable captions. Isolate ALL Supadata-specific details (URL, headers, field names, ms→seconds conversion) inside this one function so the rest of the code is provider-neutral.
2. In GET /api/video-captions: keep the cache lookup. REMOVE the watch-page scrape / ytInitialPlayerResponse code entirely. On cache miss, call fetchTranscript(); if it returns null, respond { needsGeneration: true }. Otherwise enrich with the existing translateBatch + pinyin helper (Chinese → per-word tokens for tappability), upsert into public.video_captions keyed by (video_id, actual language), and return it.
3. Handle Supadata errors gracefully: out-of-credits / rate-limit / network → log it and return a clear "captions temporarily unavailable" response the UI can show (distinct from "no captions for this video"). Never crash the request.

STAGE 2 — Language selection (don't force the learning language)
Request the user's learning language first; if Supadata reports it's not available, fall back to the video's default/available transcript and cache under that actual language. If you can cheaply list available languages, prefer: exact learning-language match → else default. Show me the diff.

STAGE 3 — Frontend sanity pass
The Video screen already calls GET /api/video-captions and renders. Just confirm: cached + fresh results render identically; { needsGeneration: true } shows the existing "No captions found / Try another video" state; and the new "temporarily unavailable" error shows a distinct, friendly message (not the no-captions one). Remove any dead client-side discovery / scrape code if present. Show me the diff.

Recap: Supadata behind a swappable fetchTranscript() wrapper; server still enriches + caches (cache shared across users, billed per unique video); existing captions only, no AI generation; graceful states for no-captions vs service-error.
```

## Notes
- Cache = cost control: Supadata is billed per UNIQUE video (cached once), so ~100 free credits ≈ 100 distinct videos/month before a paid plan.
- AI auto-generation is intentionally OFF — that's the deferred paid STT path; don't let it fire on captionless videos.
- Paste the whole prompt at once. It's written to self-stage: the agent does Stage 1, shows a diff, and waits for your "OK / continue" before Stage 2, etc.
