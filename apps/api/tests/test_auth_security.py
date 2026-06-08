"""Auth security fixes.

#594 — /auth/me must return 401 for wrong/missing secret when FLOOM_SECRET is set.
         Previously fell through to dev-mode and returned admin for any request.
#597 — POST /auth/tokens must return 409 (not 500) in dev mode where no real
         user row exists in the DB.

Run:
    cd apps/api && python -m pytest tests/test_auth_security.py -v
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, raise_server_exceptions=False)


def _clear_auth_cache():
    try:
        from auth.factory import get_auth_provider
        get_auth_provider.cache_clear()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# #594 — FLOOM_SECRET set: wrong/missing secret must return 401
# ---------------------------------------------------------------------------

def test_594_wrong_secret_returns_401_when_secret_configured(monkeypatch):
    """When FLOOM_SECRET is set, a wrong x-floom-secret must return 401.
    Previously, a wrong secret with 0 users in the DB fell through to dev-mode
    and returned HTTP 200 with role=admin — a P0 auth bypass."""
    monkeypatch.setenv("FLOOM_SECRET", "correct-secret")
    _clear_auth_cache()
    client = _client()
    r = client.get("/auth/me", headers={"x-floom-secret": "wrong-secret"})
    assert r.status_code == 401, (
        f"Expected 401 for wrong secret when FLOOM_SECRET is set, got {r.status_code}: {r.text}"
    )


def test_594_missing_secret_returns_401_when_secret_configured(monkeypatch):
    """When FLOOM_SECRET is set, a request with no x-floom-secret must return 401."""
    monkeypatch.setenv("FLOOM_SECRET", "correct-secret")
    _clear_auth_cache()
    client = _client()
    r = client.get("/auth/me")
    assert r.status_code == 401, (
        f"Expected 401 for missing secret when FLOOM_SECRET is set, got {r.status_code}: {r.text}"
    )


def test_594_correct_secret_returns_200_when_secret_configured(monkeypatch):
    """The correct secret must still work when FLOOM_SECRET is set."""
    monkeypatch.setenv("FLOOM_SECRET", "correct-secret")
    _clear_auth_cache()
    client = _client()
    r = client.get("/auth/me", headers={"x-floom-secret": "correct-secret"})
    assert r.status_code == 200, (
        f"Expected 200 for correct secret, got {r.status_code}: {r.text}"
    )
    data = r.json()
    assert data.get("auth_method") == "secret"
    assert data.get("role") == "admin"


def test_594_dev_mode_still_works_without_secret(monkeypatch):
    """When FLOOM_SECRET is NOT set, dev mode (0 users → admin) must still work
    for local installs that haven't configured a secret."""
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    _clear_auth_cache()
    client = _client()
    r = client.get("/auth/me")
    # Dev mode: 0 users in test DB → admin
    assert r.status_code == 200
    assert r.json().get("auth_method") == "dev"


# ---------------------------------------------------------------------------
# #597 — PAT create returns 409 (not 500) in dev mode
# ---------------------------------------------------------------------------

def test_597_pat_create_returns_409_not_500_in_dev_mode(monkeypatch):
    """POST /auth/tokens must return 409 with a clear message when called in
    dev mode (ghost auth — no real user row in the DB).
    Previously raised sqlite3.IntegrityError → 500."""
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    _clear_auth_cache()
    client = _client()
    r = client.post("/auth/tokens", json={"name": "test-pat"})
    assert r.status_code == 409, (
        f"Expected 409 for PAT create in dev mode (no real user), got {r.status_code}: {r.text}"
    )
    assert "setup" in r.json().get("detail", "").lower(), (
        "409 response must mention workspace setup so the user knows how to fix it"
    )


def test_597_pat_create_error_is_not_500(monkeypatch):
    """Specifically verify that the PAT create endpoint does not return 500."""
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    _clear_auth_cache()
    client = _client()
    r = client.post("/auth/tokens", json={"name": "any-name"})
    assert r.status_code != 500, (
        "POST /auth/tokens must never return 500 — "
        f"got {r.status_code}: {r.text}"
    )
