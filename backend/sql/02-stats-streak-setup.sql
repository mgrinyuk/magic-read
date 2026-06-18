-- ============================================================
-- Stats + streak counters — Supabase setup
-- Adds: user_stats table, record_activity() function.
-- Safe to re-run (all statements are idempotent).
-- Run once in the Supabase SQL editor (Dashboard → SQL).
-- ============================================================

-- 1) user_stats: one row per user, lifetime counters + streak.
--    Rows are created lazily by record_activity() on first call.
create table if not exists public.user_stats (
  user_id            uuid   primary key references auth.users(id) on delete cascade,
  words_read         bigint not null default 0,
  words_spoken       bigint not null default 0,
  words_practiced    bigint not null default 0,
  current_streak     int    not null default 0,
  last_activity_date date                          -- null = never recorded
);

-- Lock down direct browser access. The backend uses the service-role key
-- (bypasses RLS) so it still has full write access.
alter table public.user_stats enable row level security;

-- Allow a signed-in user to read their own row from the browser
-- (used by /api/my-plan, but also safe to expose for future client reads).
drop policy if exists "read own stats" on public.user_stats;
create policy "read own stats" on public.user_stats
  for select using (auth.uid() = user_id);

-- 2) record_activity(): atomic counter increment + streak update in one call.
--    p_type: 'words_read' | 'words_spoken' | 'words_practiced'
--    Unknown p_type values are silently ignored (forward-compatible).
create or replace function public.record_activity(
  p_user_id uuid,
  p_type    text,
  p_count   int,
  p_today   date
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_last date;
begin
  -- Create the stats row for this user if it doesn't exist yet.
  insert into public.user_stats (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  -- Increment the appropriate lifetime counter.
  if p_type = 'words_read' then
    update public.user_stats
      set words_read = words_read + p_count
      where user_id = p_user_id;
  elsif p_type = 'words_spoken' then
    update public.user_stats
      set words_spoken = words_spoken + p_count
      where user_id = p_user_id;
  elsif p_type = 'words_practiced' then
    update public.user_stats
      set words_practiced = words_practiced + p_count
      where user_id = p_user_id;
  end if;

  -- Update streak (at most once per calendar day).
  select last_activity_date into v_last
    from public.user_stats
    where user_id = p_user_id;

  if v_last is null then
    -- First ever activity.
    update public.user_stats
      set current_streak = 1, last_activity_date = p_today
      where user_id = p_user_id;
  elsif v_last = p_today then
    -- Already recorded activity today — leave streak alone.
    null;
  elsif v_last = p_today - 1 then
    -- Practiced yesterday and again today — extend streak.
    update public.user_stats
      set current_streak = current_streak + 1, last_activity_date = p_today
      where user_id = p_user_id;
  else
    -- Gap of one or more days — reset to 1.
    update public.user_stats
      set current_streak = 1, last_activity_date = p_today
      where user_id = p_user_id;
  end if;
end;
$$;

-- ============================================================
-- To inspect counters for a user:
--   select * from public.user_stats where user_id = '<uuid>';
-- To manually reset a streak (e.g. testing):
--   update public.user_stats set current_streak = 0, last_activity_date = null
--     where user_id = '<uuid>';
-- ============================================================
