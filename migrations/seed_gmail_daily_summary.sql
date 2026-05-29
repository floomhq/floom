-- Seed: re-create the gmail-daily-summary demo worker in fede's default
-- workspace ("fede", ws_58809194a2714f5). It was deleted during earlier
-- delete-worker UI testing, so fede's default workspace lost its original
-- demo worker. This restores it.
--
-- Target user:        7f20f991-d018-49e1-9fd1-858f68f8c773  (fede@rocketlist.ai)
-- Target workspace:   ws_58809194a2714f5  ("fede", fede's default workspace)
--
-- Standalone-OpenAI pattern (same as morning-brief / job-digest seeds): the
-- SKILL.md drafts a summary via OpenAI only, with NO real Gmail OAuth
-- dependency, so it runs in the demo without any connected Gmail account.
--
-- Idempotent: skill_versions uses ON CONFLICT DO UPDATE (so re-runs pick up
-- manifest tweaks); workers uses ON CONFLICT DO NOTHING; runs/run_logs guard
-- with WHERE NOT EXISTS / EXISTS so re-running is a no-op.
--
-- Bundle filesystem layout (read by the engine via skill_versions.bundle_path)
-- must exist on disk before this seed is meaningful at runtime:
--   /opt/workeros-cloud/var/workers/gmail-daily-summary/
--
-- This seed only writes DB rows; bundle files ship under
-- var/workers/gmail-daily-summary/ in this repo and are synced to
-- /opt/workeros-cloud/var/workers/ during deploy.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Skill version (maps to the on-disk bundle).
-- ---------------------------------------------------------------------------

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_gmail-daily-summary_0_1_0',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'gmail-daily-summary',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'gmail-daily-summary',
    'title', 'Gmail Daily Summary',
    'description', 'Summarise the day''s unread Gmail into a tight digest every morning at 8am Berlin time.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'focus_topic',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Focus Topic',
        'default', 'unread email: senders, what they need, and what to action first'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'summary',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/summary.md',
        'required', true,
        'label', 'Daily Email Summary'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 8 * * *',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/gmail-daily-summary',
  TIMESTAMPTZ '2026-05-29 08:40:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

-- ---------------------------------------------------------------------------
-- 2. Worker row (scoped to fede's default "fede" workspace).
-- ---------------------------------------------------------------------------

INSERT INTO workers (
  id, user_id, skill_version_id, name,
  trigger_type, cron_expr, cron_timezone,
  enabled, workspace_id, created_at,
  grants_json, input_values_json, triggers_json, notify_email
)
VALUES (
  'gmail-daily-summary',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'sv_gmail-daily-summary_0_1_0',
  'Gmail Daily Summary',
  'schedule', '0 8 * * *', 'Europe/Berlin',
  TRUE, 'ws_58809194a2714f5', TIMESTAMPTZ '2026-05-29 08:41:00+00',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Runs: 3 completed daily runs (May 28/27/26) for realism.
--    Guarded with WHERE NOT EXISTS so re-runs are no-ops.
-- ---------------------------------------------------------------------------

INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
SELECT * FROM (VALUES
  ('run_seed_fede_gds_001'::text, '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'gmail-daily-summary'::text, 'ws_58809194a2714f5'::text,
   'completed'::text, 'schedule'::text, 'skill'::text,
   '{"focus_topic": "unread email: senders, what they need, and what to action first"}'::jsonb,
   '{"summary": "out/summary.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-28 06:00:02+00', TIMESTAMPTZ '2026-05-28 06:00:11+00', 8932, NULL::text,
   TIMESTAMPTZ '2026-05-28 06:00:00+00'),
  ('run_seed_fede_gds_002', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'gmail-daily-summary', 'ws_58809194a2714f5',
   'completed', 'schedule', 'skill',
   '{"focus_topic": "unread email: senders, what they need, and what to action first"}'::jsonb,
   '{"summary": "out/summary.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-27 06:00:01+00', TIMESTAMPTZ '2026-05-27 06:00:10+00', 8401, NULL,
   TIMESTAMPTZ '2026-05-27 06:00:00+00'),
  ('run_seed_fede_gds_003', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'gmail-daily-summary', 'ws_58809194a2714f5',
   'completed', 'schedule', 'skill',
   '{"focus_topic": "unread email: senders, what they need, and what to action first"}'::jsonb,
   '{"summary": "out/summary.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-26 06:00:02+00', TIMESTAMPTZ '2026-05-26 06:00:12+00', 9120, NULL,
   TIMESTAMPTZ '2026-05-26 06:00:00+00')
) AS v(id, user_id, worker_id, workspace_id, status, trigger_source, runner,
       input_json, output_json, started_at, completed_at, duration_ms, error, created_at)
WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = v.id);

-- ---------------------------------------------------------------------------
-- 4. Run logs: 5 representative lines per seeded run (all completed).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  run_rec RECORD;
BEGIN
  FOR run_rec IN
    SELECT id, started_at, status, error
    FROM runs
    WHERE id LIKE 'run_seed_fede_gds_%'
      AND user_id = '7f20f991-d018-49e1-9fd1-858f68f8c773'
  LOOP
    IF EXISTS (
      SELECT 1 FROM run_logs
      WHERE run_id = run_rec.id
        AND user_id = '7f20f991-d018-49e1-9fd1-858f68f8c773'
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO run_logs (user_id, run_id, level, message, timestamp)
    VALUES
      ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
       'Run accepted; preparing sandbox.', run_rec.started_at),
      ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
       'Validated inputs against worker manifest.', run_rec.started_at + interval '1 second'),
      ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
       'Agent step started: drafting output via OpenAI.', run_rec.started_at + interval '2 seconds'),
      ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
       'Output written successfully.', run_rec.started_at + interval '7 seconds'),
      ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
       'Run completed.', run_rec.started_at + interval '8 seconds');
  END LOOP;
END $$;

COMMIT;
