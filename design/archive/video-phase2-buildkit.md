# Video smart captions — Phase 2 build kit

Build order, same pattern as the reskin runbook: run the SQL, then paste each prompt into the VS Code Claude extension, one at a time, reviewing the diff between each.

The Video **screen** is already designed (`video-screen-sonic.html`, plus the no-captions state in `loose-ends-sonic.html`). This kit wires it up.

---

## Cost & scope — read first
**Ship v1 with existing captions only.** Reading captions that already exist on a video — human-uploaded *or* YouTube's own auto-generated ones — costs **$0 to transcribe**. The only first-load cost is translating each line (pinyin is generated locally = free), and the cache means that happens **once per video+language** and is reused for everyone after. So marginal cost trends to ~zero and there's no audio handling.

**Azure Speech-to-Text (Step 5) is OPTIONAL and DEFERRED.** It's paid per minute + slower, and only needed for the rare video with *no* captions at all. Don't build it for launch — add it later (scoped to uploaded media) only if users actually hit the "no captions" wall often.

## How captions are obtained — the fallback chain
For a pasted YouTube link + target language:
1. **Cache hit?** → use it (table `video_captions`).
2. **Existing captions** (human-uploaded *or* YouTube's own auto-captions) → use them. **← this is the whole v1 path.**
3. **None?** → show the "no captions" state (Step 2). Auto-generate via Azure (Step 5) is a later, optional add-on.

For step 2, build "smart captions": segment into lines and add **pinyin + translation** using your existing services. Cache the result.

> ⚠️ **Legal/ToS — applies even to free captions.** "Free" isn't fully "clean": YouTube's official API only lets you download captions for videos you **own**; getting arbitrary videos' auto-captions uses unofficial transcript endpoints, a ToS gray area. And programmatically downloading audio from YouTube to transcribe (Step 5) is against YouTube's Terms. Confirm current ToS before relying on either, and treat Step 5 auto-generate as "uploaded media or a compliant source" only — never YouTube downloads.

---

## Step 0 — Cache table (Supabase SQL editor)
Open `backend/05-captions-cache.sql`, paste, **Run**.

---

## Step 1 — Backend: captions endpoint (existing captions → smart captions)
Paste into VS Code Claude:
```
Add a backend endpoint GET /api/video-captions?videoId=&lang= (auth required, like the other gated endpoints). Logic:
1. Look up public.video_captions (videoId, lang) via the service-role client. If found, return it.
2. Otherwise fetch the video's EXISTING captions for that language (human or YouTube auto-captions). If none exist, return { needsGeneration: true }.
3. Build "smart captions": keep each line's { start, dur, text }, and add pinyin + translation using the same services the reader/flashcards already use (reuse translateService and the pinyin helper — don't add new libraries). For Chinese, also tokenize each line into words with per-word pinyin so captions are tappable.
4. Save the built captions to public.video_captions with source 'youtube' or 'youtube_auto', then return them.
Keep the Azure key and any tokens server-side. Show me the diff and how to test with a known captioned video.
```

---

## Step 2 — Frontend: wire the video screen
Paste into VS Code Claude:
```
Wire the Video screen (match video-screen-sonic.html). On Load, call /api/video-captions for the pasted YouTube id + the user's target language.
- Embed the YouTube player; build our own transport row: Play/Pause, -5s, Slow, and a progress scrubber.
- Render captions under the player: each line shows the characters with pinyin above each word (Pinyin on/off toggle) and the translation always on a parallel line below. Highlight the line at the current playback time; tapping a line seeks to it.
- Tap any word to open the save popover (pinyin · translation · Save) and save it to a deck — reuse the reader's word-save flow.
- If the response is { needsGeneration: true }, show the "No captions found" state with "Try another video" and "Auto-generate captions (Pro)".
Show me the diff.
```

---

## Step 3 — "Speak this line"
Paste into VS Code Claude:
```
Add "Speak this line" to each caption line: it runs the SAME Azure pronunciation scoring the Speaking screen uses, passing that line's text as the reference. Show the per-word color score + tone feedback inline under the line. It counts against the daily pronunciation limit like a normal check. Reuse azure-pronunciation.js — don't duplicate it. Show me the diff.
```

---

## Step 4 — Gating (3 free videos in trial, then Pro)
Paste into VS Code Claude:
```
Gate video like the other limits: free/trial users get 3 videos total during the trial, then it's Pro-only. Track video opens server-side (a per-user counter, same style as pronunciation_usage). When the limit is hit or the trial has ended for a free user, show the upgrade popup with the "Videos are a Pro feature" copy from magic-read-ui-copy.md §7. Show the "{n} free video left" chip while in trial. Show me the diff.
```

---

## Step 5 — Auto-generate captions (Pro) — OPTIONAL / DEFERRED
**Skip this for v1.** Only build it later if "no captions" turns out to be common, and only for **user-uploaded** media (never YouTube downloads — see the ToS box). When you do:
```
Implement "Auto-generate captions (Pro)" for a user-UPLOADED audio/video file (not by downloading YouTube media):
1. Accept an uploaded file (Pro only). Send the audio to Azure Speech-to-Text (the resource we already use) to get a transcript with timestamps for the target language.
2. Run it through the same smart-captions builder from Step 1 (segment + pinyin + translation), cache it in public.video_captions with source 'generated'/'upload', and render it in the same Video UI.
3. Surface a clear cost/latency state ("Generating captions…") and handle failures.
Do NOT add any code that downloads or extracts audio from YouTube. Show me the diff and the new env/config needed.
```

---

## Notes
- **Caching is the cost control** — once a video+lang is built, it's reused for everyone. Azure STT and translation only run on first build.
- "Speak this line" accuracy depends on caption accuracy; auto-generated transcripts are imperfect, so the score reflects the transcript.
- This is all Phase 2 — none of it blocks the reskin relaunch.
