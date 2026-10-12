-- Magic Read — flashcards for students on an assignment
-- Safe to re-run (idempotent). Run in Supabase → SQL Editor. Order doesn't
-- matter: until this runs, the backend simply refuses these cards as before.
--
-- A teacher sets a text; a student on the free plan who has joined it can now
-- keep the words they save from it. Vocabulary from the set reading is most of
-- what a language teacher wants out of the exercise, and the free plan
-- otherwise allows no cards at all.
--
-- The rule is "the word appears in the text of an open assignment this student
-- has joined". Tying it to the text, not just to being enrolled somewhere, stops
-- one joined link from unlocking unlimited cards for anything. Cards saved stay
-- after the teacher closes the assignment.

-- 1 ── The rule, in one place. The card trigger below and the backend's
--      /api/check-deck-quota both call this, so they can never disagree.
create or replace function public.assignment_allows_card(p_user_id uuid, p_word text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(length(trim(p_word)) between 1 and 80, false)
     and exists (
       select 1
       from public.assignment_students s
       join public.assignments a on a.id = s.assignment_id
       where s.student_id = p_user_id
         and a.closed_at is null
         and position(lower(trim(p_word)) in lower(a.text)) > 0
     );
$$;

-- Clients must not be able to probe other users' enrolments through it.
revoke execute on function public.assignment_allows_card(uuid, text) from public, anon, authenticated;
grant execute on function public.assignment_allows_card(uuid, text) to service_role;

-- 2 ── The free-plan card trigger, now with the assignment exception.
--      Pro and trial users are unaffected; everyone else is still refused.
create or replace function public.enforce_free_card_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_effective_pro(new.user_id) then return new; end if;
  if public.assignment_allows_card(new.user_id, new.word) then return new; end if;
  raise exception 'FREE_PLAN: flashcards are a Pro feature';
end;
$$;

-- Check: both should say true.
select
  exists (select 1 from pg_proc where proname = 'assignment_allows_card') as rule_function_exists,
  pg_get_functiondef('public.enforce_free_card_cap'::regproc) like '%assignment_allows_card%' as trigger_uses_rule;
