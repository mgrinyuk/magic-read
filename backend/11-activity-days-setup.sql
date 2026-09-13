-- ============================================================
-- Daily activity log — Supabase setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL).
-- Safe to re-run (idempotent). Requires 02-stats-streak-setup.sql, and run
-- 12-lock-down-rpc-functions.sql first.
--
-- Why: user_stats only keeps the LAST active day, and user_progress rows are
-- overwritten, so retention (did people come back on day 2? day 7?) could not
-- be measured. activity_days keeps one row per user per active day.
-- ============================================================

-- 1) activity_days: one row per user per calendar day with any activity.
--    `day` is the user's local calendar day as sent by the app (the backend
--    only accepts it within ±1 day of UTC, otherwise it uses the UTC date).
create table if not exists public.activity_days (
  user_id         uuid not null references auth.users(id) on delete cascade,
  day             date not null,
  words_read      int  not null default 0,
  words_spoken    int  not null default 0,
  words_practiced int  not null default 0,
  backfilled      boolean not null default false,   -- true = reconstructed from older tables
  created_at      timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists activity_days_day_idx on public.activity_days (day);

-- Writes go through record_activity (security definer) only. Users may read
-- their own days, e.g. for a streak calendar on the Home screen.
alter table public.activity_days enable row level security;

drop policy if exists "read own activity days" on public.activity_days;
create policy "read own activity days" on public.activity_days
  for select using (auth.uid() = user_id);

-- 2) record_activity: SAME signature as before (the backend calls it by these
--    argument names), now also logging the day. Two behaviour changes:
--    • an earlier day arriving after a later one (e.g. a user switching from an
--      old app build that sent UTC dates to one sending local dates) no longer
--      resets the streak;
--    • every call adds to that day's row in activity_days.
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
  insert into public.user_stats (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select last_active_date into v_last
  from public.user_stats where user_id = p_user_id for update;

  update public.user_stats set
    words_read      = words_read      + greatest(p_read, 0),
    words_spoken    = words_spoken    + greatest(p_spoken, 0),
    words_practiced = words_practiced + greatest(p_practiced, 0),
    current_streak = case
      when v_last is null         then 1                                -- first activity ever
      when p_day <= v_last        then greatest(current_streak, 1)      -- same day, or a late/earlier day: never reset
      when p_day = v_last + 1     then current_streak + 1               -- consecutive day
      else 1                                                            -- streak broken
    end,
    last_active_date = greatest(coalesce(v_last, p_day), p_day),
    updated_at = now()
  where user_id = p_user_id;

  update public.user_stats
    set longest_streak = greatest(longest_streak, current_streak)
  where user_id = p_user_id;

  insert into public.activity_days (user_id, day, words_read, words_spoken, words_practiced)
  values (p_user_id, p_day, greatest(p_read, 0), greatest(p_spoken, 0), greatest(p_practiced, 0))
  on conflict (user_id, day) do update set
    words_read      = public.activity_days.words_read      + excluded.words_read,
    words_spoken    = public.activity_days.words_spoken    + excluded.words_spoken,
    words_practiced = public.activity_days.words_practiced + excluded.words_practiced,
    backfilled      = false;
end;
$$;

-- 3) Only the backend (service role) may call record_activity. Supabase grants
--    EXECUTE on public functions to anon/authenticated by default, which would
--    let any client write stats — and activity-log rows — for any user id.
revoke execute on function public.record_activity(uuid, int, int, int, date) from public, anon, authenticated;
grant  execute on function public.record_activity(uuid, int, int, int, date) to service_role;

-- 4) Backfill: best-effort history from before this table existed. It can only
--    recover days that older tables happened to keep, so treat pre-migration
--    retention numbers as a lower bound (rows are marked backfilled = true).
insert into public.activity_days (user_id, day, backfilled)
select user_id, last_active_date, true from public.user_stats where last_active_date is not null
union
select user_id, day, true from public.pronunciation_usage where count > 0
union
select user_id, day, true from public.text_processing_usage where count > 0
union
select user_id, day, true from public.api_usage where count > 0
union
select user_id, (updated_at at time zone 'utc')::date, true from public.user_progress
on conflict (user_id, day) do nothing;

-- ============================================================
-- Check it worked (optional):
--   select count(*) filter (where backfilled)     as backfilled_rows,
--          count(*) filter (where not backfilled) as live_rows,
--          count(distinct user_id)                as users
--   from public.activity_days;
-- ============================================================
