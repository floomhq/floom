-- Batch Supabase Vault reads for run dispatch.
--
-- The worker run hot path may resolve dozens of declared secrets. Reading them
-- one-by-one turns into N network RPCs before the sandbox can start. This
-- wrapper keeps plaintext inside the service-role RPC response while reducing
-- the hot path to one call.

CREATE OR REPLACE FUNCTION public.workeros_vault_read_secrets(p_ids uuid[])
RETURNS TABLE(id uuid, secret text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
    SELECT decrypted.id, decrypted.decrypted_secret
    FROM vault.decrypted_secrets AS decrypted
    WHERE decrypted.id = ANY(p_ids);
$$;

REVOKE ALL ON FUNCTION public.workeros_vault_read_secrets(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workeros_vault_read_secrets(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.workeros_vault_read_secrets(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.workeros_vault_read_secrets(uuid[]) TO service_role;
