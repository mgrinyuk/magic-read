-- Magic Read — class assignments (Stage 1)
-- Safe to re-run (idempotent). Run in Supabase → SQL Editor before the
-- backend update goes live.
--
-- A teacher (Pro or trial) turns a text into an assignment link. Students
-- join with a free account, read, do the exercises and say the text aloud;
-- their results come back to the teacher. All three tables are server-only:
-- row level security is on with no policies, so only the backend (service
-- role) can read or write them.

create table if not exists public.assignments (
  id                uuid primary key default gen_random_uuid(),
  token             text not null unique,
  teacher_id        uuid not null references auth.users(id) on delete cascade,
  title             text not null,
  source_lang       text not null,
  target_lang       text,
  text              text not null,
  sentences         jsonb not null,               -- ["sentence", ...] in reading order
  include_exercises boolean not null default true,
  due_date          date,
  max_students      int not null default 30,
  closed_at         timestamptz,                  -- set when the teacher closes it
  created_at        timestamptz not null default now()
);

create index if not exists assignments_teacher_idx
  on public.assignments (teacher_id, created_at desc);

create table if not exists public.assignment_students (
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  student_id    uuid not null references auth.users(id) on delete cascade,
  display_name  text not null,
  speech_checks int not null default 0,           -- speaking checks used on this assignment
  joined_at     timestamptz not null default now(),
  primary key (assignment_id, student_id)
);

create index if not exists assignment_students_student_idx
  on public.assignment_students (student_id, joined_at desc);

create table if not exists public.assignment_attempts (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null references public.assignments(id) on delete cascade,
  student_id      uuid not null references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('speaking', 'exercises')),
  score           int,                            -- speaking: overall 0–100; exercises: % correct
  sentence_scores jsonb,                          -- speaking: [0–100 | null, ...] per sentence
  correct         int,                            -- exercises only
  skipped         int,
  total           int,
  mistakes        int,
  created_at      timestamptz not null default now()
);

create index if not exists assignment_attempts_lookup_idx
  on public.assignment_attempts (assignment_id, student_id, created_at desc);

alter table public.assignments enable row level security;
alter table public.assignment_students enable row level security;
alter table public.assignment_attempts enable row level security;
revoke all on public.assignments from anon, authenticated;
revoke all on public.assignment_students from anon, authenticated;
revoke all on public.assignment_attempts from anon, authenticated;

-- Check: three rows, each with rls_enabled = true and both *_can_read = false.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'select') as anon_can_read,
  has_table_privilege('authenticated', c.oid, 'select') as users_can_read
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('assignments', 'assignment_students', 'assignment_attempts')
order by c.relname;
