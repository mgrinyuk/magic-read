-- Magic Read — bug reports and deck share links
-- Safe to re-run (idempotent). Run in Supabase → SQL Editor.
--
-- Both tables are server-only: row level security is on with no policies, so
-- the app's public key can't read or write them. Only the backend (service
-- role) touches them.

-- Reports sent from "Report a bug" in the account menu. Each one is also
-- emailed to support; `emailed` records whether that worked.
create table if not exists public.bug_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  email      text,
  message    text not null,
  context    jsonb not null default '{}'::jsonb,
  emailed    boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.bug_reports enable row level security;
revoke all on public.bug_reports from anon, authenticated;

-- One share link per deck. Deleting the row ("Stop sharing") or the deck
-- turns the link off.
create table if not exists public.deck_shares (
  token      text primary key,
  deck_id    uuid not null unique references public.flashcard_decks(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.deck_shares enable row level security;
revoke all on public.deck_shares from anon, authenticated;

-- Check: both tables exist with RLS on and no access for the public roles.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'select') as anon_can_read,
  has_table_privilege('authenticated', c.oid, 'select') as users_can_read
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('bug_reports', 'deck_shares');
