-- ============================================================
-- Azure pronunciation assessment — Supabase setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL).
-- Safe to re-run (idempotent).
-- ============================================================

-- 1) profiles: one row per user, holds the entitlement flag.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  plan       text not null default 'free',   -- 'free' | 'pro'
  created_at timestamptz default now()
);

-- Auto-create a profile row whenever a new user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users who already exist.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- 2) pronunciation_usage: per-user, per-day counter (the quota meter).
create table if not exists public.pronunciation_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- 3) Atomic increment used by the /api/speech-token endpoint.
create or replace function public.increment_pronunciation_usage(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pronunciation_usage (user_id, day, count)
  values (p_user_id, p_day, 1)
  on conflict (user_id, day)
  do update set count = public.pronunciation_usage.count + 1;
end;
$$;

-- 4) Lock both tables down. The backend uses the SERVICE ROLE key, which
--    bypasses RLS, so enabling RLS with NO policies blocks all direct
--    browser access while the server keeps full access.
alter table public.profiles            enable row level security;
alter table public.pronunciation_usage enable row level security;

-- (Optional) let a signed-in user read their OWN plan from the browser,
-- e.g. to show an "upgrade" badge. Uncomment if you want that.
-- create policy "read own profile" on public.profiles
--   for select using (auth.uid() = id);

-- ============================================================
-- To grant yourself / a tester unlimited access until billing exists:
--   update public.profiles set plan = 'pro' where id = '<user-uuid>';
-- Find the uuid in Supabase → Authentication → Users.
-- ============================================================
