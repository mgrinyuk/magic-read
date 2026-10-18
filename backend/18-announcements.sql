-- Magic Read — in-app messages ("announcements")
-- Written from the admin dashboard, shown once per device as a card in the
-- apps and on the website. Safe to re-run.
--
-- Only the backend touches this table (service role, behind ADMIN_SECRET for
-- writes and a signed-in user for reads), so RLS is on with no policies:
-- the REST API gives anon and signed-in users nothing.
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 600),
  -- Button: label plus what it does — "update" (App Store / Play listing),
  -- a screen ("read", "cards", "video", "home") or an https:// link.
  cta_label text check (char_length(cta_label) <= 40),
  cta_action text check (
    cta_action is null
    or cta_action in ('update', 'read', 'cards', 'video', 'home')
    or cta_action like 'https://%'
  ),
  -- Who sees it. platform: all, app (both stores), ios, android, web.
  platform text not null default 'all'
    check (platform in ('all', 'app', 'ios', 'android', 'web')),
  -- App UI language (en, ru, zh, …); null = every language.
  ui_lang text check (ui_lang is null or ui_lang ~ '^[a-z]{2}$'),
  -- Only app versions older than this see it (e.g. '1.0.5' for "please
  -- update"); null = every version. Ignored on the website.
  below_version text check (below_version is null or below_version ~ '^\d+(\.\d+){0,3}$'),
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists announcements_live_idx
  on public.announcements (active, starts_at desc);

alter table public.announcements enable row level security;
revoke all on public.announcements from anon, authenticated;
