-- Security: git_workspace_config contains GitHub credentials. Members must not
-- be able to SELECT the raw row through PostgREST; API routes can expose redacted
-- metadata separately.

DROP POLICY IF EXISTS "workspace members can read git config"
    ON public.git_workspace_config;

DROP POLICY IF EXISTS "workspace admins can read git config"
    ON public.git_workspace_config;

CREATE POLICY "workspace admins can read git config"
    ON public.git_workspace_config FOR SELECT
    USING (
        workspace_id IN (
            SELECT workspace_id FROM public.workspace_members
            WHERE user_id = auth.uid()
              AND role = 'admin'
              AND status = 'active'
        )
    );
