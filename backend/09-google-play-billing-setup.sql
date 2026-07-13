-- Google Play Billing support for Android subscriptions.
-- Run this in Supabase before enabling Google Play purchases in production.

alter table public.profiles add column if not exists plan_ends_at timestamptz;
alter table public.profiles add column if not exists plan_provider text;

create table if not exists public.google_play_purchases (
  purchase_token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  order_id text,
  package_name text not null,
  tier text not null check (tier in ('monthly', 'annual')),
  subscription_state text,
  expires_at timestamptz not null,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists google_play_purchases_user_idx
  on public.google_play_purchases (user_id, expires_at desc);

alter table public.google_play_purchases enable row level security;

drop policy if exists "read own google play purchases" on public.google_play_purchases;
create policy "read own google play purchases"
  on public.google_play_purchases
  for select
  using (auth.uid() = user_id);

create or replace function public.touch_google_play_purchase_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists google_play_purchases_updated_at on public.google_play_purchases;
create trigger google_play_purchases_updated_at
before update on public.google_play_purchases
for each row
execute function public.touch_google_play_purchase_updated_at();
