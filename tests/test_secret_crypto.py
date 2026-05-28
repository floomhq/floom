from __future__ import annotations

import os

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
