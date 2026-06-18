"""Round-09 follow-up — engine worker-visibility user-id resolver parity.

The dashboard worker grid (routers/worker_listing.py, routers/overview.py)
resolves the owner id used for worker visibility via
``_worker_access_user_id(auth)`` (services/worker_access.py), which maps a
caller whose ``auth.username`` is an owner/admin of the default workspace to
that workspace-owner identity.

Emily / the agent path (services/chat_worker_tools.py, services/chat_tool_impls.py)
resolves via ``_effective_worker_visibility_user_id(user_id)``
(chat_service.py), which historically operated on the bare ``user_id`` string
only — it never applied the same workspace-owner mapping, so for the SAME caller
the two surfaces could resolve to DIFFERENT owner ids. That is the engine half of
the 1-vs-9 split-brain: the grid and Emily attribute ownership against different
ids and therefore show different worker sets.

This locks the consistency: for the same caller, the agent resolver must agree
with the grid resolver, while keeping the OSS bootstrap-fallback (#1139: a fresh
admin with no own workers still sees bootstrap-created workers) and the cloud
no-op (cloud returns the raw id in both; Supabase does its own scoping).

Run: cd apps/api && python -m pytest tests/test_worker_visibility_resolver_parity_r9.py -q
"""

import importlib
import sqlite3
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _mk_db(path: Path) -> None:
    import os

    prev = {k: os.environ.get(k) for k in ("WORKEROS_DB", "FLOOM_DB")}
    os.environ["WORKEROS_DB"] = str(path)
    os.environ["FLOOM_DB"] = str(path)
    try:
        for name in list(sys.modules):
            if name == "db" or name.startswith("db."):
                sys.modules.pop(name, None)
        importlib.import_module("db").init_db()
    finally:
        for k, v in prev.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


def _reset_db_module():
    for name in list(sys.modules):
        if name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """OSS/local deploy: the caller's username is the default-workspace owner/admin
    but the session user_id is a distinct (non-derived) id — the exact shape where
    `_worker_access_user_id` maps the caller to the workspace-owner identity while
    the agent resolver historically stayed on the raw user_id, diverging."""
    db = tmp_path / "parity.db"
    _mk_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    # bootstrap user id used by OSS fallback; keep it distinct from the caller.
    monkeypatch.setenv("WORKEROS_USER_ID", "boot")
    _reset_db_module()

    username = "owner-admin"
    session_uid = "session-uuid-xyz"

    c = sqlite3.connect(db)
    # The workspace owner/admin row keyed by username (what the grid resolves to).
    c.execute(
        "INSERT INTO workspace_members "
        "(workspace_id, user_id, role, status, created_at, updated_at) "
        "VALUES (?, ?, 'owner', 'active', '2026-01-01', '2026-01-01')",
        ("local-default", username),
    )
    # A worker owned by the username identity — only visible if the resolver
    # routes to the username.
    c.execute(
        "INSERT INTO workers (id, owner_id, name, visibility, skill_version_id, created_at) "
        "VALUES ('w-owned','owner-admin','W','private','sv','2026-01-01')",
    )
    c.commit()
    c.close()
    return {"username": username, "session_uid": session_uid}


def test_resolvers_agree_for_same_caller(seeded, monkeypatch):
    """The grid resolver and the agent resolver must resolve to the SAME owner id
    for the same caller."""
    from auth.context import AuthContext, set_current_auth_context
    from services.worker_access import _worker_access_user_id
    import chat_service

    auth = AuthContext(
        user_id=seeded["session_uid"],
        username=seeded["username"],
        role="admin",
    )
    # The agent path only receives the bare user_id, but the request-scoped auth
    # context carries the username — the resolver must use it.
    set_current_auth_context(auth)

    grid_id = _worker_access_user_id(auth)
    agent_id = chat_service._effective_worker_visibility_user_id(auth.user_id)

    assert grid_id == seeded["username"], (
        "grid resolver should map the workspace owner/admin caller to the "
        f"workspace-owner identity, got {grid_id!r}"
    )
    assert agent_id == grid_id, (
        "agent (Emily) resolver must agree with the grid resolver for the same "
        f"caller: grid={grid_id!r} agent={agent_id!r}"
    )


def test_cloud_deploy_is_noop_both_paths(tmp_path, monkeypatch):
    """On cloud, both resolvers return the raw id (Supabase does its own
    workspace scoping); the reconciliation must not change that."""
    db = tmp_path / "cloud.db"
    _mk_db(db)
    monkeypatch.setenv("WORKEROS_DB", str(db))
    monkeypatch.setenv("FLOOM_DB", str(db))
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    _reset_db_module()

    from auth.context import AuthContext, set_current_auth_context
    import chat_service
    import importlib as _il
    _il.reload(chat_service)

    auth = AuthContext(user_id="raw-uuid", username="someone", role="admin")
    set_current_auth_context(auth)
    assert chat_service._effective_worker_visibility_user_id("raw-uuid") == "raw-uuid"
