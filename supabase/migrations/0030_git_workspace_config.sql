-- GitHub connection config per workspace.
-- In cloud, git_workspace_config lives in Supabase (not the local SQLite sidecar)
-- so it survives container restarts and is shared across all instances.
--
-- One row per workspace. Keyed on workspace_id.
-- The PAT is stored encrypted at rest (Supabase encrypts at the storage layer).
-- RLS: only the workspace admin (insert/update/delete) or members (select) can access.

CREATE TABLE IF NOT EXISTS git_workspace_config (
    workspace_id    TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    github_pat      TEXT NOT NULL,
    github_username TEXT,
    repo_full_name  TEXT,
    repo_url        TEXT,
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_pushed_at  TIMESTAMPTZ
);

ALTER TABLE git_workspace_config ENABLE ROW LEVEL SECURITY;

-- Workspace admins can read/write their own row.
-- Members can read (so they see the connected repo in the Settings UI).
CREATE POLICY "workspace members can read git config"
    ON git_workspace_config FOR SELECT
    USING (
        workspace_id IN (
            SELECT workspace_id FROM workspace_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "workspace admins can manage git config"
    ON git_workspace_config FOR ALL
    USING (
        workspace_id IN (
            SELECT workspace_id FROM workspace_members
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );
