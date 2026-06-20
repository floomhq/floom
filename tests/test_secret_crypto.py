from __future__ import annotations

import os
from pathlib import Path

import pytest

from apps.api.db import _secret_crypto


def test_secret_crypto_round_trip():
    ciphertext = _secret_crypto.encrypt_secret("secret-value")

    assert isinstance(ciphertext, bytes)
    assert _secret_crypto.decrypt_secret(ciphertext) == "secret-value"


def test_secret_crypto_requires_key(monkeypatch):
    previous = os.environ.get("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY")
    monkeypatch.delenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", raising=False)
    _secret_crypto._fernet.cache_clear()

    with pytest.raises(RuntimeError) as exc_info:
        _secret_crypto.ensure_secret_crypto_ready()

    assert "WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY" in str(exc_info.value)

    if previous is not None:
        monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", previous)
    _secret_crypto._fernet.cache_clear()


def test_batch_vault_read_rpc_is_service_role_only():
    migration = (
        Path(__file__).resolve().parents[1]
        / "supabase"
        / "migrations"
        / "0046_batch_vault_secret_reads.sql"
    ).read_text(encoding="utf-8").lower()

    assert "security definer" in migration
    assert "revoke all on function public.workeros_vault_read_secrets(uuid[]) from public" in migration
    assert "revoke all on function public.workeros_vault_read_secrets(uuid[]) from anon" in migration
    assert "revoke all on function public.workeros_vault_read_secrets(uuid[]) from authenticated" in migration
    assert "grant execute on function public.workeros_vault_read_secrets(uuid[]) to service_role" in migration
