-- Migrate secret storage from Fernet (env-key) to Supabase Vault (pgsodium).
--
-- Current state: secrets.value holds a Fernet-encrypted blob, decrypted with
-- WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY (one key for all workspaces).
--
-- New state: secrets.vault_secret_id holds the UUID of a pgsodium Vault secret.
-- Vault manages per-secret key derivation internally. The plaintext never
-- appears in application-layer logs and is only readable by the service role.
--
-- Backward compat: old rows keep value populated and vault_secret_id NULL.
-- The application reads vault_secret_id first; falls back to Fernet for NULL.
-- New writes set vault_secret_id and clear value. Existing secrets are migrated
-- lazily on next write (re-encrypt via Vault at that point).

ALTER TABLE secrets ADD COLUMN IF NOT EXISTS vault_secret_id UUID;
-- Allow value to be NULL when secret is stored in Vault instead of Fernet
ALTER TABLE secrets ALTER COLUMN value DROP NOT NULL;

-- Public-schema wrappers so supabase-py .rpc() can reach vault.* functions
-- (supabase-py PostgREST client cannot call functions in non-public schemas
-- directly). SECURITY DEFINER + fixed search_path is safe here because these
-- functions only operate on the vault schema and accept explicit IDs.

CREATE OR REPLACE FUNCTION workeros_vault_create_secret(
    p_secret      text,
    p_name        text,
    p_description text DEFAULT ''
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
    SELECT vault.create_secret(p_secret, p_name, p_description);
$$;

CREATE OR REPLACE FUNCTION workeros_vault_update_secret(
    p_id     uuid,
    p_secret text,
    p_name   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
    PERFORM vault.update_secret(p_id, p_secret, p_name);
END;
$$;

CREATE OR REPLACE FUNCTION workeros_vault_delete_secret(p_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
    -- vault.delete_secret() is not available in all Supabase versions.
    -- Delete directly from vault.secrets instead (same effect).
    DELETE FROM vault.secrets WHERE id = p_id;
    SELECT true;
$$;

CREATE OR REPLACE FUNCTION workeros_vault_read_secret(p_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
    SELECT decrypted_secret
    FROM   vault.decrypted_secrets
    WHERE  id = p_id;
$$;
