-- 0007: parity with engine's runs columns (error_code, quality_warning, artifacts_archived)
-- Engine PRs 164/167 added these to its sqlite migrations; cloud's Supabase was missing them.
-- Without them, SupabaseRunRepository.update_status raised TypeError on kwargs the engine passes,
-- the run thread silently crashed, and runs stayed stuck in 'queued' forever (API-11 / #43).

BEGIN;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS quality_warning text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS artifacts_archived boolean NOT NULL DEFAULT false;

COMMIT;
