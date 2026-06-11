"""#849 — expired sessions must be pruned, not accumulate forever.

RCA: ``SqliteUserSessionRepository.prune_expired()`` existed but had zero
callers, so every expired session row stayed in the database indefinitely
(bloat; replay surface in the unlikely event of a session-id collision).

Fix: ``_prune_expired_sessions`` is called on every session-creating endpoint
(setup, login, magic-link) — they already hit the DB, and the prune is one
indexed DELETE. Best-effort: a prune failure never blocks a login.

Run:
    cd apps/api && python -m pytest tests/test_session_pruning.py -v
"""
from __future__ import annotations

import importlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

PASSWORD = "correct-horse-battery"


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main"), db


def _session_count(db) -> int:
    with db.get_db() as conn:
        return conn.execute("SELECT COUNT(*) AS c FROM user_sessions").fetchone()["c"]


def test_login_prunes_expired_sessions(monkeypatch, tmp_path):
    main, db = _load_main(monkeypatch, tmp_path)
    from fastapi.testclient import TestClient

    with TestClient(main.app, raise_server_exceptions=False) as client:
        setup = client.post("/auth/setup", json={"username": "alice", "password": PASSWORD})
        assert setup.status_code == 201
        user_id = setup.json()["id"]

        # plant expired sessions directly (bypassing create()'s validation)
        past = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        with db.get_db() as conn:
            for i in range(3):
                conn.execute(
                    "INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                    (f"expired-{i}", user_id, past, past),
                )
        count_before = _session_count(db)
        assert count_before >= 4  # 3 expired + the setup auto-login session

        login = client.post("/auth/login", json={"username": "alice", "password": PASSWORD})
        assert login.status_code == 200

        with db.get_db() as conn:
            expired_left = conn.execute(
                "SELECT COUNT(*) AS c FROM user_sessions WHERE id LIKE 'expired-%'"
            ).fetchone()["c"]
        assert expired_left == 0
        # live sessions (setup auto-login + this login) survive the prune
        assert _session_count(db) == 2


def test_prune_failure_does_not_block_login(monkeypatch, tmp_path):
    main, db = _load_main(monkeypatch, tmp_path)
    from fastapi.testclient import TestClient

    with TestClient(main.app, raise_server_exceptions=False) as client:
        client.post("/auth/setup", json={"username": "alice", "password": PASSWORD})

        def _boom(session_repo):
            raise RuntimeError("prune exploded")

        # patch the repo method the helper calls
        repos = db.get_repositories()
        monkeypatch.setattr(
            type(repos.sessions), "prune_expired",
            lambda self, *, now_iso: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        login = client.post("/auth/login", json={"username": "alice", "password": PASSWORD})
        assert login.status_code == 200
