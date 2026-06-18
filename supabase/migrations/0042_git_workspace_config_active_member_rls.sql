-- Migration 0042: removed workspace members must not satisfy Git config RLS.

DROP POLICY IF EXISTS "workspace members can read git config"
    ON public.git_workspace_config;

DROP POLICY IF EXISTS "workspace admins can manage git config"
    ON public.git_workspace_config;

CREATE POLICY "workspace members can read git config"
    ON public.git_workspace_config FOR SELECT
    USING (
        workspace_id IN (
            SELECT workspace_id FROM public.workspace_members
            WHERE user_id = auth.uid()
              AND status = 'active'
        )
    );

CREATE POLICY "workspace admins can manage git config"
    ON public.git_workspace_config FOR ALL
    USING (
        workspace_id IN (
            SELECT workspace_id FROM public.workspace_members
            WHERE user_id = auth.uid()
              AND role = 'admin'
              AND status = 'active'
        )
    )
    WITH CHECK (
        workspace_id IN (
            SELECT workspace_id FROM public.workspace_members
            WHERE user_id = auth.uid()
              AND role = 'admin'
              AND status = 'active'
        )
    );
