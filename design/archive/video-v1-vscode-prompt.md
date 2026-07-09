# Video smart captions — v1 kickoff prompt (VS Code Claude extension)

You've run the SQL (incl. `05-captions-cache.sql`). Paste the box below into the VS Code Claude extension with the repo open. It builds the **cheap v1**: existing captions only, no Azure transcription.

---

```
Build the Video smart-captions feature, v1. IMPORTANT SCOPE: use EXISTING captions only — do NOT build Azure Speech-to-Text transcription, and do NOT write any code that downloads or extracts audio from YouTube (it's against their ToS). This is a reskin-era feature; reuse existing services and components, don't add heavy dependencies, and ask before adding any.

Reference files in the repo: video-screen-sonic.html and the no-captions state in loose-ends-sonic.html (visual target), video-phase2-buildkit.md (spec), magic-read-ui-copy.md §5 and §7 (copy). The Supabase table public.video_captions already exists for caching.

Work in 4 stages. After EACH stage, stop and show me the git diff before continuing.

STAGE 1 — Backend captions endpoint
Add GET /api/video-captions?videoId=&lang= (auth required, same gating style as the other endpoints).
1. Check public.video_captions (videoId, lang) via the service-role client; if cached, return it.
2. Otherwise fetch the video's EXISTING captions for that language — human-uploaded OR YouTube's own auto-generated captions. Put this fetch behind a single swappable function (e.g. fetchExistingCaptions(videoId, lang)) so the source can be changed later; do not transcribe audio. If no captions exist, return { needsGeneration: true }.
3. Build "smart captions": for each line keep { start, dur, text }, add a translation (reuse translateService) and pinyin (reuse the existing pinyin helper). For Chinese, tokenize each line into words with per-word pinyin so captions are tappable.
4. Save the built captions to public.video_captions (source 'youtube' or 'youtube_auto') and return them. Keep all keys/tokens server-side.

STAGE 2 — Video screen
Wire the screen to match video-screen-sonic.html. On Load, call /api/video-captions for the pasted YouTube id + the user's target language.
- Embed the YouTube player; build our own transport row: Play/Pause, -5s, Slow, and a progress scrubber.
- Render captions under the player: characters with pinyin above each word (Pinyin on/off toggle), and the translation always on a parallel line beneath. Highlight the line at the current playback time; tapping a line seeks to it.
- Tap any word → the save popover (pinyin · translation · Save), saving to a deck. Reuse the reader's existing word-save flow.
- If the response is { needsGeneration: true }, show the "No captions found" state with a "Try another video" button. The "Auto-generate captions (Pro)" button is DEFERRED for v1 — render it disabled/"Coming soon", don't wire it.

STAGE 3 — "Speak this line"
Add "Speak this line" to each caption line: run the SAME Azure pronunciation scoring the Speaking screen uses, passing that line's text as the reference. Show the per-word color score + tone feedback inline under the line. It counts against the daily pronunciation limit. Reuse azure-pronunciation.js — don't duplicate it.

STAGE 4 — Gating (3 trial videos → Pro)
Free/trial users get 3 videos total during the trial, then Video is Pro-only. Track video opens server-side (a per-user counter, same style as pronunciation_usage). On limit or expired trial, show the upgrade popup with the "Videos are a Pro feature" copy from magic-read-ui-copy.md §7. Show the "{n} free video left" chip while in trial.

Rules recap: existing captions only (no STT, no audio download) in v1; reuse translateService, the pinyin helper, the word-save flow, azure-pronunciation.js, and the upgrade popup; mobile-first (700px centered, full-bleed under 720px); one stage at a time with a diff each.

Start with Stage 1.
```

---

### After it's done
- Test Stage 1 with a video you KNOW has captions (most popular videos do, incl. auto-captions).
- Commit per stage: `git commit -m "video v1: captions endpoint"`, etc.
- If "no captions" comes up a lot in real use, that's the signal to revisit Step 5 (Azure STT on uploaded media) from `video-phase2-buildkit.md`.
