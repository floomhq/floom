-- Migration 0049: formalize the runs.error_code column in the active lineage.
--
-- The Supabase repo (apps/api/db/supabase_repos.py) reads and writes
-- runs.error_code on every FAILED transition, and the failure taxonomy keys off
-- it. The column was added out-of-band (the stale top-level migrations/
-- 0007_runs_columns_parity.sql), but the canonical supabase/migrations lineage
-- (which 0001_init.sql baselines) never declared it — so a fresh/rebuilt DB
-- would lack the column and every FAILED write would error or silently drop the
-- value. Declare it here so the column is part of the tracked schema.
--
-- error_code carries a structured failure code (e.g. unknown_error,
-- missing_secret, worker_error); the engine and the cloud repo now guarantee a
-- non-null value on FAILED via _normalize_failed_error_fields. Left nullable so
-- non-FAILED runs (queued/running/completed) carry no code.

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS error_code text;
