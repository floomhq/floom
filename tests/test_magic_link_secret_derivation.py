"""Tests for _ensure_magic_link_secret in startup.py.

Verifies that the magic-link HMAC key is derived deterministically from
SUPABASE_SERVICE_ROLE_KEY at startup so links survive restarts without
requiring an extra env var.

Run: pytest tests/test_magic_link_secret_derivation.py -v
"""
from __future__ import annotations

import hashlib
import hmac
import os

import pytest

from apps.api.startup import _ensure_magic_link_secret


@pytest.fixture(autouse=True)
def clean_env():
    """Remove WORKEROS_MAGIC_LINK_SECRET before each test; restore after."""
    original = os.environ.pop("WORKEROS_MAGIC_LINK_SECRET", None)
    yield
    if original is None:
        os.environ.pop("WORKEROS_MAGIC_LINK_SECRET", None)
    else:
        os.environ["WORKEROS_MAGIC_LINK_SECRET"] = original


def _expected_derived(service_key: str) -> str:
    return hmac.new(
        service_key.encode("utf-8"),
        b"workeros-magic-link-secret-v1",
        hashlib.sha256,
    ).hexdigest()


def test_derives_key_from_service_role_key(monkeypatch):
    """When WORKEROS_MAGIC_LINK_SECRET is unset, derive from service role key."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    _ensure_magic_link_secret()
    assert os.environ.get("WORKEROS_MAGIC_LINK_SECRET") == _expected_derived("test-service-role-key")


def test_derivation_is_deterministic(monkeypatch):
    """Same service role key always produces the same magic-link secret."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "stable-key")
    _ensure_magic_link_secret()
    first = os.environ["WORKEROS_MAGIC_LINK_SECRET"]

    os.environ.pop("WORKEROS_MAGIC_LINK_SECRET")
    _ensure_magic_link_secret()
    second = os.environ["WORKEROS_MAGIC_LINK_SECRET"]

    assert first == second


def test_explicit_env_var_wins(monkeypatch):
    """If WORKEROS_MAGIC_LINK_SECRET is already set, it is never overwritten."""
    monkeypatch.setenv("WORKEROS_MAGIC_LINK_SECRET", "operator-chosen-secret")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "some-service-key")
    _ensure_magic_link_secret()
    assert os.environ["WORKEROS_MAGIC_LINK_SECRET"] == "operator-chosen-secret"


def test_no_service_key_leaves_var_unset(monkeypatch):
    """Without ANY service-role key (bare or WORKEROS_CLOUD_ alias), the function
    is a no-op. Both names must be cleared since the helper now reads either."""
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    _ensure_magic_link_secret()
    assert "WORKEROS_MAGIC_LINK_SECRET" not in os.environ


def test_different_service_keys_produce_different_secrets(monkeypatch):
    """Key derivation is sensitive to the input — different keys, different outputs."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "key-a")
    _ensure_magic_link_secret()
    key_a = os.environ.pop("WORKEROS_MAGIC_LINK_SECRET")

    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "key-b")
    _ensure_magic_link_secret()
    key_b = os.environ["WORKEROS_MAGIC_LINK_SECRET"]

    assert key_a != key_b


def test_derived_key_is_hex_string(monkeypatch):
    """Derived key is a 64-char hex string (SHA-256 output)."""
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "any-key")
    _ensure_magic_link_secret()
    key = os.environ["WORKEROS_MAGIC_LINK_SECRET"]
    assert len(key) == 64
    assert all(c in "0123456789abcdef" for c in key)
