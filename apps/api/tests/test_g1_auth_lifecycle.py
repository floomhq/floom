"""g1 security batch — auth/token lifecycle fixes.

Covers:
  #933 — x-floom-secret must not grant admin when user-header scope is on and
         the header is missing; WORKEROS_SHARED_SECRET_ROLE=member demotes the
         shared secret; header-scoped users are members, never admin.
  #915 — CLI API tokens die with their user (disabled / deleted) and expire.
  #916 — worker-call run tokens check the owning user's lifecycle.
  #918 — scheduler skips triggers whose owner is disabled or deleted.
  #924/#949 — PATs get a default bounded TTL and a maximum-lifetime cap.

Run:
    cd apps/api && python -m pytest tests/test_g1_auth_lifecycle.py -v
"""
from __future__ import annotations

import importlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

GOOD_PASSWORD = "correct-horse-battery"
SECRET = "g1-test-shared-secret"


def _load_main(monkeypatch, tmp_path, *, secret: str | None = None, extra_env: dict | None = None):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    if secret is None:
        monkeypatch.delenv("FLOOM_SECRET", raising=False)
    else:
        monkeypatch.setenv("FLOOM_SECRET", secret)
    monkeypatch.delenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", raising=False)
    monkeypatch.delenv("WORKEROS_SHARED_SECRET_ROLE", raising=False)
    monkeypatch.delenv("WORKEROS_PAT_MAX_TTL_DAYS", raising=False)
    for key, value in (extra_env or {}).items():
        monkeypatch.setenv(key, value)
    for name in list(sys.modules):
        if (
            name == "main"
            or name == "run_token"
            or name == "db"
            or name.startswith("db.")
            or name == "auth"
            or name.startswith("auth.")
        ):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


def _setup_admin_and_member(client):
    """Create admin alice + member bob; return (admin_client_state, bob_id)."""
    resp = client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
    assert resp.status_code == 201, resp.text
    created = client.post("/users", json={"username": "bob", "password": GOOD_PASSWORD, "role": "member"})
    assert created.status_code in (200, 201), created.text
    return created.json()["id"]


# ---------------------------------------------------------------------------
# #933 — shared-secret privilege fixes
# ---------------------------------------------------------------------------

def test_header_scope_without_user_header_is_401_not_admin(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, secret=SECRET,
        extra_env={"WORKEROS_ENABLE_USER_HEADER_SCOPE": "1"},
    )
    with _client(main) as client:
        resp = client.get("/auth/me", headers={"x-floom-secret": SECRET})
    assert resp.status_code == 401, resp.text


def test_header_scope_with_user_header_is_member(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, secret=SECRET,
        extra_env={"WORKEROS_ENABLE_USER_HEADER_SCOPE": "1"},
    )
    with _client(main) as client:
        resp = client.get(
            "/auth/me",
            headers={"x-floom-secret": SECRET, "x-floom-user": "carol"},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user_id"] == "carol"
    assert body["role"] == "member"
    assert body["is_admin"] is False


def test_shared_secret_default_remains_admin(monkeypatch, tmp_path):
    """Backwards compat: plain shared-secret installs keep admin."""
    main = _load_main(monkeypatch, tmp_path, secret=SECRET)
    with _client(main) as client:
        resp = client.get("/auth/me", headers={"x-floom-secret": SECRET})
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_admin"] is True


def test_shared_secret_role_member_demotes(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, secret=SECRET,
        extra_env={"WORKEROS_SHARED_SECRET_ROLE": "member"},
    )
    with _client(main) as client:
        resp = client.get("/auth/me", headers={"x-floom-secret": SECRET})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "member"
    assert body["is_admin"] is False


# ---------------------------------------------------------------------------
# #915 — CLI API token lifecycle
# ---------------------------------------------------------------------------

def _mint_cli_token(main, user_id: str, role: str = "member") -> str:
    import db as db_mod

    return main._issue_cli_auth_pat(
        user_id=user_id,
        client_name="g1-test",
        repos=db_mod.get_repositories(),
        role=role,
    )


def test_cli_token_rejected_when_user_disabled(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        bob_id = _setup_admin_and_member(client)
        token = _mint_cli_token(main, bob_id)

        ok = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert ok.status_code == 200, ok.text

        patched = client.patch(f"/users/{bob_id}", json={"disabled": True})
        assert patched.status_code == 200, patched.text

        rejected = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert rejected.status_code == 401, rejected.text


def test_cli_token_revoked_when_user_deleted(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        bob_id = _setup_admin_and_member(client)
        token = _mint_cli_token(main, bob_id)

        deleted = client.delete(f"/users/{bob_id}")
        assert deleted.status_code == 204, deleted.text

        rejected = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert rejected.status_code == 401, rejected.text

    # the delete also revoked the row itself, not just the auth check
    import db as db_mod

    with db_mod.get_db() as conn:
        row = conn.execute(
            "SELECT revoked_at FROM cli_api_tokens WHERE user_id = ?", (bob_id,)
        ).fetchone()
    assert row is not None and row["revoked_at"] is not None


def test_cli_token_minted_with_expiry_and_expired_token_rejected(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    import db as db_mod

    with _client(main) as client:
        bob_id = _setup_admin_and_member(client)
        token = _mint_cli_token(main, bob_id)

        with db_mod.get_db() as conn:
            row = conn.execute(
                "SELECT expires_at FROM cli_api_tokens WHERE user_id = ?", (bob_id,)
            ).fetchone()
        assert row["expires_at"] is not None  # #924: bounded by default

        # Force the token into the past — it must stop working.
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        with db_mod.get_db() as conn:
            conn.execute("UPDATE cli_api_tokens SET expires_at = ? WHERE user_id = ?", (past, bob_id))

        rejected = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert rejected.status_code == 401, rejected.text


def test_cli_token_for_legacy_install_without_users_still_works(monkeypatch, tmp_path):
    """Empty users table (legacy single-user install) keeps working."""
    main = _load_main(monkeypatch, tmp_path)
    token = _mint_cli_token(main, "federico", role="admin")
    with _client(main) as client:
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# #916 — worker-call run token lifecycle
# ---------------------------------------------------------------------------

def test_run_token_rejected_when_user_disabled(monkeypatch, tmp_path):
    # #972/#992: worker-call tokens are fail-closed — they must be signed with a
    # real secret. Provide the dedicated worker-call secret so the token can be
    # minted without re-enabling the FLOOM_SECRET API gate (this test runs the
    # API in unauthenticated local mode on purpose).
    main = _load_main(
        monkeypatch, tmp_path,
        extra_env={"WORKEROS_WORKER_CALL_SECRET": SECRET},
    )
    from run_token import issue_worker_call_token

    with _client(main) as client:
        bob_id = _setup_admin_and_member(client)
        token = issue_worker_call_token(
            user_id=bob_id, parent_run_id="run-1", callable_workers=["child"]
        )

        # Active user: the token authenticates (and is then blocked from the
        # general API with a 403 — that's the run-token containment rule).
        active = client.get("/workers", headers={"Authorization": f"Bearer {token}"})
        assert active.status_code == 403, active.text

        client.patch(f"/users/{bob_id}", json={"disabled": True})

        rejected = client.get("/workers", headers={"Authorization": f"Bearer {token}"})
        assert rejected.status_code == 401, rejected.text


# ---------------------------------------------------------------------------
# #924/#949 — PAT TTL defaults and cap
# ---------------------------------------------------------------------------

def test_pat_gets_default_expiry(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
        resp = client.post("/auth/tokens", json={"name": "g1-default-ttl"})
        assert resp.status_code == 201, resp.text
        expires_at = resp.json()["pat"]["expires_at"]
        assert expires_at is not None
        parsed = datetime.fromisoformat(expires_at)
        delta = parsed - datetime.now(timezone.utc)
        assert timedelta(days=89) < delta <= timedelta(days=91)


def test_pat_expiry_beyond_cap_rejected(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
        far = (datetime.now(timezone.utc) + timedelta(days=400)).isoformat()
        resp = client.post("/auth/tokens", json={"name": "g1-too-long", "expires_at": far})
        assert resp.status_code == 422, resp.text
        assert "maximum token lifetime" in resp.json()["detail"]


def test_pat_requested_expiry_within_cap_kept(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
        soon = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
        resp = client.post("/auth/tokens", json={"name": "g1-one-week", "expires_at": soon})
        assert resp.status_code == 201, resp.text
        parsed = datetime.fromisoformat(resp.json()["pat"]["expires_at"])
        assert abs((parsed - datetime.now(timezone.utc)) - timedelta(days=7)) < timedelta(minutes=5)


def test_pat_ttl_cap_opt_out(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, extra_env={"WORKEROS_PAT_MAX_TTL_DAYS": "0"}
    )
    with _client(main) as client:
        client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
        resp = client.post("/auth/tokens", json={"name": "g1-legacy"})
        assert resp.status_code == 201, resp.text
        assert resp.json()["pat"]["expires_at"] is None


# ---------------------------------------------------------------------------
# #918 — scheduler owner lifecycle
# ---------------------------------------------------------------------------

def test_scheduler_owner_is_active(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    import db as db_mod

    sys.modules.pop("scheduler", None)
    scheduler = importlib.import_module("scheduler")
    repos = db_mod.get_repositories()

    # Empty users table → legacy ids stay active.
    assert scheduler._owner_is_active(repos, "federico") is True

    with _client(main) as client:
        bob_id = _setup_admin_and_member(client)
        assert scheduler._owner_is_active(repos, bob_id) is True

        client.patch(f"/users/{bob_id}", json={"disabled": True})
        assert scheduler._owner_is_active(repos, bob_id) is False

    # Users exist but this owner id doesn't → inactive.
    assert scheduler._owner_is_active(repos, "ghost-user") is False
