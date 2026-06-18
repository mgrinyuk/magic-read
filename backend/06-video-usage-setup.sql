-- Tracks the total number of videos a user has opened (lifetime, not per-day).
-- Trial users are capped at FREE_VIDEO_TRIAL_LIMIT total opens.
create table if not exists public.video_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  opens   int  not null default 0,
  primary key (user_id)
);

-- Allow the backend (service role) to read and write.
-- No user-facing RLS policy — managed exclusively via supabaseAdmin.
alter table public.video_usage enable row level security;
