-- ============================================================
-- Activity progress ("Continue where you left off") — Supabase setup
-- Run once in the Supabase SQL editor (Dashboard → SQL). Idempotent.
-- Stores the last position per activity so the resume card works.
-- Low-stakes data, so the browser reads AND writes its OWN rows directly
-- (unlike the tamper-proof counters, which only the backend writes).
-- ============================================================

create table if not exists public.user_progress (
  user_id    uuid not null references auth.users(id) on delete cascade,
  activity   text not null,                       -- 'reading' | 'speaking' | 'video' | 'flashcards'
  item_id    text not null,                       -- text id, video id, deck id, etc.
  position   jsonb not null default '{}'::jsonb,  -- e.g. {"sentence":4} or {"seconds":73,"line":5}
  title      text,                                -- label for the resume card (e.g. "老舍 · 茶馆")
  updated_at timestamptz not null default now(),
  primary key (user_id, activity, item_id)
);

-- Fast "most recent activity" lookup for the Home resume card.
create index if not exists user_progress_recent_idx
  on public.user_progress (user_id, updated_at desc);

-- RLS: each user can read/write only their OWN rows (browser-side saving).
alter table public.user_progress enable row level security;

drop policy if exists "own progress select" on public.user_progress;
create policy "own progress select" on public.user_progress
  for select using (auth.uid() = user_id);

drop policy if exists "own progress upsert" on public.user_progress;
create policy "own progress upsert" on public.user_progress
  for insert with check (auth.uid() = user_id);

drop policy if exists "own progress update" on public.user_progress;
create policy "own progress update" on public.user_progress
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- ============================================================
