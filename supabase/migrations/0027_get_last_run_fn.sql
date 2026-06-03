-- Batch last-run lookup: replaces N sequential per-worker queries with one
-- DISTINCT ON query. Called by SupabaseWorkerRepository.stats_batch() to
-- pre-populate the request-scoped contextvar cache before the engine's
-- per-worker get_last_run() loop.
CREATE OR REPLACE FUNCTION public.get_last_run_per_worker(
    p_workspace_id text,
    p_worker_ids text[]
) RETURNS TABLE(
    id text,
    worker_id text,
    status text,
    trigger_source text,
    created_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    duration_ms integer,
    error text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (r.worker_id)
    r.id, r.worker_id, r.status, r.trigger_source,
    r.created_at, r.started_at, r.completed_at, r.duration_ms, r.error
  FROM public.runs r
  WHERE r.workspace_id = p_workspace_id
    AND r.worker_id = ANY(p_worker_ids)
  ORDER BY r.worker_id, r.created_at DESC
$$;
