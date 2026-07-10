-- ============================================================
-- Server-side abuse caps — run once in the Supabase SQL editor.
-- Safe to re-run (idempotent).
--
-- 1. api_usage: per-user per-day counters for billed third-party
--    APIs (Google TTS / Translate). Written only by the backend
--    (service role); RLS blocks direct client access.
-- 2. Free-tier caps enforced in the database itself, so direct
--    Supabase inserts can't bypass the app's quota checks:
--    saved_texts (5), flashcard_decks (2), flashcards (100).
--    Limits mirror the backend env defaults.
-- ============================================================

-- 1 ── API usage counters ────────────────────────────────────

create table if not exists public.api_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  kind    text not null,
  count   int  not null default 0,
  primary key (user_id, day, kind)
);

-- Service-role only: enable RLS and add no policies.
alter table public.api_usage enable row level security;

-- 2 ── Effective-plan helper (mirrors backend getUserPlan) ───

create or replace function public.is_effective_pro(uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid
      and (
        -- paid pro: lifetime provider, no end date, or end date in the future
        (p.plan = 'pro' and (
          coalesce(p.plan_provider, '') in ('lifetime', 'forever')
          or p.plan_ends_at is null
          or p.plan_ends_at > now()
        ))
        -- or still inside the welcome-week trial
        or (p.trial_ends_at is not null and p.trial_ends_at > now())
      )
  );
$$;

-- 3 ── Free-tier caps as insert triggers ─────────────────────

create or replace function public.enforce_free_saved_text_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  if (select count(*) from public.saved_texts where user_id = new.user_id) >= 5 then
    raise exception 'FREE_SAVED_TEXT_LIMIT reached (5)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_free_saved_text_cap on public.saved_texts;
create trigger trg_free_saved_text_cap
  before insert on public.saved_texts
  for each row execute function public.enforce_free_saved_text_cap();

create or replace function public.enforce_free_deck_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  if (select count(*) from public.flashcard_decks where user_id = new.user_id) >= 2 then
    raise exception 'FREE_DECK_LIMIT reached (2)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_free_deck_cap on public.flashcard_decks;
create trigger trg_free_deck_cap
  before insert on public.flashcard_decks
  for each row execute function public.enforce_free_deck_cap();

create or replace function public.enforce_free_card_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  if (select count(*) from public.flashcards where user_id = new.user_id) >= 100 then
    raise exception 'FREE_CARD_LIMIT reached (100)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_free_card_cap on public.flashcards;
create trigger trg_free_card_cap
  before insert on public.flashcards
  for each row execute function public.enforce_free_card_cap();
