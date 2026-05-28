-- Seed: populate depontefede@gmail.com's dashboard with 3 demo workers + run history.
--
-- Target user:       bddb90c9-f653-42a0-b78d-4c80595d6fb9  (depontefede@gmail.com)
-- Target workspace:  ws_aac663b43cb542                     ("depontefede")
--
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING (or DO UPDATE for skill
-- version manifests so a bumped seed re-runs cleanly). Re-running this script
-- against a database already seeded is a no-op.
--
-- Bundle filesystem layout (read by the engine via skill_versions.bundle_path)
-- must exist on disk before this seed is meaningful at runtime:
--   /opt/workeros-cloud/var/workers/morning-brief/
--   /opt/workeros-cloud/var/workers/slack-weekly-recap/
--   /opt/workeros-cloud/var/workers/meeting-prep/
--
-- This seed only writes DB rows; bundle files ship under var/workers/* in this
-- repo and are synced to /opt/workeros-cloud/var/workers/ during deploy.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Skill versions (one per worker; each maps to an on-disk bundle).
-- ---------------------------------------------------------------------------

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_morning-brief_0_1_0',
  'bddb90c9-f653-42a0-b78d-4c80595d6fb9',
  'morning-brief',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'morning-brief',
    'title', 'Morning Brief',
    'description', 'Draft a concise 3-bullet morning brief every weekday at 8am Berlin time.',
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
        'default', 'your day ahead: priorities, risks, one quick win'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'brief',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/brief.md',
        'required', true,
        'label', 'Morning Brief'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 8 * * *',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/morning-brief',
  TIMESTAMPTZ '2026-05-20 09:00:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_slack-weekly-recap_0_1_0',
  'bddb90c9-f653-42a0-b78d-4c80595d6fb9',
  'slack-weekly-recap',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'slack-weekly-recap',
    'title', 'Slack Weekly Recap',
    'description', 'Generate a Friday-afternoon recap of the week''s themes for a Slack channel digest.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'channel_topic',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Channel Topic',
        'default', 'engineering team weekly themes, shipped work, blockers, next-week focus'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'recap',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/recap.md',
        'required', true,
        'label', 'Weekly Recap'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 17 * * 5',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/slack-weekly-recap',
  TIMESTAMPTZ '2026-05-20 09:00:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_meeting-prep_0_1_0',
  'bddb90c9-f653-42a0-b78d-4c80595d6fb9',
  'meeting-prep',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'meeting-prep',
    'title', 'Meeting Prep',
    'description', 'On-demand pre-meeting brief: agenda, talking points, decisions to land.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'meeting_title',
        'kind', 'scalar',
        'type', 'string',
        'required', true,
        'label', 'Meeting Title'
      ),
      jsonb_build_object(
        'name', 'meeting_context',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Context',
        'default', 'general check-in'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'prep_doc',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/prep.md',
        'required', true,
        'label', 'Prep Doc'
      )
    ),
    'trigger', jsonb_build_object('type', 'manual')
  ),
  '/opt/workeros-cloud/var/workers/meeting-prep',
  TIMESTAMPTZ '2026-05-20 09:00:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

-- ---------------------------------------------------------------------------
-- 2. Workers (one per skill version).
-- ---------------------------------------------------------------------------

INSERT INTO workers (
  id, user_id, skill_version_id, name,
  trigger_type, cron_expr, cron_timezone,
  enabled, workspace_id, created_at,
  grants_json, input_values_json, triggers_json, notify_email
)
VALUES (
  'morning-brief',
  'bddb90c9-f653-42a0-b78d-4c80595d6fb9',
  'sv_morning-brief_0_1_0',
  'Morning Brief',
  'schedule', '0 8 * * *', 'Europe/Berlin',
  TRUE, 'ws_aac663b43cb542', TIMESTAMPTZ '2026-05-20 09:05:00+00',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workers (
  id, user_id, skill_version_id, name,
  trigger_type, cron_expr, cron_timezone,
  enabled, workspace_id, created_at,
  grants_json, input_values_json, triggers_json, notify_email
)
VALUES (
  'slack-weekly-recap',
  'bddb90c9-f653-42a0-b78d-4c80595d6fb9',
  'sv_slack-weekly-recap_0_1_0',
  'Slack Weekly Recap',
  'schedule', '0 17 * * 5', 'Europe/Berlin',
  TRUE, 'ws_aac663b43cb542', TIMESTAMPTZ '2026-05-20 09:06:00+00',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workers (
  id, user_id, skill_version_id, name,
  trigger_type, cron_expr, cron_timezone,
  enabled, workspace_id, created_at,
  grants_json, input_values_json, triggers_json, notify_email
)
VALUES (
  'meeting-prep',
  'bddb90c9-f653-42a0-b78d-4c80595d6fb9',
  'sv_meeting-prep_0_1_0',
  'Meeting Prep',
  'manual', NULL, NULL,
  TRUE, 'ws_aac663b43cb542', TIMESTAMPTZ '2026-05-20 09:07:00+00',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Runs: realistic recent history (mix of completed + one failed).
--
-- Times are anchored relative to today (2026-05-28 Europe/Berlin) by
-- referencing fixed timestamps so the seed is deterministic across re-runs.
-- ---------------------------------------------------------------------------

-- morning-brief: today + yesterday + two days ago + one failed last week
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
VALUES
  ('run_seed_mb_001', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'morning-brief', 'ws_aac663b43cb542',
   'completed', 'schedule', 'skill',
   '{"focus_topic": "your day ahead: priorities, risks, one quick win"}'::jsonb,
   '{"brief": "out/brief.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-28 06:00:02+00', TIMESTAMPTZ '2026-05-28 06:00:11+00', 8912, NULL,
   TIMESTAMPTZ '2026-05-28 06:00:00+00'),
  ('run_seed_mb_002', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'morning-brief', 'ws_aac663b43cb542',
   'completed', 'schedule', 'skill',
   '{"focus_topic": "your day ahead: priorities, risks, one quick win"}'::jsonb,
   '{"brief": "out/brief.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-27 06:00:02+00', TIMESTAMPTZ '2026-05-27 06:00:10+00', 7741, NULL,
   TIMESTAMPTZ '2026-05-27 06:00:00+00'),
  ('run_seed_mb_003', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'morning-brief', 'ws_aac663b43cb542',
   'completed', 'schedule', 'skill',
   '{"focus_topic": "your day ahead: priorities, risks, one quick win"}'::jsonb,
   '{"brief": "out/brief.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-26 06:00:01+00', TIMESTAMPTZ '2026-05-26 06:00:09+00', 8204, NULL,
   TIMESTAMPTZ '2026-05-26 06:00:00+00'),
  ('run_seed_mb_004', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'morning-brief', 'ws_aac663b43cb542',
   'failed', 'schedule', 'skill',
   '{"focus_topic": "your day ahead: priorities, risks, one quick win"}'::jsonb,
   '{}'::jsonb,
   TIMESTAMPTZ '2026-05-22 06:00:02+00', TIMESTAMPTZ '2026-05-22 06:00:04+00', 1903,
   'OpenAI quota exceeded: please check billing or rotate the workspace key.',
   TIMESTAMPTZ '2026-05-22 06:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- slack-weekly-recap: two completed (last two Fridays)
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
VALUES
  ('run_seed_sw_001', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'slack-weekly-recap', 'ws_aac663b43cb542',
   'completed', 'schedule', 'skill',
   '{"channel_topic": "engineering team weekly themes, shipped work, blockers, next-week focus"}'::jsonb,
   '{"recap": "out/recap.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-23 15:00:03+00', TIMESTAMPTZ '2026-05-23 15:00:14+00', 11042, NULL,
   TIMESTAMPTZ '2026-05-23 15:00:00+00'),
  ('run_seed_sw_002', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'slack-weekly-recap', 'ws_aac663b43cb542',
   'completed', 'schedule', 'skill',
   '{"channel_topic": "engineering team weekly themes, shipped work, blockers, next-week focus"}'::jsonb,
   '{"recap": "out/recap.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-16 15:00:02+00', TIMESTAMPTZ '2026-05-16 15:00:12+00', 9871, NULL,
   TIMESTAMPTZ '2026-05-16 15:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- meeting-prep: 3 manual runs across the last 10 days
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
VALUES
  ('run_seed_mp_001', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'meeting-prep', 'ws_aac663b43cb542',
   'completed', 'manual', 'skill',
   '{"meeting_title": "Investor sync - Series A bridge", "meeting_context": "Updates on traction + ARR trajectory."}'::jsonb,
   '{"prep_doc": "out/prep.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-27 13:14:08+00', TIMESTAMPTZ '2026-05-27 13:14:19+00', 10602, NULL,
   TIMESTAMPTZ '2026-05-27 13:14:00+00'),
  ('run_seed_mp_002', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'meeting-prep', 'ws_aac663b43cb542',
   'completed', 'manual', 'skill',
   '{"meeting_title": "Design review - dashboard v2", "meeting_context": "Final pass before ship."}'::jsonb,
   '{"prep_doc": "out/prep.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-24 10:22:01+00', TIMESTAMPTZ '2026-05-24 10:22:10+00', 8420, NULL,
   TIMESTAMPTZ '2026-05-24 10:22:00+00'),
  ('run_seed_mp_003', 'bddb90c9-f653-42a0-b78d-4c80595d6fb9', 'meeting-prep', 'ws_aac663b43cb542',
   'completed', 'manual', 'skill',
   '{"meeting_title": "1:1 with new hire", "meeting_context": "Week 2 check-in."}'::jsonb,
   '{"prep_doc": "out/prep.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-19 16:00:01+00', TIMESTAMPTZ '2026-05-19 16:00:09+00', 7903, NULL,
   TIMESTAMPTZ '2026-05-19 16:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Run logs: a few representative lines per run.
-- ---------------------------------------------------------------------------

-- Helper pattern: for each seed run, drop 5 standard log lines. Idempotent via
-- NOT EXISTS so re-running doesn't duplicate.
DO $$
DECLARE
  run_rec RECORD;
BEGIN
  FOR run_rec IN
    SELECT id, started_at, status, error
    FROM runs
    WHERE id LIKE 'run_seed_%'
      AND user_id = 'bddb90c9-f653-42a0-b78d-4c80595d6fb9'
  LOOP
    -- Skip if logs for this run already seeded
    IF EXISTS (
      SELECT 1 FROM run_logs
      WHERE run_id = run_rec.id
        AND user_id = 'bddb90c9-f653-42a0-b78d-4c80595d6fb9'
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO run_logs (user_id, run_id, level, message, timestamp)
    VALUES
      ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'info',
       'Run accepted; preparing sandbox.', run_rec.started_at),
      ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'info',
       'Validated inputs against worker manifest.', run_rec.started_at + interval '1 second'),
      ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'info',
       'Agent step started: drafting output via OpenAI.', run_rec.started_at + interval '2 seconds');

    IF run_rec.status = 'completed' THEN
      INSERT INTO run_logs (user_id, run_id, level, message, timestamp)
      VALUES
        ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'info',
         'Output written successfully.', run_rec.started_at + interval '7 seconds'),
        ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'info',
         'Run completed.', run_rec.started_at + interval '8 seconds');
    ELSIF run_rec.status = 'failed' THEN
      INSERT INTO run_logs (user_id, run_id, level, message, timestamp)
      VALUES
        ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'error',
         COALESCE(run_rec.error, 'Run failed.'), run_rec.started_at + interval '3 seconds'),
        ('bddb90c9-f653-42a0-b78d-4c80595d6fb9', run_rec.id, 'info',
         'Run marked failed; will retry on next schedule tick.', run_rec.started_at + interval '4 seconds');
    END IF;
  END LOOP;
END $$;

COMMIT;
