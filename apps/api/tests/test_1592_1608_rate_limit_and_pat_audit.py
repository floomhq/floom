from __future__ import annotations

import importlib
import logging
import sys
import types
from types import SimpleNamespace

import pytest


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "rate-limit-test-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    (tmp_path / "workers").mkdir(exist_ok=True)
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_http_rate_limit_returns_structured_error_code(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    main._rate_buckets.clear()
    from fastapi.testclient import TestClient

    with TestClient(main.app, headers={"x-floom-secret": "rate-limit-test-secret"}) as client:
        response = None
        for _ in range(31):
            response = client.get("/auth/me")

    assert response is not None
    assert response.status_code == 429
    assert response.json()["detail"]["error_code"] == "rate_limit_exceeded"
    assert response.headers["Retry-After"]


def test_run_and_chat_quota_429s_are_structured():
    from fastapi import HTTPException
    from services.quota import _raise_chat_quota, _raise_run_create_quota

    with pytest.raises(HTTPException) as run_exc:
        _raise_run_create_quota(10, 60.0, 17)
    assert run_exc.value.detail == {
        "error_code": "rate_limit_exceeded",
        "message": "Run creation rate limit exceeded: 10/60s",
        "retry_after": 17,
    }
    assert run_exc.value.headers == {"Retry-After": "17"}

    with pytest.raises(HTTPException) as chat_exc:
        _raise_chat_quota(20, 60.0, 9)
    assert chat_exc.value.detail["error_code"] == "rate_limit_exceeded"
    assert chat_exc.value.detail["retry_after"] == 9
    assert chat_exc.value.headers == {"Retry-After": "9"}


def test_member_pat_creation_is_audit_logged(monkeypatch, caplog):
    from models import _PATCreateRequest
    from routers import auth as auth_router

    class TokenRepo:
        def create(self, *, token_id, user_id, name, token_hash, expires_at):
            return {
                "id": token_id,
                "name": name,
                "last_used_at": None,
                "created_at": "2026-06-20T00:00:00Z",
                "expires_at": expires_at,
            }

    monkeypatch.setattr(
        auth_router,
        "_require_multi_member_repos",
        lambda _repos: (None, None, TokenRepo()),
    )
    auth = SimpleNamespace(user_id="member-a", role="member")

    with caplog.at_level(logging.INFO, logger="floom.api"):
        result = auth_router.create_token(
            _PATCreateRequest(name="cli", expires_at=None),
            auth=auth,
            repos=SimpleNamespace(),
        )

    assert result.token.startswith("wos_")
    assert any(
        "personal access token created user=member-a role=member token_name=cli" in r.getMessage()
        for r in caplog.records
    )
