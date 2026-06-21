"""Tests for _ensure_approval_signing_secret in startup.py (#1716).

Verifies that the approval-share signing key is derived deterministically from
SUPABASE_SERVICE_ROLE_KEY at startup so public approval/review share links work
in hosted mode (where FLOOM_SECRET is deliberately stripped and
WORKEROS_APPROVAL_SIGNING_SECRET is typically unset) without an extra env var,
and survive restarts.

Run: pytest tests/test_approval_signing_secret_derivation.py -v
"""
from __future__ import annotations

import hashlib
import hmac
import os

import pytest

from apps.api.startup import (
    _ensure_approval_signing_secret,
    _ensure_magic_link_secret,
)

_VAR = "WORKEROS_APPROVAL_SIGNING_SECRET"
_LABEL = b"workeros-approval-signing-secret-v1"


@pytest.fixture(autouse=True)
def clean_env():
    """Remove WORKEROS_APPROVAL_SIGNING_SECRET before each test; restore after."""
    original = os.environ.pop(_VAR, None)
    yield
    if original is None:
        os.environ.pop(_VAR, None)
    else:
        os.environ[_VAR] = original


def _expected_derived(service_key: str) -> str:
    return hmac.new(service_key.encode("utf-8"), _LABEL, hashlib.sha256).hexdigest()


def test_derives_key_from_service_role_key(monkeypatch):
    """When the var is unset, derive from SUPABASE_SERVICE_ROLE_KEY."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    _ensure_approval_signing_secret()
    assert os.environ.get(_VAR) == _expected_derived("test-service-role-key")


def test_derivation_is_deterministic(monkeypatch):
    """Same service role key always produces the same signing secret (links survive restarts)."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "stable-key")
    _ensure_approval_signing_secret()
    first = os.environ[_VAR]

    os.environ.pop(_VAR)
    _ensure_approval_signing_secret()
    second = os.environ[_VAR]

    assert first == second


def test_explicit_env_var_wins(monkeypatch):
    """If the var is already set, it is never overwritten."""
    monkeypatch.setenv(_VAR, "operator-chosen-secret")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "some-service-key")
    _ensure_approval_signing_secret()
    assert os.environ[_VAR] == "operator-chosen-secret"


def test_derives_from_prefixed_alias_env(monkeypatch):
    """Alias-only cloud deploy: only WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY is set
    (not the bare name). get_cloud_settings() accepts that alias, so the helper must
    too — otherwise the engine silently stays fail-closed and #1716 is NOT fixed."""
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "alias-service-key")
    _ensure_approval_signing_secret()
    assert os.environ.get(_VAR) == _expected_derived("alias-service-key")


def test_bare_name_takes_precedence_over_alias(monkeypatch):
    """When both names are set, the bare SUPABASE_SERVICE_ROLE_KEY wins — matching
    get_cloud_settings()'s resolution order (bare first, then the alias)."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "bare-key")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "alias-key")
    _ensure_approval_signing_secret()
    assert os.environ.get(_VAR) == _expected_derived("bare-key")


def test_no_service_key_leaves_var_unset(monkeypatch):
    """Without ANY service-role key (bare or alias), the function is a no-op
    (engine stays fail-closed — never signs with a weak/empty key)."""
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    _ensure_approval_signing_secret()
    assert _VAR not in os.environ


def test_different_service_keys_produce_different_secrets(monkeypatch):
    """Key derivation is sensitive to the input — different keys, different outputs."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "key-a")
    _ensure_approval_signing_secret()
    key_a = os.environ.pop(_VAR)

    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "key-b")
    _ensure_approval_signing_secret()
    key_b = os.environ[_VAR]

    assert key_a != key_b


def test_derived_key_is_hex_string(monkeypatch):
    """Derived key is a 64-char hex string (SHA-256 output)."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "any-key")
    _ensure_approval_signing_secret()
    key = os.environ[_VAR]
    assert len(key) == 64
    assert all(c in "0123456789abcdef" for c in key)


def test_domain_separated_from_magic_link(monkeypatch):
    """The approval key must NOT equal the magic-link key derived from the SAME
    service-role secret — the 'v1' domain-separation label keeps them distinct so
    one key cannot be substituted for the other."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "shared-service-key")
    monkeypatch.delenv("WORKEROS_MAGIC_LINK_SECRET", raising=False)

    _ensure_approval_signing_secret()
    _ensure_magic_link_secret()
    try:
        approval = os.environ[_VAR]
        magic = os.environ["WORKEROS_MAGIC_LINK_SECRET"]
        assert approval != magic
    finally:
        os.environ.pop("WORKEROS_MAGIC_LINK_SECRET", None)


def test_engine_signer_resolves_after_derivation(monkeypatch):
    """The actual #1716 outcome: once derived, the engine's approval signer no
    longer returns None (so public approval/review links stop 503-ing).

    Skipped if the engine module isn't importable in the test environment."""
    engine_mod = pytest.importorskip("core.approval_signing")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-key-for-signer")
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    _ensure_approval_signing_secret()

    secret = engine_mod._approval_signing_secret()
    assert secret == os.environ[_VAR]
    assert secret is not None and secret.strip()
