-- ============================================================
-- Stats & streak — Supabase setup (Phase 1 dashboard)
-- Run this once in the Supabase SQL editor (Dashboard → SQL).
-- Safe to re-run (idempotent). Independent of pronunciation/Stripe setup.
-- ============================================================

-- 1) user_stats: one row per user. Holds lifetime word counters + streak.
--    Rows are created lazily on first activity, so a brand-new user has NO
--    row — the `my-plan` query uses maybeSingle() and treats null as zeros.
create table if not exists public.user_stats (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  words_read       int  not null default 0,
  words_spoken     int  not null default 0,
  words_practiced  int  not null default 0,   -- reviewed via flashcards
  current_streak   int  not null default 0,
  longest_streak   int  not null default 0,
  last_active_date date,
  updated_at       timestamptz not null default now()
);

-- Backfill columns if the table existed in an earlier form (no-op otherwise).
alter table public.user_stats add column if not exists words_read       int  not null default 0;
alter table public.user_stats add column if not exists words_spoken     int  not null default 0;
alter table public.user_stats add column if not exists words_practiced  int  not null default 0;
alter table public.user_stats add column if not exists current_streak   int  not null default 0;
alter table public.user_stats add column if not exists longest_streak   int  not null default 0;
alter table public.user_stats add column if not exists last_active_date date;
alter table public.user_stats add column if not exists updated_at       timestamptz not null default now();

-- 2) record_activity: atomic upsert called by the backend after an activity.
--    Adds word counts AND advances the daily streak (once per day).
--    Pass the deltas for whatever happened (0 for the rest) and the UTC day,
--    the same way the pronunciation/text counters are called.
--      select public.record_activity('<uuid>', 12, 0, 0, current_date);  -- read 12 words
create or replace function public.record_activity(
  p_user_id   uuid,
  p_read      int,
  p_spoken    int,
  p_practiced int,
  p_day       date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last date;
begin
  -- Ensure a row exists, then read the current last_active_date.
  insert into public.user_stats (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select last_active_date into v_last
  from public.user_stats where user_id = p_user_id for update;

  update public.user_stats set
    words_read      = words_read      + greatest(p_read, 0),
    words_spoken    = words_spoken    + greatest(p_spoken, 0),
    words_practiced = words_practiced + greatest(p_practiced, 0),
    current_streak = case
      when v_last = p_day                 then current_streak              -- already counted today
      when v_last = p_day - interval '1 day' then current_streak + 1       -- consecutive day
      else 1                                                               -- first day or streak broken
    end,
    last_active_date = greatest(coalesce(v_last, p_day), p_day),
    updated_at = now()
  where user_id = p_user_id;

  -- Keep longest_streak as the running max.
  update public.user_stats
    set longest_streak = greatest(longest_streak, current_streak)
  where user_id = p_user_id;
end;
$$;

-- 3) RLS: backend uses the SERVICE ROLE key (bypasses RLS) for all writes.
--    Enable RLS and add ONLY a read-own-row policy so the dashboard can read
--    its own stats from the browser (mirrors the "read own profile" policy).
--    No insert/update policy → browsers can't tamper with counters.
alter table public.user_stats enable row level security;

drop policy if exists "read own stats" on public.user_stats;
create policy "read own stats" on public.user_stats
  for select using (auth.uid() = user_id);

-- ============================================================
-- (Optional) pre-create zero rows for existing users instead of lazy creation.
-- Not required — maybeSingle() handles the missing-row case as zeros.
--   insert into public.user_stats (user_id)
--   select id from auth.users on conflict (user_id) do nothing;
-- ============================================================
