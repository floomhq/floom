"""#850 — password minimum length 12 + per-username login lockout.

RCA: passwords only had to be 6 characters and nothing throttled repeated
failed logins per account — the 5/min per-IP rate limit is trivially bypassed
by a distributed attacker, leaving weak passwords open to credential stuffing.

Fix: new/changed passwords require >= 12 characters (NIST SP 800-63B: length
over composition rules; existing shorter passwords still log in). Login gets
a per-username lockout: 5 failed attempts within 15 minutes lock the account
for the rest of the window (HTTP 429), checked before the bcrypt comparison.

Run:
    cd apps/api && python -m pytest tests/test_password_policy_lockout.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

GOOD_PASSWORD = "correct-horse-battery"


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    # No FLOOM_SECRET: rate-limit middleware stays off so this test exercises
    # the per-username lockout, not the per-IP limiter.
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    # session cookie is secure by default; TestClient origin is http
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


def test_setup_rejects_11_char_password(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        resp = client.post("/auth/setup", json={"username": "alice", "password": "elevenchars"})
    assert resp.status_code == 422
    assert "12 characters" in resp.json()["detail"]


def test_setup_accepts_12_char_password(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        resp = client.post("/auth/setup", json={"username": "alice", "password": "twelve-chars"})
    assert resp.status_code == 201


def test_user_create_and_update_enforce_min_length(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "admin", "password": GOOD_PASSWORD})
        created = client.post("/users", json={"username": "bob", "password": "short-pass1", "role": "member"})
        assert created.status_code == 422

        created = client.post("/users", json={"username": "bob", "password": GOOD_PASSWORD, "role": "member"})
        assert created.status_code == 200 or created.status_code == 201, created.text
        uid = created.json()["id"]

        patched = client.patch(f"/users/{uid}", json={"password": "short-pass1"})
        assert patched.status_code == 422


def test_login_locks_after_5_failed_attempts(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})

        for _ in range(5):
            resp = client.post("/auth/login", json={"username": "alice", "password": "wrong-password"})
            assert resp.status_code == 401

        # 6th attempt — even with the CORRECT password — is locked out
        resp = client.post("/auth/login", json={"username": "alice", "password": GOOD_PASSWORD})
        assert resp.status_code == 429

        # other accounts are unaffected by alice's lockout
        assert not main._login_locked_out("bob")


def test_successful_login_clears_failure_counter(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})

        for _ in range(4):
            client.post("/auth/login", json={"username": "alice", "password": "wrong-password"})
        ok = client.post("/auth/login", json={"username": "alice", "password": GOOD_PASSWORD})
        assert ok.status_code == 200

        # counter reset — alice gets a fresh window
        resp = client.post("/auth/login", json={"username": "alice", "password": "wrong-password"})
        assert resp.status_code == 401
        assert not main._login_locked_out("alice")
