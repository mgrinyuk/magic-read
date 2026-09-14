-- Magic Read — free plan v2
-- Safe to re-run (idempotent). Run in Supabase → SQL Editor before the
-- backend update goes live.
--
-- Free plan (after the Pro trial): one text a day with listening, translations
-- and reading exercises. Speaking practice, videos, flashcards and saved texts
-- are Pro. The backend constants in server.js mirror these numbers.

-- 1 ── New sign-ups get a 3-day Pro trial (was 7). Existing trials keep
--      their end date.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, trial_ends_at)
  values (new.id, now() + interval '3 days')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 2 ── Remember which texts were opened each day, so reopening the day's
--      text doesn't count twice.
alter table public.text_processing_usage
  add column if not exists text_keys text[] not null default '{}';

-- 3 ── Database-level caps for free users. The app writes saved texts, decks
--      and cards straight to these tables, so the rules live here too:
--      no new saved texts or cards, and one deck (the default deck every
--      account gets). Existing rows are never touched.
create or replace function public.enforce_free_saved_text_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  raise exception 'FREE_PLAN: saving texts is a Pro feature';
end;
$$;

create or replace function public.enforce_free_deck_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  if (select count(*) from public.flashcard_decks where user_id = new.user_id) >= 1 then
    raise exception 'FREE_PLAN: flashcard decks are a Pro feature';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_free_card_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  raise exception 'FREE_PLAN: flashcards are a Pro feature';
end;
$$;

-- Check: every row should say true.
select
  pg_get_functiondef('public.handle_new_user'::regproc) like '%3 days%' as trial_is_3_days,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'text_processing_usage' and column_name = 'text_keys'
  ) as text_keys_column_added,
  pg_get_functiondef('public.enforce_free_card_cap'::regproc) like '%Pro feature%' as card_cap_updated,
  exists (select 1 from pg_trigger where tgname = 'trg_free_card_cap') as card_trigger_active;
