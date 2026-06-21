-- T-Bank one-time Pro payments (30 / 365 days).
-- Run once in Supabase SQL Editor before testing a payment.

alter table public.profiles add column if not exists plan_ends_at timestamptz;
alter table public.profiles add column if not exists plan_provider text;

update public.profiles
set plan_provider = 'stripe'
where plan = 'pro' and plan_ends_at is null and plan_provider is null;

create table if not exists public.tbank_payments (
  payment_id text primary key,
  order_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null check (plan_code in ('monthly', 'annual')),
  amount bigint not null,
  status text not null default 'CONFIRMED',
  created_at timestamptz not null default now()
);

alter table public.tbank_payments enable row level security;

create or replace function public.apply_tbank_payment(
  p_user_id uuid,
  p_payment_id text,
  p_order_id text,
  p_plan_code text,
  p_amount bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
  v_interval interval;
  v_unlimited boolean;
begin
  if p_plan_code = 'monthly' and p_amount = 60000 then
    v_interval := interval '30 days';
  elsif p_plan_code = 'annual' and p_amount = 500000 then
    v_interval := interval '365 days';
  else
    raise exception 'Invalid T-Bank plan or amount';
  end if;

  insert into public.tbank_payments (payment_id, order_id, user_id, plan_code, amount)
  values (p_payment_id, p_order_id, p_user_id, p_plan_code, p_amount)
  on conflict (payment_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  select plan = 'pro' and plan_ends_at is null
    into v_unlimited
  from public.profiles
  where id = p_user_id
  for update;
  if not found then
    raise exception 'Profile not found';
  end if;

  update public.profiles
  set plan = 'pro',
      plan_provider = case when v_unlimited then plan_provider else 'tbank' end,
      plan_ends_at = case
        when v_unlimited then null
        else greatest(coalesce(plan_ends_at, now()), now()) + v_interval
      end
  where id = p_user_id;

  return true;
end;
$$;

revoke all on function public.apply_tbank_payment(uuid, text, text, text, bigint) from public;
grant execute on function public.apply_tbank_payment(uuid, text, text, text, bigint) to service_role;
