-- Migration 0041: add missing indexes on foreign-key columns.

CREATE INDEX IF NOT EXISTS approvals_workspace_id_idx
    ON public.approvals (workspace_id);

CREATE INDEX IF NOT EXISTS asset_versions_user_id_idx
    ON public.asset_versions (user_id);

CREATE INDEX IF NOT EXISTS telemetry_preferences_user_id_idx
    ON public.telemetry_preferences (user_id);

CREATE INDEX IF NOT EXISTS telemetry_events_user_id_idx
    ON public.telemetry_events (user_id);

CREATE INDEX IF NOT EXISTS workspace_share_links_created_by_user_id_idx
    ON public.workspace_share_links (created_by_user_id);

CREATE INDEX IF NOT EXISTS workspace_transfer_events_previous_owner_user_id_idx
    ON public.workspace_transfer_events (previous_owner_user_id);

CREATE INDEX IF NOT EXISTS workspace_transfer_events_new_owner_user_id_idx
    ON public.workspace_transfer_events (new_owner_user_id);

CREATE INDEX IF NOT EXISTS mcp_tools_user_id_idx
    ON public.mcp_tools (user_id);

CREATE INDEX IF NOT EXISTS mcp_tools_worker_id_idx
    ON public.mcp_tools (worker_id);

CREATE INDEX IF NOT EXISTS novasearch_match_queries_user_id_idx
    ON public.novasearch_match_queries (user_id);

CREATE INDEX IF NOT EXISTS novasearch_match_labels_user_id_idx
    ON public.novasearch_match_labels (user_id);

CREATE INDEX IF NOT EXISTS novasearch_tracked_candidates_user_id_idx
    ON public.novasearch_tracked_candidates (user_id);

CREATE INDEX IF NOT EXISTS novasearch_outreach_user_id_idx
    ON public.novasearch_outreach (user_id);

CREATE INDEX IF NOT EXISTS novasearch_memory_user_id_idx
    ON public.novasearch_memory (user_id);

CREATE INDEX IF NOT EXISTS novasearch_judge_cache_user_id_idx
    ON public.novasearch_judge_cache (user_id);

CREATE INDEX IF NOT EXISTS novasearch_session_events_user_id_idx
    ON public.novasearch_session_events (user_id);

CREATE INDEX IF NOT EXISTS novasearch_issue_reports_user_id_idx
    ON public.novasearch_issue_reports (user_id);
