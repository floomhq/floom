"""#848 — TOCTOU: disabled user must not obtain a session via login/magic-link.

RCA: the login and magic-link handlers checked ``user.get("disabled")`` and
then inserted the session in a separate statement. A user disabled between the
check and the insert (e.g. a terminated employee racing the admin's disable
action) still received a valid session cookie.

Fix: ``SqliteUserSessionRepository.create`` now guards the INSERT on the user
being enabled in the same SQL statement (INSERT ... SELECT ... WHERE
disabled = 0), making check + insert atomic. It raises ValueError when no row
is inserted; login/magic-link translate that into 403.

Run:
    cd apps/api && python -m pytest tests/test_session_disabled_toctou.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_db(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return db


def _make_user(repos, user_id: str = "u-1", username: str = "alice") -> None:
    repos.users.create(
        user_id=user_id,
        username=username,
        display_name=None,
        password_hash="x",
        role="member",
    )


def test_create_session_refused_for_disabled_user(monkeypatch, tmp_path):
    db = _load_db(monkeypatch, tmp_path)
    repos = db.get_repositories()
    _make_user(repos)
    repos.users.update(user_id="u-1", disabled=1)

    with pytest.raises(ValueError):
        repos.sessions.create(session_id="s-1", user_id="u-1", expires_at="2999-01-01T00:00:00+00:00")
    assert repos.sessions.get(session_id="s-1") is None


def test_create_session_refused_for_missing_user(monkeypatch, tmp_path):
    db = _load_db(monkeypatch, tmp_path)
    repos = db.get_repositories()

    with pytest.raises(ValueError):
        repos.sessions.create(session_id="s-2", user_id="ghost", expires_at="2999-01-01T00:00:00+00:00")


def test_create_session_ok_for_enabled_user(monkeypatch, tmp_path):
    db = _load_db(monkeypatch, tmp_path)
    repos = db.get_repositories()
    _make_user(repos)

    row = repos.sessions.create(session_id="s-3", user_id="u-1", expires_at="2999-01-01T00:00:00+00:00")
    assert row["id"] == "s-3"
    assert repos.sessions.get(session_id="s-3") is not None


def test_login_race_disabled_after_password_check_returns_403(monkeypatch, tmp_path):
    """Simulate the race: the user is disabled AFTER the credential check
    succeeds but BEFORE the session insert. The atomic guard must reject it."""
    db = _load_db(monkeypatch, tmp_path)
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    repos = db.get_repositories()
    _make_user(repos)

    def _verify_and_disable(password: str, hashed: str) -> bool:
        # the credential check passes, then the account is disabled — exactly
        # the TOCTOU window the old code left open
        repos.users.update(user_id="u-1", disabled=1)
        return True

    # auth_login moved to routers.auth and resolves _bcrypt_verify via its own
    # module global, so patch it there (not on main).
    import routers.auth as auth_router_mod
    monkeypatch.setattr(auth_router_mod, "_bcrypt_verify", _verify_and_disable)

    with TestClient(main.app, raise_server_exceptions=False) as client:
        resp = client.post("/auth/login", json={"username": "alice", "password": "whatever"})

    assert resp.status_code == 403
    with db.get_db() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM user_sessions").fetchone()["c"]
    assert count == 0
