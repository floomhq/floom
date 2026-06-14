-- Migration 0034: Slack zero-login cloud installations.
--
-- Public Slack installs create a real unclaimed workspace immediately. Bot
-- tokens are stored in Supabase Vault; this table stores only the Vault UUID.

BEGIN;

ALTER TABLE public.workspaces
    ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE public.workspaces
    ADD COLUMN IF NOT EXISTS workspace_status TEXT NOT NULL DEFAULT 'claimed'
        CHECK (workspace_status IN ('unclaimed', 'claimed', 'claim_pending', 'revoked', 'uninstalled')),
    ADD COLUMN IF NOT EXISTS created_by_installation_id UUID;

CREATE INDEX IF NOT EXISTS idx_workspaces_status_created
    ON public.workspaces (workspace_status, created_at);

ALTER TABLE public.workspace_agent_channel_bindings
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'channel'
        CHECK (scope IN ('channel', 'team'));

ALTER TABLE public.workspace_agent_channel_bindings
    ALTER COLUMN external_channel_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_agent_channel_bindings_team_fallback_idx
    ON public.workspace_agent_channel_bindings (channel_type, external_team_id, scope)
    WHERE enabled = true AND scope = 'team';

CREATE TABLE IF NOT EXISTS public.slack_installations (
    team_id                   TEXT PRIMARY KEY,
    installation_id           UUID NOT NULL DEFAULT gen_random_uuid(),
    team_name                 TEXT,
    enterprise_id             TEXT,
    enterprise_name           TEXT,
    app_id                    TEXT,
    bot_user_id               TEXT,
    bot_token_encrypted       UUID,
    scopes_json               JSONB NOT NULL DEFAULT '[]'::jsonb,
    installer_slack_user_id   TEXT NOT NULL,
    workspace_id              TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    status                    TEXT NOT NULL DEFAULT 'installed'
                              CHECK (status IN (
                                  'installed',
                                  'unclaimed',
                                  'claimed',
                                  'claim_pending',
                                  'revoked',
                                  'uninstalled',
                                  'token_invalid'
                              )),
    installed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at                TIMESTAMPTZ,
    revoked_at                TIMESTAMPTZ,
    uninstalled_at            TIMESTAMPTZ,
    last_token_check_at       TIMESTAMPTZ,
    last_token_check_status   TEXT,
    last_token_check_error    TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT slack_installations_installation_id_unique UNIQUE (installation_id)
);

COMMENT ON COLUMN public.slack_installations.bot_token_encrypted IS
    'Supabase Vault secret UUID for the Slack bot token; plaintext is never stored in public tables.';

CREATE INDEX IF NOT EXISTS slack_installations_workspace_idx
    ON public.slack_installations (workspace_id);

CREATE INDEX IF NOT EXISTS slack_installations_status_idx
    ON public.slack_installations (status, updated_at);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.slack_installations'::regclass
          AND conname = 'slack_installations_workspace_unique'
    ) THEN
        ALTER TABLE public.slack_installations
            ADD CONSTRAINT slack_installations_workspace_unique UNIQUE (workspace_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.slack_install_claims (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash                 TEXT NOT NULL UNIQUE,
    team_id                    TEXT NOT NULL REFERENCES public.slack_installations(team_id) ON DELETE CASCADE,
    installation_id            UUID NOT NULL REFERENCES public.slack_installations(installation_id) ON DELETE CASCADE,
	installer_slack_user_id    TEXT NOT NULL,
	verification_slack_user_id TEXT,
	verification_code_hash     TEXT,
	verification_expires_at    TIMESTAMPTZ,
    verification_attempts      INTEGER NOT NULL DEFAULT 0,
    expires_at                 TIMESTAMPTZ NOT NULL,
    used_at                    TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slack_install_claims_team_idx
    ON public.slack_install_claims (team_id, expires_at);

CREATE INDEX IF NOT EXISTS slack_install_claims_installation_idx
    ON public.slack_install_claims (installation_id, expires_at);

ALTER TABLE public.slack_install_claims
    ADD COLUMN IF NOT EXISTS verification_slack_user_id TEXT;

CREATE TABLE IF NOT EXISTS public.slack_sender_bindings (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_team_id          TEXT NOT NULL,
    slack_user_id          TEXT NOT NULL,
    user_id                UUID,
    workspace_id           TEXT REFERENCES public.workspaces(id) ON DELETE SET NULL,
    profile_name           TEXT,
    status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'active')),
    claim_token_hash       TEXT UNIQUE,
    claim_expires_at       TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at           TIMESTAMPTZ,
    CONSTRAINT slack_sender_bindings_sender_unique UNIQUE (slack_team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS slack_sender_bindings_user_workspace_idx
    ON public.slack_sender_bindings (user_id, workspace_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS slack_sender_bindings_claim_idx
    ON public.slack_sender_bindings (claim_token_hash)
    WHERE claim_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.slack_install_audit_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action            TEXT NOT NULL,
    team_id           TEXT,
    workspace_id       TEXT,
    installation_id    UUID,
    actor_user_id      UUID,
    slack_user_id      TEXT,
    ip_hash            TEXT,
    user_agent         TEXT,
    metadata_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slack_install_audit_logs_action_created_idx
    ON public.slack_install_audit_logs (action, created_at);

CREATE INDEX IF NOT EXISTS slack_install_audit_logs_team_created_idx
    ON public.slack_install_audit_logs (team_id, created_at);

CREATE INDEX IF NOT EXISTS slack_install_audit_logs_ip_created_idx
    ON public.slack_install_audit_logs (ip_hash, created_at);

CREATE OR REPLACE FUNCTION public.set_slack_installations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS slack_installations_updated_at
    ON public.slack_installations;

CREATE TRIGGER slack_installations_updated_at
    BEFORE UPDATE ON public.slack_installations
    FOR EACH ROW
    EXECUTE FUNCTION public.set_slack_installations_updated_at();

CREATE OR REPLACE FUNCTION public.upsert_slack_installation_cloud(
    p_team_id TEXT,
    p_team_name TEXT,
    p_enterprise_id TEXT,
    p_enterprise_name TEXT,
    p_app_id TEXT,
    p_bot_user_id TEXT,
    p_bot_token_encrypted UUID,
    p_scopes_json JSONB,
    p_installer_slack_user_id TEXT
)
RETURNS public.slack_installations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    existing_install public.slack_installations%ROWTYPE;
    target_workspace_id TEXT;
    target_status TEXT;
    result public.slack_installations%ROWTYPE;
BEGIN
    IF p_team_id IS NULL OR btrim(p_team_id) = '' THEN
        RAISE EXCEPTION 'Slack team id is required';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_team_id, 0));

    SELECT *
      INTO existing_install
      FROM public.slack_installations
     WHERE team_id = p_team_id
     FOR UPDATE;

    target_workspace_id := existing_install.workspace_id;
    target_status := CASE WHEN existing_install.status = 'claimed' THEN 'claimed' ELSE 'unclaimed' END;

    IF target_workspace_id IS NULL OR target_workspace_id = '' THEN
        target_workspace_id := 'ws_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 14);
        INSERT INTO public.workspaces (id, owner_user_id, name, workspace_status, created_at)
        VALUES (
            target_workspace_id,
            NULL,
            COALESCE(NULLIF(substr(btrim(regexp_replace(COALESCE(p_team_name, p_team_id), '\s+', ' ', 'g')), 1, 80), ''), 'Slack workspace'),
            'unclaimed',
            now()
        );
    END IF;

    INSERT INTO public.slack_installations (
        team_id,
        team_name,
        enterprise_id,
        enterprise_name,
        app_id,
        bot_user_id,
        bot_token_encrypted,
        scopes_json,
        installer_slack_user_id,
        workspace_id,
        status,
        installed_at,
        last_token_check_at,
        last_token_check_status,
        last_token_check_error,
        uninstalled_at,
        revoked_at
    )
    VALUES (
        p_team_id,
        p_team_name,
        p_enterprise_id,
        p_enterprise_name,
        p_app_id,
        p_bot_user_id,
        p_bot_token_encrypted,
        COALESCE(p_scopes_json, '[]'::jsonb),
        p_installer_slack_user_id,
        target_workspace_id,
        target_status,
        now(),
        now(),
        'valid',
        NULL,
        NULL,
        NULL
    )
    ON CONFLICT (team_id) DO UPDATE SET
        team_name = EXCLUDED.team_name,
        enterprise_id = EXCLUDED.enterprise_id,
        enterprise_name = EXCLUDED.enterprise_name,
        app_id = EXCLUDED.app_id,
        bot_user_id = EXCLUDED.bot_user_id,
        bot_token_encrypted = EXCLUDED.bot_token_encrypted,
        scopes_json = EXCLUDED.scopes_json,
        installer_slack_user_id = EXCLUDED.installer_slack_user_id,
        workspace_id = public.slack_installations.workspace_id,
        status = CASE WHEN public.slack_installations.status = 'claimed' THEN 'claimed' ELSE 'unclaimed' END,
        installed_at = EXCLUDED.installed_at,
        last_token_check_at = EXCLUDED.last_token_check_at,
        last_token_check_status = 'valid',
        last_token_check_error = NULL,
        uninstalled_at = NULL,
        revoked_at = NULL
    RETURNING * INTO result;

    UPDATE public.workspaces
       SET created_by_installation_id = result.installation_id,
           workspace_status = CASE WHEN result.status = 'claimed' THEN 'claimed' ELSE 'unclaimed' END
     WHERE id = result.workspace_id;

    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_slack_sender_bindings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS slack_sender_bindings_updated_at
    ON public.slack_sender_bindings;

CREATE TRIGGER slack_sender_bindings_updated_at
    BEFORE UPDATE ON public.slack_sender_bindings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_slack_sender_bindings_updated_at();

ALTER TABLE public.slack_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.slack_install_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_install_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE public.slack_sender_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_sender_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.slack_install_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_install_audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace owners can read Slack installations"
    ON public.slack_installations;
CREATE POLICY "Workspace owners can read Slack installations"
    ON public.slack_installations FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.workspaces w
            WHERE w.id = slack_installations.workspace_id
              AND w.owner_user_id = auth.uid()
              AND w.workspace_status = 'claimed'
        )
    );

DROP POLICY IF EXISTS "Service role full access to Slack installations"
    ON public.slack_installations;
CREATE POLICY "Service role full access to Slack installations"
    ON public.slack_installations FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access to Slack install claims"
    ON public.slack_install_claims;
CREATE POLICY "Service role full access to Slack install claims"
    ON public.slack_install_claims FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Workspace owners can read Slack sender bindings"
    ON public.slack_sender_bindings;
CREATE POLICY "Workspace owners can read Slack sender bindings"
    ON public.slack_sender_bindings FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.workspaces w
            WHERE w.id = slack_sender_bindings.workspace_id
              AND w.owner_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Service role full access to Slack sender bindings"
    ON public.slack_sender_bindings;
CREATE POLICY "Service role full access to Slack sender bindings"
    ON public.slack_sender_bindings FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access to Slack install audit logs"
    ON public.slack_install_audit_logs;
CREATE POLICY "Service role full access to Slack install audit logs"
    ON public.slack_install_audit_logs FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

COMMIT;
