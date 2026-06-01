-- Migration 0013: asset_versions table for worker and brain-pack versioning
-- Stores immutable snapshots of mutable AI-editable assets to enable rollback.

CREATE TABLE IF NOT EXISTS public.asset_versions (
    id              TEXT PRIMARY KEY,
    asset_type      TEXT NOT NULL,          -- 'worker' | 'brain_pack'
    asset_id        TEXT NOT NULL,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    snapshot_json   TEXT NOT NULL,          -- full JSON snapshot of the asset state
    change_source   TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'ai' | 'api' | 'rollback:<vid>'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_versions_asset_idx
    ON public.asset_versions (asset_type, asset_id, version_number DESC);

-- Enable RLS
ALTER TABLE public.asset_versions ENABLE ROW LEVEL SECURITY;

-- Users can only see their own versions
CREATE POLICY "Users can read their own asset versions"
    ON public.asset_versions FOR SELECT
    USING (user_id = auth.uid());

-- Service role can do everything (API uses service_role key)
CREATE POLICY "Service role full access to asset_versions"
    ON public.asset_versions FOR ALL
    USING (true)
    WITH CHECK (true);
