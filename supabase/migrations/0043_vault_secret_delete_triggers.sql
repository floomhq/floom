-- Migration 0043: delete Supabase Vault rows when workspace-scoped public rows
-- are deleted directly or via workspace ON DELETE CASCADE.

CREATE OR REPLACE FUNCTION public.workeros_delete_secret_vault_ref()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF OLD.vault_secret_id IS NOT NULL THEN
        PERFORM public.workeros_vault_delete_secret(OLD.vault_secret_id);
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS secrets_delete_vault_ref
    ON public.secrets;

CREATE TRIGGER secrets_delete_vault_ref
    BEFORE DELETE ON public.secrets
    FOR EACH ROW
    EXECUTE FUNCTION public.workeros_delete_secret_vault_ref();

CREATE OR REPLACE FUNCTION public.workeros_delete_slack_installation_vault_ref()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF OLD.bot_token_encrypted IS NOT NULL THEN
        PERFORM public.workeros_vault_delete_secret(OLD.bot_token_encrypted);
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS slack_installations_delete_vault_ref
    ON public.slack_installations;

CREATE TRIGGER slack_installations_delete_vault_ref
    BEFORE DELETE ON public.slack_installations
    FOR EACH ROW
    EXECUTE FUNCTION public.workeros_delete_slack_installation_vault_ref();
