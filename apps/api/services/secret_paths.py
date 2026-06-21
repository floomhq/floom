"""Shared secret-bearing path detection for exports and git staging."""

from __future__ import annotations

import re


SECRETS_ENC_FILENAME = ".secrets.enc"

SECRET_BEARING_BASENAMES = frozenset({
    ".env",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".secrets",
    SECRETS_ENC_FILENAME,
    "credentials",
    "credentials.json",
    "git-credentials",
    ".git-credentials",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
})

_PRIVATE_KEY_BASENAMES = frozenset({
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
})

_SECRET_JSON_TOKENS = frozenset({
    "cred",
    "creds",
    "credential",
    "credentials",
    "gha",
    "sa",
    "serviceaccount",
    "wif",
})


def is_secret_bearing_export_path(rel: str) -> bool:
    """True when a relative path may carry secret material."""
    normalized = rel.replace("\\", "/").strip("/")
    base = normalized.rsplit("/", 1)[-1].lower()
    if not base:
        return False
    if base in SECRET_BEARING_BASENAMES:
        return True
    if base in _PRIVATE_KEY_BASENAMES:
        return True
    # Any `.git` directory anywhere in the path (root .git/ OR a nested repo
    # like workers/foo/.git/config) carries git internals incl. credentials.
    if ".git" in normalized.lower().split("/"):
        return True
    # .env, .env.local, .env.production, foo.env, etc.
    if base == ".env" or base.startswith(".env.") or base.endswith(".env"):
        return True
    # Private keys / certs.
    if base.endswith((
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".pkcs12",
        ".p8",
        ".der",
        ".crt",
        ".cer",
        ".ppk",
    )):
        return True
    # Cloud service-account / workload-identity credential JSON, e.g.
    # vertex-wif-cred.json, gcp-service-account.json, my-sa.json (#1681).
    # Token matching avoids false positives like results.json or package.json.
    if base.endswith(".json"):
        stem = base[: -len(".json")]
        tokens = set(re.split(r"[-_]+", stem))
        if tokens & _SECRET_JSON_TOKENS:
            return True
        if (
            "github-actions" in stem
            or "github_actions" in stem
            or "service-account" in stem
            or "service_account" in stem
            or "serviceaccount" in stem
        ):
            return True
    return False
