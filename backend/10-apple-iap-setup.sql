-- Apple In-App Purchase support for iOS subscriptions.
-- Run this in Supabase before enabling Apple purchases in production.
-- (plan_ends_at / plan_provider already added by 09-google-play-billing-setup.sql;
--  the ADDs below are idempotent in case this runs first.)

alter table public.profiles add column if not exists plan_ends_at timestamptz;
alter table public.profiles add column if not exists plan_provider text;

create table if not exists public.apple_purchases (
  original_transaction_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  tier text not null check (tier in ('monthly', 'annual')),
  environment text not null check (environment in ('production', 'sandbox')),
  status text,
  expires_at timestamptz not null,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists apple_purchases_user_idx
  on public.apple_purchases (user_id, expires_at desc);

alter table public.apple_purchases enable row level security;

drop policy if exists "read own apple purchases" on public.apple_purchases;
create policy "read own apple purchases"
  on public.apple_purchases
  for select
  using (auth.uid() = user_id);

create or replace function public.touch_apple_purchase_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists apple_purchases_updated_at on public.apple_purchases;
create trigger apple_purchases_updated_at
before update on public.apple_purchases
for each row
execute function public.touch_apple_purchase_updated_at();
