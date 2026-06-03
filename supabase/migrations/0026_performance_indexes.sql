-- Performance indexes: workers and runs tables were missing all query indexes,
-- causing full table scans on every API request.

-- workers: most queries filter by workspace_id or user_id
CREATE INDEX IF NOT EXISTS workers_workspace_id_idx
  ON public.workers (workspace_id);

CREATE INDEX IF NOT EXISTS workers_user_id_idx
  ON public.workers (user_id);

-- Composite for the visibility filter:
-- WHERE workspace_id = $1 AND (user_id = $2 OR visibility = 'shared')
CREATE INDEX IF NOT EXISTS workers_workspace_visibility_idx
  ON public.workers (workspace_id, visibility);

CREATE INDEX IF NOT EXISTS workers_workspace_user_idx
  ON public.workers (workspace_id, user_id);

-- workers: created_at order (list endpoint default ordering)
CREATE INDEX IF NOT EXISTS workers_created_at_idx
  ON public.workers (created_at);

-- runs: primary access patterns
CREATE INDEX IF NOT EXISTS runs_workspace_id_created_at_idx
  ON public.runs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runs_worker_id_created_at_idx
  ON public.runs (worker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runs_user_id_created_at_idx
  ON public.runs (user_id, created_at DESC);

-- runs: trigger member lookup (runs middleware email resolution)
CREATE INDEX IF NOT EXISTS runs_trigger_member_id_idx
  ON public.runs (trigger_member_id)
  WHERE trigger_member_id IS NOT NULL;

-- runs: status filter (common in stats queries)
CREATE INDEX IF NOT EXISTS runs_workspace_status_idx
  ON public.runs (workspace_id, status);

-- workspace_members: role lookup on every authenticated request
CREATE INDEX IF NOT EXISTS workspace_members_workspace_user_idx
  ON public.workspace_members (workspace_id, user_id);

-- skill_versions: looked up by id in every workers list call (already PK but
-- explicit index on user_id helps user-scoped queries)
CREATE INDEX IF NOT EXISTS skill_versions_user_id_idx
  ON public.skill_versions (user_id);
