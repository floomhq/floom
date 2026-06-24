-- 0010: worker_triggers.locked_until parity with the engine scheduler.
-- The engine scheduler (engine/apps/api/scheduler.py) leases each due trigger via
-- claim_schedule_trigger(), which UPDATEs worker_triggers SET locked_until=...
-- WHERE locked_until IS NULL OR locked_until <= now. cloud's Supabase table was
-- missing the column, so EVERY claim raised PGRST204 ("Could not find the
-- locked_until column of worker_triggers in the schema cache") and NO scheduled
-- worker ever fired (#670). Same class as 0007 (engine added a column, cloud
-- Supabase migration lagged). Applied to prod manually 2026-06-24; this migration
-- is the durable source of truth + brings staging to parity.
BEGIN;

ALTER TABLE worker_triggers ADD COLUMN IF NOT EXISTS locked_until text;

COMMIT;
