-- Migration 0014: workspace-scoped Workspace Agent instructions
-- Stores editable workspace.md content per Cloud workspace.

CREATE TABLE IF NOT EXISTS public.workspace_agent_settings (
    workspace_id      TEXT PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
    instructions_md   TEXT NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.set_workspace_agent_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_agent_settings_updated_at
    ON public.workspace_agent_settings;

CREATE TRIGGER workspace_agent_settings_updated_at
    BEFORE UPDATE ON public.workspace_agent_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_workspace_agent_settings_updated_at();

ALTER TABLE public.workspace_agent_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own workspace agent settings"
    ON public.workspace_agent_settings FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = workspace_agent_settings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

CREATE POLICY "Users can write their own workspace agent settings"
    ON public.workspace_agent_settings FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = workspace_agent_settings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = workspace_agent_settings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access to workspace agent settings"
    ON public.workspace_agent_settings FOR ALL
    USING (true)
    WITH CHECK (true);
