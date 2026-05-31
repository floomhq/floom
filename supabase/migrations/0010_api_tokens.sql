-- API tokens (PATs) for programmatic access.
-- Each user gets one auto-generated on first login. They can also create
-- named tokens (e.g. per-client, per-integration) and revoke individually.
-- Raw values are NEVER stored — only SHA-256 hashes.

CREATE TABLE IF NOT EXISTS public.api_tokens (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL DEFAULT 'default',
    token_hash   TEXT        NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

-- Users can only see and manage their own tokens via the dashboard.
-- The backend always uses the service_role key which bypasses RLS.
CREATE POLICY "Users manage own tokens"
    ON public.api_tokens
    FOR ALL
    USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON public.api_tokens (user_id);
CREATE INDEX IF NOT EXISTS api_tokens_hash_idx    ON public.api_tokens (token_hash);
