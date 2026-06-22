"""Regression tests for three API fixes.

#1687 — Creating a workspace must not strand the caller's session.
  The create_workspace endpoint returns the new workspace id WITHOUT forcing
  the client into it server-side. Authenticated requests with the ORIGINAL
  x-workeros-workspace header must still work after creating a new workspace.

#1738 — Reject duplicate workspace name per owner.
  create_local_workspace() raises ValueError (HTTP 409) when the caller
  already owns a workspace with the same name (case-insensitive).
  (Also tested in test_local_workspaces.py — retained here for completeness.)

#1740 — Device-code "already consumed" race returns 410 instead of 500/404.
  When repos.cli_auth.consume(device_code) returns None the poll endpoint
  must respond with HTTP 410 Gone so the CLI knows to restart the flow.
"""
from __future__ import annotations

import importlib
import sys
import time
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def _purge_modules() -> None:
    for name in list(sys.modules):
        if name in ("main", "db") or name.startswith(("db.", "auth", "routers")):
            sys.modules.pop(name, None)


def _boot(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-fixes")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))

    _purge_modules()
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return main, db


@pytest.fixture()
def client_and_db(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    main, db = _boot(monkeypatch, tmp_path)
    with TestClient(
        main.app,
        headers={"x-floom-secret": "test-secret-fixes"},
        base_url="https://testserver",
    ) as client:
        yield client, db
    db.get_repositories.cache_clear()
    _purge_modules()


# ---------------------------------------------------------------------------
# #1687 — Creating a workspace must not strand the caller's existing session
# ---------------------------------------------------------------------------

def test_create_workspace_does_not_strand_original_workspace_session(client_and_db):
    """After creating a new workspace the caller can still make authenticated
    requests with their original x-workeros-workspace header.

    Root cause of #1687: earlier builds encoded the active workspace into the
    scoped user_id and *switched* the server-side scope on create, so the
    original header began resolving to the WRONG user. Fix: create_workspace
    returns the new id without touching the caller's scope.
    """
    client, _db = client_and_db

    # Confirm the default workspace is reachable before creating anything.
    before = client.get("/workspaces")
    assert before.status_code == 200, before.text
    original_active_id = before.json()["active_id"]

    # Create a new workspace.
    created = client.post("/workspaces", json={"name": "New Project"})
    assert created.status_code == 200, created.text
    new_id = created.json()["id"]
    assert new_id.startswith("ws_")
    assert new_id != original_active_id

    # Critically: the caller's original workspace header must still be valid.
    # Using the original (default) workspace id in the header — the server must
    # not have switched the scope server-side during the create call.
    after = client.get(
        "/workspaces",
        headers={"x-workeros-workspace": original_active_id},
    )
    assert after.status_code == 200, (
        f"Original workspace header became invalid after creating a new workspace "
        f"(#1687 regression). Got {after.status_code}: {after.text}"
    )
    # The active id reported for the original header must still be the original.
    assert after.json()["active_id"] == original_active_id, (
        f"Server silently switched active workspace to {after.json()[active_id]} "
        f"when caller used original header {original_active_id!r} (#1687 regression)"
    )

    # The new workspace is accessible via its own header too.
    new_scope = client.get(
        "/workspaces",
        headers={"x-workeros-workspace": new_id},
    )
    assert new_scope.status_code == 200, new_scope.text
    assert new_scope.json()["active_id"] == new_id


def test_create_workspace_returns_new_id_not_active_scope(client_and_db):
    """The response body is the newly created workspace, not the caller's active
    workspace. The /me endpoint's workspace_id must NOT change after create."""
    client, _db = client_and_db

    me_before = client.get("/me")
    assert me_before.status_code == 200, me_before.text
    workspace_id_before = me_before.json().get("workspace_id")

    created = client.post("/workspaces", json={"name": "Parallel Workspace"})
    assert created.status_code == 200, created.text
    assert created.json()["id"] != workspace_id_before

    # /me still reflects the original workspace (the server did not switch).
    me_after = client.get("/me")
    assert me_after.status_code == 200, me_after.text
    assert me_after.json().get("workspace_id") == workspace_id_before


# ---------------------------------------------------------------------------
# #1738 — Reject duplicate workspace name per owner (409)
# ---------------------------------------------------------------------------

def test_duplicate_workspace_name_returns_409(client_and_db):
    """#1738: second create with same name for the same owner → HTTP 409."""
    client, _db = client_and_db

    first = client.post("/workspaces", json={"name": "my-ops-workspace"})
    assert first.status_code == 200, first.text

    # Exact duplicate.
    dup = client.post("/workspaces", json={"name": "my-ops-workspace"})
    assert dup.status_code == 409, dup.text
    assert "already exists" in dup.json()["detail"]

    # Case-insensitive duplicate.
    dup_ci = client.post("/workspaces", json={"name": "MY-OPS-WORKSPACE"})
    assert dup_ci.status_code == 409, dup_ci.text

    # Distinct name is still accepted.
    other = client.post("/workspaces", json={"name": "my-ops-workspace-2"})
    assert other.status_code == 200, other.text


# ---------------------------------------------------------------------------
# #1740 — Device-code "already consumed" race → 410 Gone
# ---------------------------------------------------------------------------

@pytest.fixture()
def cli_auth_setup(monkeypatch, tmp_path):
    """Boot the app and pre-create an approved (consumable) device code."""
    main, db = _boot(monkeypatch, tmp_path)
    repos = db.get_repositories()
    now_ts = time.time()

    repos.cli_auth.create_device(
        user_id="local-user",
        device_code="test-device-1740",
        user_code="XXXX-YYYY",
        status="approved",
        secret="wos_consumed_test_token_value",
        client_name="test-cli-1740",
        scopes=[],
        created_ip="127.0.0.1",
        created_at=now_ts,
        expires_at=now_ts + 600,
    )
    yield main, db, repos
    try:
        db.get_repositories.cache_clear()
    except AttributeError:
        pass  # monkeypatched during the test; no cache to clear
    _purge_modules()


def test_consumed_device_code_returns_410(cli_auth_setup, monkeypatch):
    """#1740: polling a device code that consume() returns None for -> HTTP 410 Gone.

    Simulates the race: two concurrent polls both see status='approved', then
    both try repos.cli_auth.consume(). The loser gets None back because the
    winner already deleted the row. Reproduced by monkeypatching consume() to
    return None while get_by_device_code() still returns the approved record.
    """
    main, db, repos = cli_auth_setup

    real_record = repos.cli_auth.get_by_device_code("test-device-1740")
    assert real_record is not None, "pre-condition: device code must exist"
    assert real_record.get("status") == "approved"

    # Patch consume() to simulate the concurrent-delete race.
    original_consume = repos.cli_auth.consume
    def _fake_consume(device_code):
        return None  # race loser: row deleted by concurrent request
    repos.cli_auth.consume = _fake_consume

    # Patch get_repositories to return our monkeypatched repos.
    def _get_patched_repos():
        return repos
    monkeypatch.setattr(db, 'get_repositories', _get_patched_repos)

    from fastapi.testclient import TestClient
    with TestClient(
        main.app,
        headers={"x-floom-secret": "test-secret-fixes"},
        base_url="https://testserver",
    ) as client:
        resp = client.get("/cli-auth/poll/test-device-1740")
        assert resp.status_code == 410, (
            "#1740 regression: device code race (consume returns None) should be "
            "410 Gone, got %d: %s" % (resp.status_code, resp.text)
        )
        detail = resp.json().get("detail", "")
        assert "consumed" in detail.lower() or "expired" in detail.lower(), (
            "410 response should mention consumed/expired, got: %r" % detail
        )

    repos.cli_auth.consume = original_consume


def test_expired_then_polled_device_code_returns_404(cli_auth_setup):
    """A device code that expired naturally (not consumed) returns 404, not 410.

    The 410 is reserved for the consumed-race case; a genuinely expired
    (never-approved, time-elapsed) code still returns 404 so the CLI shows
    "code not found / try again" rather than "expired before approval".
    """
    main, db, repos = cli_auth_setup
    now_ts = time.time()

    # Create a code that already expired.
    repos.cli_auth.create_device(
        user_id="local-user",
        device_code="test-device-expired",
        user_code="ZZZZ-0000",
        status="pending",
        secret=None,
        client_name="test-cli-expired",
        scopes=[],
        created_ip="127.0.0.1",
        created_at=now_ts - 700,
        expires_at=now_ts - 100,  # expired 100 s ago
    )

    from fastapi.testclient import TestClient
    with TestClient(
        main.app,
        headers={"x-floom-secret": "test-secret-fixes"},
        base_url="https://testserver",
    ) as client:
        resp = client.get("/cli-auth/poll/test-device-expired")
        assert resp.status_code == 404, resp.text
