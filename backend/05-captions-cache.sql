-- ============================================================
-- Video smart-captions cache — Supabase setup (Phase 2)
-- Run once in the Supabase SQL editor (Dashboard → SQL). Idempotent.
-- Caches built captions per video + language so we don't re-fetch /
-- re-translate / re-transcribe the same video. Backend-only access.
-- ============================================================

create table if not exists public.video_captions (
  video_id   text not null,          -- youtube id, or an upload id
  lang       text not null,          -- target language code (e.g. 'zh')
  source     text not null,          -- 'youtube' | 'youtube_auto' | 'generated' | 'upload'
  captions   jsonb not null,         -- [{ start, dur, text, pinyin, translation, tokens:[{w,py}] }]
  created_at timestamptz not null default now(),
  primary key (video_id, lang)
);

-- Backend uses the SERVICE ROLE key (bypasses RLS). Enable RLS with NO policy
-- so the browser can't read/write directly — it goes through /api endpoints,
-- like the usage tables.
alter table public.video_captions enable row level security;
-- ============================================================
