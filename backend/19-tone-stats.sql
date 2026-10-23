-- Magic Read — Tone Gym: per-learner tone results ("tone map")
-- One row per learner, skill and tone or tone pair, holding a running count
-- and score total; the app shows the average. Scores only, no audio or text.
-- Safe to re-run.
--
--   skill:    'say' (scored speech) or 'ear' (listening game)
--   tone_key: '3' for a single syllable's tone, '3-1' for two neighbouring
--             syllables in one word (tone 5 = neutral)
create table if not exists public.tone_stats (
  user_id uuid not null references auth.users (id) on delete cascade,
  skill text not null check (skill in ('say', 'ear')),
  tone_key text not null check (tone_key ~ '^[1-5](-[1-5])?$'),
  attempts integer not null default 0,
  score_sum real not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, skill, tone_key)
);

alter table public.tone_stats enable row level security;

-- Learners read and write only their own rows (the app writes through
-- record_tone_results, which runs with the learner's rights).
drop policy if exists "Read own tone stats" on public.tone_stats;
create policy "Read own tone stats" on public.tone_stats
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Add own tone stats" on public.tone_stats;
create policy "Add own tone stats" on public.tone_stats
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "Update own tone stats" on public.tone_stats;
create policy "Update own tone stats" on public.tone_stats
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Explicit grants (Supabase stops auto-granting new tables on 2026-10-30).
revoke all on public.tone_stats from anon, authenticated;
grant select, insert, update on public.tone_stats to authenticated;
grant select, insert, update, delete on public.tone_stats to service_role;

-- Adds a batch of results for the signed-in learner:
--   [{"skill":"say","key":"3-1","score":72}, ...]
-- Same-key items in one batch are summed first (ON CONFLICT can't touch a
-- row twice). Scores are clamped to 0–100; unknown skills/keys are dropped.
create or replace function public.record_tone_results(results jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.tone_stats (user_id, skill, tone_key, attempts, score_sum, updated_at)
  select auth.uid(), r.skill, r.key, count(*), sum(least(greatest(r.score, 0), 100)), now()
  from jsonb_to_recordset(coalesce(results, '[]'::jsonb)) as r(skill text, key text, score real)
  where auth.uid() is not null
    and r.skill in ('say', 'ear')
    and r.key ~ '^[1-5](-[1-5])?$'
    and r.score is not null
  group by r.skill, r.key
  on conflict (user_id, skill, tone_key) do update
    set attempts = tone_stats.attempts + excluded.attempts,
        score_sum = tone_stats.score_sum + excluded.score_sum,
        updated_at = now();
$$;

revoke execute on function public.record_tone_results(jsonb) from public, anon;
grant execute on function public.record_tone_results(jsonb) to authenticated;
