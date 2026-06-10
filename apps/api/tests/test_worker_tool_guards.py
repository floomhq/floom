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
