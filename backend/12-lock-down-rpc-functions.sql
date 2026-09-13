-- ============================================================
-- Lock down RPC functions — Supabase setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL).
-- Safe to re-run (idempotent). Run it BEFORE 11-activity-days-setup.sql.
--
-- Supabase grants EXECUTE on public functions to the anon and authenticated
-- roles. Those are the roles behind the PUBLIC key shipped in the website and
-- apps, so until now anyone could call:
--   • apply_tbank_payment           — grants Pro without a payment
--   • record_activity               — rewrites any user's word counts and streak
--   • increment_pronunciation_usage — burns a free user's daily check quota
--   • increment_text_usage          — same for the daily text quota
--   • is_effective_pro              — reveals whether a user id is Pro
--
-- Nothing breaks: the apps never call RPCs directly; the backend calls the
-- first four with the service-role key; the free-limit triggers that use
-- is_effective_pro are SECURITY DEFINER, so they run with the owner's rights.
--
-- 07-tbank-payments-setup.sql only revoked from PUBLIC, which does not remove
-- the separate grants Supabase gives anon and authenticated.
-- ============================================================

-- 1) Revoke client access on every overload of these functions.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('apply_tbank_payment', 'record_activity',
                        'increment_pronunciation_usage', 'increment_text_usage',
                        'is_effective_pro')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- 2) Future functions created from the SQL editor no longer become callable by
--    the public key automatically. A function meant for the apps now needs an
--    explicit `grant execute ... to authenticated`.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- 3) Verify: every row should read anon = false, authenticated = false,
--    service_role = true.
select p.oid::regprocedure                                     as function,
       has_function_privilege('anon',          p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('apply_tbank_payment', 'record_activity',
                    'increment_pronunciation_usage', 'increment_text_usage',
                    'is_effective_pro')
order by 1;
