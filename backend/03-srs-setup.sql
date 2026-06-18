-- ============================================================
-- Flashcard SRS (spaced repetition) — Supabase setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL).
-- Safe to re-run (idempotent). Adds scheduling fields to flashcards.
-- The scheduling math lives in the app; this just stores the state.
-- ============================================================

-- Add SRS columns to the existing flashcards table.
-- (New cards have srs_due = null, which the app treats as "due now".)
alter table public.flashcards add column if not exists srs_ease          real        not null default 2.5;
alter table public.flashcards add column if not exists srs_interval      int         not null default 0;   -- days until next review
alter table public.flashcards add column if not exists srs_due           date;                              -- next review date; null = new/due now
alter table public.flashcards add column if not exists srs_reps          int         not null default 0;   -- successful reviews in a row
alter table public.flashcards add column if not exists srs_lapses        int         not null default 0;   -- times answered "Again"
alter table public.flashcards add column if not exists srs_last_reviewed timestamptz;

-- Index so "cards due today" queries are fast.
create index if not exists flashcards_srs_due_idx on public.flashcards (srs_due);
-- ============================================================
