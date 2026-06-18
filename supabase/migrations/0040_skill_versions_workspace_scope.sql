-- Migration 0040: workspace-scope skill_versions.
--
-- The cloud API uses the Supabase service role, so repository queries must
-- carry tenant scope explicitly instead of relying on RLS.

ALTER TABLE public.skill_versions
    ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES public.workspaces(id) ON DELETE CASCADE;

UPDATE public.skill_versions sv
SET workspace_id = w.workspace_id
FROM public.workers w
WHERE sv.id = w.skill_version_id
  AND sv.workspace_id IS NULL
  AND w.workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS skill_versions_workspace_id_idx
    ON public.skill_versions (workspace_id);

CREATE INDEX IF NOT EXISTS skill_versions_workspace_name_version_idx
    ON public.skill_versions (workspace_id, name, version);

CREATE INDEX IF NOT EXISTS skill_versions_workspace_id_pk_lookup_idx
    ON public.skill_versions (workspace_id, id);
