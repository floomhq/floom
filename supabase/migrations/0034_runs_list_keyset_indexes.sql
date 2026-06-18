-- Runs list keyset indexes for the cloud API hot path.
--
-- These are concurrent because public.runs is a live hot table. Apply before
-- deploying the API change so /runs can use the same index it orders by:
--   WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
-- and the equivalent user_id fallback used outside request workspace context.

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_workspace_created_id_idx
  ON public.runs (workspace_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_user_created_id_idx
  ON public.runs (user_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_workspace_status_created_id_idx
  ON public.runs (workspace_id, status, created_at DESC, id DESC);
