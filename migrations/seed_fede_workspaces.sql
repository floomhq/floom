-- Seed: populate fede@rocketlist.ai with two themed workspaces (Rocketlist + Floom),
-- each with workers, runs, and run_logs, so he can switch between realistic
-- workspaces in the cloud dashboard.
--
-- Also cleans up: deletes ws_b82fe43a8e1743 ("Test 2"), a verification artifact
-- with no workers/runs/connections.
--
-- Target user:           7f20f991-d018-49e1-9fd1-858f68f8c773  (fede@rocketlist.ai)
-- New workspaces:        ws_c948858cba3938c  ("Rocketlist")
--                        ws_1893b8646e0a6e8  ("Floom")
-- Untouched:             ws_58809194a2714f5  ("fede", fede's default workspace)
-- Untouched:             ws_aac663b43cb542   ("depontefede")
-- Removed:               ws_b82fe43a8e1743   ("Test 2")
--
-- Idempotent: workspaces/workers/skill_versions use ON CONFLICT (skill_versions
-- DO UPDATE so re-runs pick up manifest tweaks; workspaces/workers DO NOTHING).
-- runs/run_logs guard with WHERE NOT EXISTS / NOT EXISTS so re-running this
-- script against a database already seeded is a no-op.
--
-- Bundle filesystem layout (read by the engine via skill_versions.bundle_path)
-- must exist on disk before this seed is meaningful at runtime:
--   /opt/workeros-cloud/var/workers/job-digest/
--   /opt/workeros-cloud/var/workers/applicant-followup/
--   /opt/workeros-cloud/var/workers/hiring-pulse/
--   /opt/workeros-cloud/var/workers/skill-quality-audit/
--   /opt/workeros-cloud/var/workers/community-digest/
--
-- This seed only writes DB rows; bundle files ship under var/workers/* in this
-- repo and are synced to /opt/workeros-cloud/var/workers/ during deploy.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Cleanup: drop the empty verification workspace before adding the new ones.
--    Guarded by EXISTS so re-running after the row is gone is a no-op. The
--    "Test 2" workspace was created as a verification artifact during
--    workspace-switcher v1 rollout and has zero workers/runs/connections.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  target_ws CONSTANT text := 'ws_b82fe43a8e1743';
  target_owner CONSTANT uuid := '7f20f991-d018-49e1-9fd1-858f68f8c773';
BEGIN
  DELETE FROM workspaces
  WHERE id = target_ws
    AND owner_user_id = target_owner
    AND NOT EXISTS (SELECT 1 FROM workers WHERE workspace_id = target_ws)
    AND NOT EXISTS (SELECT 1 FROM runs WHERE workspace_id = target_ws)
    AND NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = target_ws)
    AND NOT EXISTS (SELECT 1 FROM secrets WHERE workspace_id = target_ws);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Workspaces (Rocketlist + Floom).
-- ---------------------------------------------------------------------------

INSERT INTO workspaces (id, owner_user_id, name, created_at)
VALUES
  ('ws_c948858cba3938c', '7f20f991-d018-49e1-9fd1-858f68f8c773', 'Rocketlist',
   TIMESTAMPTZ '2026-05-29 08:00:00+00'),
  ('ws_1893b8646e0a6e8', '7f20f991-d018-49e1-9fd1-858f68f8c773', 'Floom',
   TIMESTAMPTZ '2026-05-29 08:05:00+00')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Skill versions (one per worker; each maps to an on-disk bundle).
-- ---------------------------------------------------------------------------

-- Rocketlist workers ---------------------------------------------------------

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_job-digest_0_1_0',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'job-digest',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'job-digest',
    'title', 'Job Digest',
    'description', 'Daily summary of new tech jobs added to Rocketlist.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'focus_segment',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Focus Segment',
        'default', 'senior backend, ML, and infra roles at European startups'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'digest',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/digest.md',
        'required', true,
        'label', 'Job Digest'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 9 * * *',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/job-digest',
  TIMESTAMPTZ '2026-05-29 08:10:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_applicant-followup_0_1_0',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'applicant-followup',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'applicant-followup',
    'title', 'Applicant Followup',
    'description', 'Drafts a personalised follow-up email to a candidate based on a short CV summary.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'candidate_name',
        'kind', 'scalar',
        'type', 'string',
        'required', true,
        'label', 'Candidate Name'
      ),
      jsonb_build_object(
        'name', 'role_title',
        'kind', 'scalar',
        'type', 'string',
        'required', true,
        'label', 'Role Title'
      ),
      jsonb_build_object(
        'name', 'cv_summary',
        'kind', 'scalar',
        'type', 'string',
        'required', true,
        'label', 'CV Summary'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'email',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/email.md',
        'required', true,
        'label', 'Follow-up Email'
      )
    ),
    'trigger', jsonb_build_object('type', 'manual')
  ),
  '/opt/workeros-cloud/var/workers/applicant-followup',
  TIMESTAMPTZ '2026-05-29 08:11:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_hiring-pulse_0_1_0',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'hiring-pulse',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'hiring-pulse',
    'title', 'Hiring Pulse',
    'description', 'Weekly Monday-morning brief on European tech hiring trends.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'market_focus',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Market Focus',
        'default', 'European tech hiring across early-stage and growth-stage startups'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'pulse',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/pulse.md',
        'required', true,
        'label', 'Hiring Pulse'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 10 * * 1',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/hiring-pulse',
  TIMESTAMPTZ '2026-05-29 08:12:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

-- Floom workers --------------------------------------------------------------

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_skill-quality-audit_0_1_0',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'skill-quality-audit',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'skill-quality-audit',
    'title', 'Skill Quality Audit',
    'description', 'Weekly Friday review of submitted Floom skills for quality issues.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'audit_focus',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Audit Focus',
        'default', 'common quality issues in newly submitted skills'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'audit',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/audit.md',
        'required', true,
        'label', 'Quality Audit'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 16 * * 5',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/skill-quality-audit',
  TIMESTAMPTZ '2026-05-29 08:13:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

INSERT INTO skill_versions (id, user_id, name, version, manifest_json, bundle_path, created_at)
VALUES (
  'sv_community-digest_0_1_0',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'community-digest',
  '0.1.0',
  jsonb_build_object(
    'schema_version', '0.3',
    'name', 'community-digest',
    'title', 'Community Digest',
    'description', 'Daily summary of Floom community activity across Discord, comments, and issues.',
    'version', '0.1.0',
    'targets', jsonb_build_array('generic'),
    'runtime', 'skill',
    'running', 'e2b',
    'exec', jsonb_build_object('entry', 'SKILL.md'),
    'inputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'community_focus',
        'kind', 'scalar',
        'type', 'string',
        'required', false,
        'label', 'Community Focus',
        'default', 'skill builders, integrators, and early adopters discussing patterns, bugs, and feature requests'
      )
    ),
    'outputs', jsonb_build_array(
      jsonb_build_object(
        'name', 'digest',
        'kind', 'file',
        'media_type', 'text/markdown',
        'path', 'out/digest.md',
        'required', true,
        'label', 'Community Digest'
      )
    ),
    'trigger', jsonb_build_object(
      'type', 'schedule',
      'cron', '0 8 * * *',
      'timezone', 'Europe/Berlin'
    )
  ),
  '/opt/workeros-cloud/var/workers/community-digest',
  TIMESTAMPTZ '2026-05-29 08:14:00+00'
)
ON CONFLICT (id) DO UPDATE
  SET manifest_json = EXCLUDED.manifest_json,
      bundle_path = EXCLUDED.bundle_path;

-- ---------------------------------------------------------------------------
-- 3. Workers (one per skill version, scoped to the right workspace).
-- ---------------------------------------------------------------------------

-- Rocketlist workspace -------------------------------------------------------

INSERT INTO workers (
  id, user_id, skill_version_id, name,
  trigger_type, cron_expr, cron_timezone,
  enabled, workspace_id, created_at,
  grants_json, input_values_json, triggers_json, notify_email
)
VALUES (
  'job-digest',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'sv_job-digest_0_1_0',
  'Job Digest',
  'schedule', '0 9 * * *', 'Europe/Berlin',
  TRUE, 'ws_c948858cba3938c', TIMESTAMPTZ '2026-05-29 08:20:00+00',
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
  'applicant-followup',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'sv_applicant-followup_0_1_0',
  'Applicant Followup',
  'manual', NULL, NULL,
  TRUE, 'ws_c948858cba3938c', TIMESTAMPTZ '2026-05-29 08:21:00+00',
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
  'hiring-pulse',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'sv_hiring-pulse_0_1_0',
  'Hiring Pulse',
  'schedule', '0 10 * * 1', 'Europe/Berlin',
  TRUE, 'ws_c948858cba3938c', TIMESTAMPTZ '2026-05-29 08:22:00+00',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE
)
ON CONFLICT (id) DO NOTHING;

-- Floom workspace ------------------------------------------------------------

INSERT INTO workers (
  id, user_id, skill_version_id, name,
  trigger_type, cron_expr, cron_timezone,
  enabled, workspace_id, created_at,
  grants_json, input_values_json, triggers_json, notify_email
)
VALUES (
  'skill-quality-audit',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'sv_skill-quality-audit_0_1_0',
  'Skill Quality Audit',
  'schedule', '0 16 * * 5', 'Europe/Berlin',
  TRUE, 'ws_1893b8646e0a6e8', TIMESTAMPTZ '2026-05-29 08:30:00+00',
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
  'community-digest',
  '7f20f991-d018-49e1-9fd1-858f68f8c773',
  'sv_community-digest_0_1_0',
  'Community Digest',
  'schedule', '0 8 * * *', 'Europe/Berlin',
  TRUE, 'ws_1893b8646e0a6e8', TIMESTAMPTZ '2026-05-29 08:31:00+00',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, FALSE
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Runs: realistic recent history. One failed run across the seed
--    (run_seed_fede_jd_004 on job-digest), everything else completed.
--
--    Each INSERT is guarded with WHERE NOT EXISTS so re-runs are no-ops.
--    All runs scoped to the new workspaces; fede's existing 'fede' workspace
--    is not touched.
-- ---------------------------------------------------------------------------

-- job-digest: 3 completed (May 27/26/24) + 1 failed (May 20). Daily schedule.
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
SELECT * FROM (VALUES
  ('run_seed_fede_jd_001'::text, '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'job-digest'::text, 'ws_c948858cba3938c'::text,
   'completed'::text, 'schedule'::text, 'skill'::text,
   '{"focus_segment": "senior backend, ML, and infra roles at European startups"}'::jsonb,
   '{"digest": "out/digest.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-27 07:00:02+00', TIMESTAMPTZ '2026-05-27 07:00:12+00', 9842, NULL::text,
   TIMESTAMPTZ '2026-05-27 07:00:00+00'),
  ('run_seed_fede_jd_002', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'job-digest', 'ws_c948858cba3938c',
   'completed', 'schedule', 'skill',
   '{"focus_segment": "senior backend, ML, and infra roles at European startups"}'::jsonb,
   '{"digest": "out/digest.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-26 07:00:01+00', TIMESTAMPTZ '2026-05-26 07:00:11+00', 9512, NULL,
   TIMESTAMPTZ '2026-05-26 07:00:00+00'),
  ('run_seed_fede_jd_003', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'job-digest', 'ws_c948858cba3938c',
   'completed', 'schedule', 'skill',
   '{"focus_segment": "senior backend, ML, and infra roles at European startups"}'::jsonb,
   '{"digest": "out/digest.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-24 07:00:02+00', TIMESTAMPTZ '2026-05-24 07:00:13+00', 10204, NULL,
   TIMESTAMPTZ '2026-05-24 07:00:00+00'),
  ('run_seed_fede_jd_004', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'job-digest', 'ws_c948858cba3938c',
   'failed', 'schedule', 'skill',
   '{"focus_segment": "senior backend, ML, and infra roles at European startups"}'::jsonb,
   '{}'::jsonb,
   TIMESTAMPTZ '2026-05-20 07:00:02+00', TIMESTAMPTZ '2026-05-20 07:00:05+00', 2104,
   'OpenAI rate limit exceeded: please retry in 60 seconds.',
   TIMESTAMPTZ '2026-05-20 07:00:00+00')
) AS v(id, user_id, worker_id, workspace_id, status, trigger_source, runner,
       input_json, output_json, started_at, completed_at, duration_ms, error, created_at)
WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = v.id);

-- applicant-followup: 2 manual completed runs.
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
SELECT * FROM (VALUES
  ('run_seed_fede_af_001'::text, '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'applicant-followup'::text, 'ws_c948858cba3938c'::text,
   'completed'::text, 'manual'::text, 'skill'::text,
   '{"candidate_name": "Maria Schmidt", "role_title": "Senior Backend Engineer", "cv_summary": "8 years Python+Go, scaled payments infra at N26, currently at a Series B in Berlin, open to remote roles in EU."}'::jsonb,
   '{"email": "out/email.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-26 14:08:01+00', TIMESTAMPTZ '2026-05-26 14:08:10+00', 8721, NULL::text,
   TIMESTAMPTZ '2026-05-26 14:08:00+00'),
  ('run_seed_fede_af_002', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'applicant-followup', 'ws_c948858cba3938c',
   'completed', 'manual', 'skill',
   '{"candidate_name": "Jonas Becker", "role_title": "Staff ML Engineer", "cv_summary": "PhD in NLP, 6 years at DeepL building production translation models, looking for a hands-on staff role at a smaller team."}'::jsonb,
   '{"email": "out/email.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-22 11:34:02+00', TIMESTAMPTZ '2026-05-22 11:34:11+00', 8902, NULL,
   TIMESTAMPTZ '2026-05-22 11:34:00+00')
) AS v(id, user_id, worker_id, workspace_id, status, trigger_source, runner,
       input_json, output_json, started_at, completed_at, duration_ms, error, created_at)
WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = v.id);

-- hiring-pulse: 2 completed (last two Mondays).
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
SELECT * FROM (VALUES
  ('run_seed_fede_hp_001'::text, '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'hiring-pulse'::text, 'ws_c948858cba3938c'::text,
   'completed'::text, 'schedule'::text, 'skill'::text,
   '{"market_focus": "European tech hiring across early-stage and growth-stage startups"}'::jsonb,
   '{"pulse": "out/pulse.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-26 08:00:03+00', TIMESTAMPTZ '2026-05-26 08:00:14+00', 11041, NULL::text,
   TIMESTAMPTZ '2026-05-26 08:00:00+00'),
  ('run_seed_fede_hp_002', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'hiring-pulse', 'ws_c948858cba3938c',
   'completed', 'schedule', 'skill',
   '{"market_focus": "European tech hiring across early-stage and growth-stage startups"}'::jsonb,
   '{"pulse": "out/pulse.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-19 08:00:02+00', TIMESTAMPTZ '2026-05-19 08:00:12+00', 10402, NULL,
   TIMESTAMPTZ '2026-05-19 08:00:00+00')
) AS v(id, user_id, worker_id, workspace_id, status, trigger_source, runner,
       input_json, output_json, started_at, completed_at, duration_ms, error, created_at)
WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = v.id);

-- skill-quality-audit: 2 completed (last two Fridays).
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
SELECT * FROM (VALUES
  ('run_seed_fede_sq_001'::text, '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'skill-quality-audit'::text, 'ws_1893b8646e0a6e8'::text,
   'completed'::text, 'schedule'::text, 'skill'::text,
   '{"audit_focus": "common quality issues in newly submitted skills"}'::jsonb,
   '{"audit": "out/audit.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-23 14:00:02+00', TIMESTAMPTZ '2026-05-23 14:00:13+00', 10502, NULL::text,
   TIMESTAMPTZ '2026-05-23 14:00:00+00'),
  ('run_seed_fede_sq_002', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'skill-quality-audit', 'ws_1893b8646e0a6e8',
   'completed', 'schedule', 'skill',
   '{"audit_focus": "common quality issues in newly submitted skills"}'::jsonb,
   '{"audit": "out/audit.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-16 14:00:02+00', TIMESTAMPTZ '2026-05-16 14:00:12+00', 9821, NULL,
   TIMESTAMPTZ '2026-05-16 14:00:00+00')
) AS v(id, user_id, worker_id, workspace_id, status, trigger_source, runner,
       input_json, output_json, started_at, completed_at, duration_ms, error, created_at)
WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = v.id);

-- community-digest: 3 completed daily runs (May 28/27/26).
INSERT INTO runs (
  id, user_id, worker_id, workspace_id,
  status, trigger_source, runner,
  input_json, output_json,
  started_at, completed_at, duration_ms, error,
  created_at
)
SELECT * FROM (VALUES
  ('run_seed_fede_cd_001'::text, '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'community-digest'::text, 'ws_1893b8646e0a6e8'::text,
   'completed'::text, 'schedule'::text, 'skill'::text,
   '{"community_focus": "skill builders, integrators, and early adopters discussing patterns, bugs, and feature requests"}'::jsonb,
   '{"digest": "out/digest.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-28 06:00:02+00', TIMESTAMPTZ '2026-05-28 06:00:11+00', 8612, NULL::text,
   TIMESTAMPTZ '2026-05-28 06:00:00+00'),
  ('run_seed_fede_cd_002', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'community-digest', 'ws_1893b8646e0a6e8',
   'completed', 'schedule', 'skill',
   '{"community_focus": "skill builders, integrators, and early adopters discussing patterns, bugs, and feature requests"}'::jsonb,
   '{"digest": "out/digest.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-27 06:00:01+00', TIMESTAMPTZ '2026-05-27 06:00:09+00', 7841, NULL,
   TIMESTAMPTZ '2026-05-27 06:00:00+00'),
  ('run_seed_fede_cd_003', '7f20f991-d018-49e1-9fd1-858f68f8c773'::uuid, 'community-digest', 'ws_1893b8646e0a6e8',
   'completed', 'schedule', 'skill',
   '{"community_focus": "skill builders, integrators, and early adopters discussing patterns, bugs, and feature requests"}'::jsonb,
   '{"digest": "out/digest.md"}'::jsonb,
   TIMESTAMPTZ '2026-05-26 06:00:02+00', TIMESTAMPTZ '2026-05-26 06:00:10+00', 8302, NULL,
   TIMESTAMPTZ '2026-05-26 06:00:00+00')
) AS v(id, user_id, worker_id, workspace_id, status, trigger_source, runner,
       input_json, output_json, started_at, completed_at, duration_ms, error, created_at)
WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = v.id);

-- ---------------------------------------------------------------------------
-- 5. Run logs: 5 representative lines per seeded run.
--    Same pattern as the depontefede seed: completed runs get start/validate/
--    agent/output/completed; failed runs swap the last two for error/retry.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  run_rec RECORD;
BEGIN
  FOR run_rec IN
    SELECT id, started_at, status, error
    FROM runs
    WHERE id LIKE 'run_seed_fede_%'
      AND user_id = '7f20f991-d018-49e1-9fd1-858f68f8c773'
  LOOP
    -- Skip if logs for this run already seeded
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
       'Agent step started: drafting output via OpenAI.', run_rec.started_at + interval '2 seconds');

    IF run_rec.status = 'completed' THEN
      INSERT INTO run_logs (user_id, run_id, level, message, timestamp)
      VALUES
        ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
         'Output written successfully.', run_rec.started_at + interval '7 seconds'),
        ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
         'Run completed.', run_rec.started_at + interval '8 seconds');
    ELSIF run_rec.status = 'failed' THEN
      INSERT INTO run_logs (user_id, run_id, level, message, timestamp)
      VALUES
        ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'error',
         COALESCE(run_rec.error, 'Run failed.'), run_rec.started_at + interval '3 seconds'),
        ('7f20f991-d018-49e1-9fd1-858f68f8c773', run_rec.id, 'info',
         'Run marked failed; will retry on next schedule tick.', run_rec.started_at + interval '4 seconds');
    END IF;
  END LOOP;
END $$;

COMMIT;
