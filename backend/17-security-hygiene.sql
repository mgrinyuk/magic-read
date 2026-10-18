-- Magic Read — security hygiene from the Supabase advisor
-- Applied 2026-10-18 through the Supabase connector. Safe to re-run.
--
-- Trigger functions were callable through the REST API by anon and signed-in
-- users. Postgres refuses to run a trigger function outside a trigger, so this
-- wasn't exploitable, but nothing outside the triggers should hold EXECUTE.
-- Triggers keep firing: EXECUTE is checked when a trigger is created, not each
-- time it runs.
revoke execute on function public.enforce_free_card_cap(), public.enforce_free_deck_cap(),
  public.enforce_free_saved_text_cap(), public.handle_new_user()
  from public, anon, authenticated;

-- Pin the search path on the purchase timestamp triggers, like every other
-- function in this schema.
alter function public.touch_apple_purchase_updated_at() set search_path = public;
alter function public.touch_google_play_purchase_updated_at() set search_path = public;
