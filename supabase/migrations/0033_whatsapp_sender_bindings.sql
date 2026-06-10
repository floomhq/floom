-- Migration 0033: whatsapp_sender_bindings
-- Per-sender binding table for the shared WhatsApp number.  Mirrors the engine's
-- SQLite whatsapp_sender_bindings (migration 57 + 65) but adds workspace_id FK
-- and strict NOT NULL on fields that are always set by the claim flow.
--
-- Apply to prod DB with:
--   supabase db push --linked
-- or (manual):
--   psql "$DATABASE_URL" -f supabase/migrations/0033_whatsapp_sender_bindings.sql

CREATE TABLE IF NOT EXISTS public.whatsapp_sender_bindings (
    wa_id               TEXT PRIMARY KEY,
    user_id             TEXT,
    workspace_id        TEXT REFERENCES public.workspaces(id) ON DELETE SET NULL,
    profile_name        TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active')),
    claim_token         TEXT UNIQUE,
    claim_expires_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS whatsapp_sender_bindings_user_workspace_idx
    ON public.whatsapp_sender_bindings (user_id, workspace_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS whatsapp_sender_bindings_claim_token_idx
    ON public.whatsapp_sender_bindings (claim_token)
    WHERE claim_token IS NOT NULL;

-- Auto-update updated_at on row modification.
CREATE OR REPLACE FUNCTION public.set_whatsapp_sender_bindings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_sender_bindings_updated_at
    ON public.whatsapp_sender_bindings;

CREATE TRIGGER whatsapp_sender_bindings_updated_at
    BEFORE UPDATE ON public.whatsapp_sender_bindings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_whatsapp_sender_bindings_updated_at();

-- RLS: owner-only.  The service role (used by API) bypasses RLS.
ALTER TABLE public.whatsapp_sender_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own WhatsApp sender bindings"
    ON public.whatsapp_sender_bindings FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = whatsapp_sender_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

CREATE POLICY "Users can manage their own WhatsApp sender bindings"
    ON public.whatsapp_sender_bindings FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = whatsapp_sender_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.workspaces w
            WHERE w.id = whatsapp_sender_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access to WhatsApp sender bindings"
    ON public.whatsapp_sender_bindings FOR ALL
    USING (true)
    WITH CHECK (true);
