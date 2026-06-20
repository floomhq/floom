from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Optional
from uuid import UUID

from cryptography.fernet import Fernet

from apps.api._cloud_env import load_cloud_env_file
from apps.api.obs import log_failure

load_cloud_env_file()

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Fernet — legacy fallback for secrets written before Vault migration
# ---------------------------------------------------------------------------

def _secret_encryption_key() -> str:
    value = (os.environ.get("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY") or "").strip()
    if not value:
        raise RuntimeError(
            "WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY is required in cloud mode."
        )
    return value


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    return Fernet(_secret_encryption_key().encode())


def ensure_secret_crypto_ready() -> None:
    _fernet()


def encrypt_secret(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_secret(ciphertext: bytes) -> str:
    return _fernet().decrypt(bytes(ciphertext)).decode()


# ---------------------------------------------------------------------------
# Supabase Vault (pgsodium) — primary store for new secrets
#
# Vault stores one pgsodium-encrypted row per secret. The plaintext is only
# readable via vault.decrypted_secrets (service role only) — it never appears
# in application logs or network traffic beyond the Supabase RPC response.
#
# Public-schema wrapper functions (workeros_vault_*) in migration 0031 bridge
# the supabase-py PostgREST client to vault.* which lives in its own schema.
#
# Migration strategy: new secrets go to Vault (vault_secret_id set, value=NULL).
# Old Fernet-encrypted secrets retain their value blob. On the next write the
# secret is re-encrypted via Vault and the Fernet blob is cleared.
# ---------------------------------------------------------------------------

def vault_store_secret(
    client,
    plaintext: str,
    name: str,
    description: str = "",
) -> UUID:
    """Create or update a secret in Supabase Vault by name.

    Returns the vault UUID. If a secret with this name already exists
    (e.g. from a previous partial write), updates it in place.
    """
    try:
        result = client.rpc(
            "workeros_vault_create_secret",
            {"p_secret": plaintext, "p_name": name, "p_description": description},
        ).execute()
        return UUID(str(result.data))
    except Exception as exc:
        if "duplicate" not in str(exc).lower() and "unique" not in str(exc).lower():
            raise
        # Name already exists in vault — find existing ID and update
        existing = (
            client.schema("vault")
            .table("secrets")
            .select("id")
            .eq("name", name)
            .limit(1)
            .execute()
        )
        if not existing.data:
            raise
        existing_id = UUID(str(existing.data[0]["id"]))
        vault_update_secret(client, existing_id, plaintext, name)
        return existing_id


def vault_update_secret(client, vault_id: UUID, plaintext: str, name: str) -> None:
    """Overwrite the plaintext of an existing Vault secret."""
    client.rpc(
        "workeros_vault_update_secret",
        {"p_id": str(vault_id), "p_secret": plaintext, "p_name": name},
    ).execute()


def vault_read_secret(client, vault_id: UUID) -> Optional[str]:
    """Decrypt and return the plaintext of a Vault secret, or None if missing."""
    result = client.rpc(
        "workeros_vault_read_secret",
        {"p_id": str(vault_id)},
    ).execute()
    return result.data or None


def vault_read_secrets(client, vault_ids: list[UUID]) -> dict[str, str]:
    """Decrypt many Vault secrets in one RPC, keyed by vault UUID string."""
    if not vault_ids:
        return {}
    result = client.rpc(
        "workeros_vault_read_secrets",
        {"p_ids": [str(vault_id) for vault_id in vault_ids]},
    ).execute()
    rows = result.data or []
    values: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        vault_id = row.get("id")
        plaintext = row.get("secret")
        if vault_id and plaintext is not None:
            values[str(vault_id)] = str(plaintext)
    return values


def vault_delete_secret(client, vault_id: UUID) -> None:
    """Delete a secret from the Vault."""
    try:
        client.rpc(
            "workeros_vault_delete_secret",
            {"p_id": str(vault_id)},
        ).execute()
    except Exception:
        # Non-fatal for the caller, but a failed delete leaves an orphaned Vault
        # secret behind (storage/audit leak), so surface it at ERROR with the
        # vault id only — never the plaintext or ciphertext.
        log_failure(
            logger, "vault_delete_secret failed for vault_id %s (orphaned secret)", vault_id
        )


def vault_secret_name(workspace_id: str, secret_name: str) -> str:
    """Canonical name for a secret in Vault — scoped to workspace."""
    return f"workeros/{workspace_id}/{secret_name}"
