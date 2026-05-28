from __future__ import annotations

import os
from functools import lru_cache

from cryptography.fernet import Fernet

from apps.api._cloud_env import load_cloud_env_file

load_cloud_env_file()


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
