-- Migration 0012: add retry lineage columns to runs table.
-- retry_of_run_id: the original run that triggered this retry
-- retry_attempt:   0-based attempt index (0 = original run, 1 = first retry, ...)

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS retry_of_run_id TEXT,
    ADD COLUMN IF NOT EXISTS retry_attempt    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS runs_retry_of_run_id_idx
    ON public.runs (retry_of_run_id)
    WHERE retry_of_run_id IS NOT NULL;
