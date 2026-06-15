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

-- If a profiles table already existed (created by the app earlier), make sure
-- the plan column is present. `create table if not exists` above will NOT add
-- columns to a pre-existing table, so this ALTER backfills it.
alter table public.profiles add column if not exists plan text not null default 'free';

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


-- ============================================================
-- Stripe setup — run separately
-- Run this block once in the Supabase SQL editor when enabling billing.
-- Safe to re-run (idempotent).
-- ============================================================

-- Stores the user's Stripe customer id so subscription webhooks can map a
-- Stripe customer back to a profile.
alter table public.profiles add column if not exists stripe_customer_id text;

-- The frontend reads the user's own plan (to show the "Upgrade to Pro ✨"
-- button vs the "Pro ✨" badge). With RLS enabled and no policy, that browser
-- read returns nothing — so allow signed-in users to read their OWN profile.
-- (The backend still uses the service-role key and is unaffected by this.)
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);
-- ============================================================


-- ============================================================
-- Plan limits — run separately
-- Free/Pro plan split + 7-day welcome-week trial. Run once in the Supabase
-- SQL editor when enabling plan limits. Safe to re-run (idempotent).
-- ============================================================

-- Welcome week: track when the user's trial ends (set at signup).
alter table public.profiles add column if not exists trial_ends_at timestamptz;

-- Backfill existing users: no trial (they're past it).
update public.profiles set trial_ends_at = now() - interval '1 day'
where trial_ends_at is null;

-- New user trigger: give a 7-day trial from signup. Replaces the earlier
-- handle_new_user() so new profiles also get trial_ends_at.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, trial_ends_at)
  values (new.id, now() + interval '7 days')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Text processing quota table (per-user, per-UTC-day counter).
create table if not exists public.text_processing_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- Locked down like the other usage tables: backend uses the service-role key
-- (bypasses RLS); browsers get no direct access.
alter table public.text_processing_usage enable row level security;

-- Atomic increment used by /api/check-text-quota.
create or replace function public.increment_text_usage(p_user_id uuid, p_day date)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.text_processing_usage (user_id, day, count)
  values (p_user_id, p_day, 1)
  on conflict (user_id, day)
  do update set count = public.text_processing_usage.count + 1;
end;
$$;
-- ============================================================
