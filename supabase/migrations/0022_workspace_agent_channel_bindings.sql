-- Migration 0022: workspace-agent channel bindings
-- Stores explicit channel routing for workspace-agent integrations such as Slack.

CREATE TABLE IF NOT EXISTS public.workspace_agent_channel_bindings (
    id                    TEXT PRIMARY KEY,
    workspace_id           TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    channel_type           TEXT NOT NULL,
    external_team_id       TEXT,
    external_channel_id    TEXT NOT NULL,
    external_channel_name  TEXT,
    enabled                BOOLEAN NOT NULL DEFAULT true,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workspace_agent_channel_type_check
        CHECK (channel_type IN ('slack'))
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_agent_channel_bindings_workspace_type_idx
    ON public.workspace_agent_channel_bindings (workspace_id, channel_type);

CREATE INDEX IF NOT EXISTS workspace_agent_channel_bindings_lookup_idx
    ON public.workspace_agent_channel_bindings (channel_type, external_team_id, external_channel_id)
    WHERE enabled = true;

CREATE OR REPLACE FUNCTION public.set_workspace_agent_channel_bindings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_agent_channel_bindings_updated_at
    ON public.workspace_agent_channel_bindings;

CREATE TRIGGER workspace_agent_channel_bindings_updated_at
    BEFORE UPDATE ON public.workspace_agent_channel_bindings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_workspace_agent_channel_bindings_updated_at();

ALTER TABLE public.workspace_agent_channel_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own workspace agent channel bindings"
    ON public.workspace_agent_channel_bindings FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = workspace_agent_channel_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

CREATE POLICY "Users can write their own workspace agent channel bindings"
    ON public.workspace_agent_channel_bindings FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = workspace_agent_channel_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = workspace_agent_channel_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access to workspace agent channel bindings"
    ON public.workspace_agent_channel_bindings FOR ALL
    USING (true)
    WITH CHECK (true);
