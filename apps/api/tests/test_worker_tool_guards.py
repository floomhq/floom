"""Regression tests for #748 — ownership/visibility guards on assistant worker tools.

Guards added to:
  - _tool_workers_get  (can_view: owner OR workspace-visible + member)
  - _tool_workers_run  (can_run: same as can_view)
  - _tool_workers_update  (owner-only — pre-existing guard, not relaxed)

Scenarios:
  A) User B cannot get/run user A's *private* worker by ID.
  B) User B *can* get/run user A's *workspace*-visible worker when B is an
     active member of the same workspace.
  C) User B cannot update/delete user A's workspace-visible worker
     (update is owner-only regardless of visibility).
  D) Owner (user A) is unaffected: can always get/run/update their own workers.
"""

from __future__ import annotations

import importlib
import sqlite3
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Minimal YAML worker bundle (no exec runner dependencies needed for get/run
# smoke tests at the tool-guard layer).
# ---------------------------------------------------------------------------

_WORKER_YML = """\
schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "Guard test worker."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Boot the API layer with a fresh isolated DB."""
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-748-guards")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "runner_sandbox", "run_service", "chat_service", "scheduler", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    chat_service = importlib.import_module("chat_service")
    importlib.import_module("main")  # registers helpers used by chat_service

    yield {
        "db": db,
        "chat_service": chat_service,
        "workers_dir": workers_dir,
    }
    db.get_repositories.cache_clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_worker_direct(db, worker_id: str, owner_id: str, workspace_id: str,
                           visibility: str = "private") -> None:
    """Insert a minimal worker row directly into the DB for test setup.

    We bypass the full materialization stack (no disk files needed) because the
    guard tests only check DB-level access control — they never actually execute
    the worker.
    """
    from db import get_db as _get_db
    now = "2024-01-01T00:00:00"
    sv_id = f"sv-{worker_id}"
    with _get_db() as conn:
        # skill_versions: (id, name, version, manifest_json, bundle_path, created_at)
        conn.execute(
            """
            INSERT OR IGNORE INTO skill_versions
                (id, name, version, manifest_json, bundle_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (sv_id, worker_id, "0.1.0", "{}", None, now),
        )
        conn.execute(
            """
            INSERT INTO workers
                (id, skill_version_id, name, trigger_type, enabled,
                 owner_id, workspace_id, visibility, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (worker_id, sv_id, worker_id, "manual", 1,
             owner_id, workspace_id, visibility, now),
        )


def _add_workspace_member(db, workspace_id: str, user_id: str,
                           role: str = "member") -> None:
    """Insert an active workspace_members row for test setup."""
    from db import get_db as _get_db
    now = "2024-01-01T00:00:00"
    with _get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO workspace_members
                (workspace_id, user_id, email, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)
            """,
            (workspace_id, user_id, f"{user_id}@test.local", role, now, now),
        )


# ---------------------------------------------------------------------------
# A) Private worker: another user cannot get or run it.
# ---------------------------------------------------------------------------

def test_private_worker_get_blocked_for_non_owner(env):
    """User B cannot read user A's private worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "priv-worker-a", owner_id="alice",
                          workspace_id="ws-a", visibility="private")

    result = cs._tool_workers_get({"id": "priv-worker-a"}, user_id="bob")
    assert result["ok"] is False
    # Must not leak existence — error must look like generic not-found.
    assert "not found" in result["error"].lower()


def test_private_worker_run_blocked_for_non_owner(env, monkeypatch):
    """User B cannot run user A's private worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "priv-run-a", owner_id="alice",
                          workspace_id="ws-a", visibility="private")

    # Patch create_run/start_run so we don't need a real runner.
    monkeypatch.setattr("run_service.create_run", lambda *a, **kw: "run-x", raising=False)
    monkeypatch.setattr("run_service.start_run", lambda *a, **kw: None, raising=False)

    result = cs._tool_workers_run({"id": "priv-run-a"}, user_id="bob")
    assert result["ok"] is False
    assert "not found" in result["error"].lower()


# ---------------------------------------------------------------------------
# B) Workspace-visible worker: member can get and run it.
# ---------------------------------------------------------------------------

def test_workspace_worker_get_allowed_for_member(env):
    """User B (active member) can read user A's workspace-visible worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "shared-worker-a", owner_id="alice",
                          workspace_id="ws-shared", visibility="workspace")
    _add_workspace_member(db, workspace_id="ws-shared", user_id="bob", role="member")

    result = cs._tool_workers_get({"id": "shared-worker-a"}, user_id="bob")
    assert result["ok"] is True
    assert result["worker"]["id"] == "shared-worker-a"


def test_workspace_worker_run_allowed_for_member(env, monkeypatch):
    """User B (active member) can run user A's workspace-visible worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "shared-run-a", owner_id="alice",
                          workspace_id="ws-shared", visibility="workspace")
    _add_workspace_member(db, workspace_id="ws-shared", user_id="bob", role="member")

    # Stub out inputs-validation (no real manifest).
    monkeypatch.setattr("run_service.get_worker_config_for_run", lambda wid: None, raising=False)
    monkeypatch.setattr("run_service.create_run",
                        lambda *a, **kw: "run-shared-ok", raising=False)
    monkeypatch.setattr("run_service.start_run", lambda *a, **kw: None, raising=False)

    result = cs._tool_workers_run({"id": "shared-run-a"}, user_id="bob")
    assert result["ok"] is True
    assert result["run_id"] == "run-shared-ok"


def test_workspace_worker_get_blocked_for_non_member(env):
    """User C (not in the workspace) cannot read a workspace-visible worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "shared-worker-b", owner_id="alice",
                          workspace_id="ws-shared-b", visibility="workspace")
    # carol is NOT added to ws-shared-b

    result = cs._tool_workers_get({"id": "shared-worker-b"}, user_id="carol")
    assert result["ok"] is False
    assert "not found" in result["error"].lower()


# ---------------------------------------------------------------------------
# C) Workspace-visible worker: non-owner cannot update it.
# ---------------------------------------------------------------------------

def test_workspace_worker_update_blocked_for_non_owner(env):
    """Update is owner-only regardless of visibility — member is blocked."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "shared-upd-a", owner_id="alice",
                          workspace_id="ws-upd", visibility="workspace")
    _add_workspace_member(db, workspace_id="ws-upd", user_id="bob", role="member")

    result = cs._tool_workers_update(
        {"id": "shared-upd-a", "yaml_text": "name: foo\n"}, user_id="bob"
    )
    assert result["ok"] is False
    # Error indicates ownership requirement (not a generic server error).
    error_lower = result["error"].lower()
    assert "not found" in error_lower or "not owned" in error_lower


# ---------------------------------------------------------------------------
# D) Owner is always unaffected.
# ---------------------------------------------------------------------------

def test_owner_can_always_get_their_own_worker(env):
    """Owner can get their own private worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "priv-owner-get", owner_id="alice",
                          workspace_id="ws-a", visibility="private")

    result = cs._tool_workers_get({"id": "priv-owner-get"}, user_id="alice")
    assert result["ok"] is True
    assert result["worker"]["id"] == "priv-owner-get"


def test_owner_can_run_their_own_worker(env, monkeypatch):
    """Owner can run their own private worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "priv-owner-run", owner_id="alice",
                          workspace_id="ws-a", visibility="private")

    monkeypatch.setattr("run_service.get_worker_config_for_run", lambda wid: None, raising=False)
    monkeypatch.setattr("run_service.create_run",
                        lambda *a, **kw: "run-owner-ok", raising=False)
    monkeypatch.setattr("run_service.start_run", lambda *a, **kw: None, raising=False)

    result = cs._tool_workers_run({"id": "priv-owner-run"}, user_id="alice")
    assert result["ok"] is True
    assert result["run_id"] == "run-owner-ok"


# ---------------------------------------------------------------------------
# E) "shared" visibility alias (cloud-side naming — must also be allowed).
# ---------------------------------------------------------------------------

def test_shared_visibility_alias_allows_member_get(env):
    """A worker stored with visibility='shared' is treated like 'workspace'."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "alias-shared-a", owner_id="alice",
                          workspace_id="ws-alias", visibility="shared")
    _add_workspace_member(db, workspace_id="ws-alias", user_id="bob", role="member")

    result = cs._tool_workers_get({"id": "alias-shared-a"}, user_id="bob")
    assert result["ok"] is True
    assert result["worker"]["id"] == "alias-shared-a"


# ---------------------------------------------------------------------------
# F) List/run parity — a user must never see a worker they cannot run/get.
#    Regression for the worker-list-run-parity bug: workers__list_all was
#    showing workspace-visible workers to non-members (no membership check),
#    while workers__run/get correctly required active membership, causing
#    "Worker not found" on workers that appeared in the list.
# ---------------------------------------------------------------------------

def test_list_does_not_show_workspace_worker_to_non_member(env, monkeypatch):
    """workers__list_all must NOT include another user's workspace worker
    when the caller is not an active member of that workspace."""
    db = env["db"]
    cs = env["chat_service"]

    # alice owns a workspace-visible worker; carol is NOT a member.
    _create_worker_direct(db, "ws-worker-parity", owner_id="alice",
                          workspace_id="ws-parity", visibility="workspace")

    result = cs._tool_workers_list_all({}, user_id="carol")
    listed_ids = {w["id"] for w in result["workers"]}
    assert "ws-worker-parity" not in listed_ids, (
        "carol is not a member of ws-parity and must not see ws-worker-parity in the list"
    )


def test_list_shows_workspace_worker_to_active_member(env):
    """workers__list_all MUST include another user's workspace worker when
    the caller is an active member of that workspace."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "ws-worker-member", owner_id="alice",
                          workspace_id="ws-member-parity", visibility="workspace")
    _add_workspace_member(db, workspace_id="ws-member-parity", user_id="bob", role="member")

    result = cs._tool_workers_list_all({}, user_id="bob")
    listed_ids = {w["id"] for w in result["workers"]}
    assert "ws-worker-member" in listed_ids, (
        "bob is an active member of ws-member-parity and must see ws-worker-member in the list"
    )


def test_list_run_parity_member_can_get_every_listed_worker(env, monkeypatch):
    """Property test: every worker in workers__list_all must be gettable
    by the same user (no list/run gap)."""
    db = env["db"]
    cs = env["chat_service"]

    # alice owns a private worker in ws-a.
    _create_worker_direct(db, "alice-private", owner_id="alice",
                          workspace_id="ws-a", visibility="private")
    # alice owns a workspace worker in ws-shared.
    _create_worker_direct(db, "alice-shared", owner_id="alice",
                          workspace_id="ws-shared", visibility="workspace")
    # bob owns his own private worker.
    _create_worker_direct(db, "bob-private", owner_id="bob",
                          workspace_id="ws-a", visibility="private")

    # bob is a member of ws-shared only.
    _add_workspace_member(db, workspace_id="ws-shared", user_id="bob", role="member")

    listed = cs._tool_workers_list_all({}, user_id="bob")
    for w in listed["workers"]:
        get_result = cs._tool_workers_get({"id": w["id"]}, user_id="bob")
        assert get_result["ok"] is True, (
            f"Worker {w['id']} appeared in bob's list but get returned: {get_result['error']}"
        )


def test_non_member_cannot_run_workspace_worker_not_in_list(env, monkeypatch):
    """A user who cannot see a workspace worker in the list also cannot run it
    (defence-in-depth: even if they guess the ID directly)."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "guessed-worker", owner_id="alice",
                          workspace_id="ws-guess", visibility="workspace")
    # carol is NOT a member of ws-guess.

    monkeypatch.setattr("run_service.create_run", lambda *a, **kw: "run-x", raising=False)
    monkeypatch.setattr("run_service.start_run", lambda *a, **kw: None, raising=False)

    run_result = cs._tool_workers_run({"id": "guessed-worker"}, user_id="carol")
    assert run_result["ok"] is False
    assert "not found" in run_result["error"].lower()


def test_stock_worker_always_listed_and_runnable_for_member(env, monkeypatch):
    """Stock/public workers must appear in any user's list and be runnable,
    even when the DB row has a different owner and no workspace membership."""
    from main import PUBLIC_STOCK_WORKER_IDS
    if not PUBLIC_STOCK_WORKER_IDS:
        return  # nothing to test if list is empty

    db = env["db"]
    cs = env["chat_service"]

    # Seed the first public stock worker in the DB with a different owner and
    # a workspace the calling user is NOT a member of.
    stock_id = next(iter(sorted(PUBLIC_STOCK_WORKER_IDS)))
    _create_worker_direct(db, stock_id, owner_id="alice",
                          workspace_id="ws-stock", visibility="workspace")
    # emily-test is NOT a member of ws-stock.

    listed = cs._tool_workers_list_all({}, user_id="emily-test")
    listed_ids = {w["id"] for w in listed["workers"]}
    assert stock_id in listed_ids, (
        f"Stock worker {stock_id} must always appear in any user's list"
    )

    # Also verify _worker_can_view returns True for it.
    from db import get_db as _get_db
    with _get_db() as conn:
        assert cs._worker_can_view(conn, stock_id, "emily-test") is True, (
            f"Stock worker {stock_id} must always be viewable/runnable"
        )


# ---------------------------------------------------------------------------
# G) #872 — curated PUBLIC_STOCK_WORKER_IDS no longer leaks the tenant's real
#    private workers. A worker REMOVED from the stock set (gmail-summarize-latest,
#    which reads the operator's real Gmail) must 404 for a non-owner member, even
#    though it is a git-tracked worker with a DB row owned by someone else.
#    A worker RETAINED in the stock set (node-smoke-test) stays accessible.
# ---------------------------------------------------------------------------

# Workers that were previously in PUBLIC_STOCK_WORKER_IDS and/or
# PROTECTED_STOCK_WORKER_IDS but are actually the tenant's real private workers
# (they read the operator's real Gmail / PostHog / GSC / Notion / CRM data). They
# must NOT be world-accessible via EITHER set (#872). _worker_can_view grants
# read/run when a worker is in PUBLIC *or* PROTECTED, so both must be clean.
_REMOVED_PRIVATE_WORKER_IDS = (
    "gmail-summarize-latest",
    "analytics-daily-demo",
    "seo-opportunity-digest",
    "resume_helper",
    "gmail_intake_brief",
    "dach_compliance",
    "crm_matcher",
    "weekly_update",
)


def test_removed_private_workers_not_in_any_stock_set():
    """Regression: none of the tenant's real private workers may appear in
    PUBLIC_STOCK_WORKER_IDS or PROTECTED_STOCK_WORKER_IDS. _worker_can_view
    bypasses ownership/visibility for members of EITHER set, so a re-add to
    either one re-opens the #872 leak."""
    from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS
    removed = set(_REMOVED_PRIVATE_WORKER_IDS)
    leaked_public = sorted(removed & PUBLIC_STOCK_WORKER_IDS)
    leaked_protected = sorted(removed & PROTECTED_STOCK_WORKER_IDS)
    assert not leaked_public, (
        f"Tenant-private workers leaking via PUBLIC_STOCK_WORKER_IDS: {leaked_public}"
    )
    assert not leaked_protected, (
        f"Tenant-private workers leaking via PROTECTED_STOCK_WORKER_IDS: {leaked_protected}"
    )


def test_removed_private_worker_get_blocked_for_non_owner_member(env):
    """#872: gmail-summarize-latest was removed from the stock set, so a
    non-owner member who is NOT in its workspace must get 'not found' — the
    stock-worker bypass no longer applies."""
    db = env["db"]
    cs = env["chat_service"]

    from main import PUBLIC_STOCK_WORKER_IDS
    assert "gmail-summarize-latest" not in PUBLIC_STOCK_WORKER_IDS, (
        "gmail-summarize-latest must be removed from PUBLIC_STOCK_WORKER_IDS (#872)"
    )

    # alice owns the (formerly-leaked) worker as a PRIVATE worker.
    _create_worker_direct(db, "gmail-summarize-latest", owner_id="alice",
                          workspace_id="ws-private-872", visibility="private")
    # bob is a member of a DIFFERENT workspace, not ws-private-872.
    _add_workspace_member(db, workspace_id="ws-other", user_id="bob", role="member")

    result = cs._tool_workers_get({"id": "gmail-summarize-latest"}, user_id="bob")
    assert result["ok"] is False, (
        "bob must not be able to read alice's private gmail-summarize-latest worker"
    )
    assert "not found" in result["error"].lower()


def test_removed_private_worker_run_blocked_for_non_owner_member(env, monkeypatch):
    """#872: bob cannot RUN alice's private gmail-summarize-latest worker."""
    db = env["db"]
    cs = env["chat_service"]

    _create_worker_direct(db, "gmail-summarize-latest", owner_id="alice",
                          workspace_id="ws-private-872b", visibility="private")
    _add_workspace_member(db, workspace_id="ws-other-b", user_id="bob", role="member")

    monkeypatch.setattr("run_service.create_run", lambda *a, **kw: "run-x", raising=False)
    monkeypatch.setattr("run_service.start_run", lambda *a, **kw: None, raising=False)

    result = cs._tool_workers_run({"id": "gmail-summarize-latest"}, user_id="bob")
    assert result["ok"] is False
    assert "not found" in result["error"].lower()


def test_retained_stock_worker_still_accessible_to_non_owner(env):
    """#872: node-smoke-test stays in the curated stock set, so any user can
    view/run it even with a different DB owner and no shared workspace."""
    db = env["db"]
    cs = env["chat_service"]

    from main import PUBLIC_STOCK_WORKER_IDS
    assert "node-smoke-test" in PUBLIC_STOCK_WORKER_IDS, (
        "node-smoke-test must remain a public stock worker (E2E + benign smoke)"
    )

    # Seed it owned by alice in a workspace bob is NOT a member of.
    _create_worker_direct(db, "node-smoke-test", owner_id="alice",
                          workspace_id="ws-stock-872", visibility="workspace")

    result = cs._tool_workers_get({"id": "node-smoke-test"}, user_id="bob")
    assert result["ok"] is True, (
        f"node-smoke-test must stay accessible to any user: {result.get('error')}"
    )
    assert result["worker"]["id"] == "node-smoke-test"

    from db import get_db as _get_db
    with _get_db() as conn:
        assert cs._worker_can_view(conn, "node-smoke-test", "bob") is True
