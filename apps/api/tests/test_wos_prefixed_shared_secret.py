"""#831 — a wos_-prefixed FLOOM_SECRET must not brick shared-secret auth.

RCA: ``MultiMemberAuthProvider.verify()`` routed any ``x-floom-secret`` value
starting with ``wos_`` (the PAT prefix) straight to ``_verify_pat()`` with no
fallback. If the configured FLOOM_SECRET itself starts with ``wos_``, PAT
lookup fails (it is not a stored token) and the request 401s — the instance
becomes unreachable via shared-secret auth.

Fix: when PAT verification rejects a wos_-prefixed value but the value matches
the configured shared secret (constant-time compare), verify() falls back to
the shared-secret context. Values that are neither a valid PAT nor the secret
still 401.

Run:
    cd apps/api && python -m pytest tests/test_wos_prefixed_shared_secret.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load(monkeypatch, tmp_path, secret: str):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", secret)
    for name in list(sys.modules):
        if name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    from auth.multi_member import MultiMemberAuthProvider

    return MultiMemberAuthProvider(), db


def _request(headers: dict[str, str]):
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
    }
    return Request(scope)


def test_wos_prefixed_floom_secret_authenticates(monkeypatch, tmp_path):
    provider, _db = _load(monkeypatch, tmp_path, secret="wos_my_shared_secret")

    ctx = asyncio.run(provider.verify(_request({"x-floom-secret": "wos_my_shared_secret"})))
    assert ctx.auth_method == "secret"
    assert ctx.role == "admin"


def test_wos_prefixed_wrong_value_still_401(monkeypatch, tmp_path):
    provider, _db = _load(monkeypatch, tmp_path, secret="wos_my_shared_secret")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(provider.verify(_request({"x-floom-secret": "wos_not_the_secret"})))
    assert exc.value.status_code == 401


def test_valid_cli_pat_via_x_floom_secret_still_works(monkeypatch, tmp_path):
    """The PAT-first routing for wos_ values must keep working."""
    provider, db = _load(monkeypatch, tmp_path, secret="ordinary-secret")
    from auth.multi_member import _hash_token

    raw = "wos_real_cli_token"
    with db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO cli_api_tokens
                (id, token_hash, user_id, role, name, created_at, last_used_at, revoked_at)
            VALUES (?, ?, ?, 'member', ?, ?, NULL, NULL)
            """,
            ("tok-1", _hash_token(raw), "u-1", "cli", db.now_iso()),
        )

    ctx = asyncio.run(provider.verify(_request({"x-floom-secret": raw})))
    assert ctx.auth_method == "pat"
    assert ctx.user_id == "u-1"
    assert ctx.role == "member"
