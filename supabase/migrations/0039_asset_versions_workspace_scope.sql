-- Migration 0039: workspace-scope asset version history.
--
-- The API uses the service role for asset_versions, so RLS cannot protect
-- repository reads/deletes. Store the active workspace on new versions and
-- require the repository to filter by it for request-scoped operations.

ALTER TABLE public.asset_versions
    ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES public.workspaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS asset_versions_workspace_asset_idx
    ON public.asset_versions (workspace_id, asset_type, asset_id, version_number DESC);

CREATE INDEX IF NOT EXISTS asset_versions_workspace_id_idx
    ON public.asset_versions (workspace_id, id);
