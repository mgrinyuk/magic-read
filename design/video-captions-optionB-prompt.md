# Video captions — Option B (client-side discovery) — VS Code prompt

Paste the box into the Claude extension. It moves caption-track discovery to the browser (sidesteps the flagged server IP), and the server only fetches the signed timedtext URL + enriches + caches. No new dependency, existing captions only, no Azure STT.

```
We're switching the video-captions feature to "client-side discovery" (Option B), because the server's cloud IP is CAPTCHA/429-blocked by YouTube and InnerTube from the server returns UNPLAYABLE (no visitorData). The browser is not IP-blocked, so the browser will discover the caption track; the server will only fetch the (signed) timedtext content, enrich it, and cache it.

Constraints: no new npm dependencies (do NOT add youtubei.js); existing captions only (no Azure STT, no audio download); reuse the current enrichment (translateBatch + pinyin) and the public.video_captions cache. Work in stages, show me the diff after each, and STOP for my OK between stages.

STAGE 0 — Feasibility check (do this first, no committing)
From the app's own origin (a plain web page, not an extension), test whether the browser can read caption tracks from YouTube's InnerTube player API. Write a tiny throwaway snippet I can run in the browser console on our site that:
- POSTs to https://www.youtube.com/youtubei/v1/player with a WEB client context (credentials:'include'), for videoId "PXdivk4vIIM", and logs playabilityStatus and the captions.playerCaptionsTracklistRenderer.captionTracks (languageCode, kind, baseUrl).
Tell me: does it return captionTracks, or is it blocked by CORS / UNPLAYABLE / missing visitorData? If it's blocked, propose how to get a visitorData client-side (e.g. from the embedded iframe player or a /youtubei visitor_data call) BEFORE we build further. Don't proceed to Stage 1 until discovery actually returns tracks.

STAGE 1 — Server: stop scraping, add a build-from-baseUrl path
- In /api/video-captions (GET), KEEP the cache lookup, but REMOVE the watch-page scrape. On cache miss, return { needsDiscovery: true } instead of trying to fetch from YouTube.
- Add POST /api/video-captions/build (auth required), body: { videoId, lang, source, captionBaseUrl }.
  - Validate videoId (11 chars) and that captionBaseUrl is an https://*.youtube.com/api/timedtext URL.
  - Fetch `${captionBaseUrl}&fmt=json3`, parse the events into lines (start, dur, text) exactly like the current code does.
  - Enrich: reuse translateBatch + the pinyin helper (Chinese → per-word pinyin tokens for tappability).
  - Upsert into public.video_captions keyed by (video_id, lang) where lang is the ACTUAL caption track language; set source ('youtube' | 'youtube_auto'); return the enriched captions.
Keep all keys server-side. Show me the diff.

STAGE 2 — Frontend: discover → build → render, with clean fallback
In app.js loadVideoById:
1. Call GET /api/video-captions. If it returns cached captions → render them.
2. If { needsDiscovery: true } → do client-side discovery (the working method from Stage 0): get captionTracks for the videoId.
3. Pick a track (Stage 3 logic), then POST /api/video-captions/build with { videoId, lang: track.languageCode, source, captionBaseUrl: track.baseUrl }. Render the returned captions.
4. If discovery is blocked, throws, returns UNPLAYABLE, or there are no caption tracks → show the existing "No captions found / Try another video" state. Do NOT fall back to any server-side YouTube fetch. Log a clear reason.
Show me the diff.

STAGE 3 — Track selection (don't force the learning language)
From the discovered tracks: prefer a track whose languageCode matches the user's learning language; if none, and there's exactly one track, use it; if multiple and none match, default to the first and (nice-to-have) show a small track picker so the user can choose. Cache under the actual track language. Show me the diff.

Recap: browser discovers the track (not IP-blocked); server fetches the signed timedtext + enriches + caches (so the cache stays shared across users and cost is unchanged); graceful fallback when discovery fails; no new deps; no STT.
```

After Stage 0 tell me what it reports — if the client call is CORS-blocked we adjust (visitorData trick, or reconsider), and you won't have wasted the build.
