"""#1139 — Emily Workers tool must return workers for admin users.

Root cause: list_for_agent used LEFT JOIN workspace_members for admin users
who are not in the workspace_members table, so the wm.user_id IS NOT NULL
filter silently dropped all workspace-visible workers.

Fix: admins skip the workspace_members join and see their own + all visible
workers directly.
"""
from __future__ import annotations

import importlib
import json
import os
import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _mk_full_db(path: Path) -> None:
    """Create the canonical schema via init_db (same pattern as other tests)."""
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
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _load_chat_service(monkeypatch, db_path: Path):
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    for name in list(sys.modules):
        if name in ("chat_service", "db") or name.startswith("db."):
            sys.modules.pop(name, None)
    import chat_service
    return chat_service


def test_admin_without_own_workers_sees_workspace_visible(tmp_path, monkeypatch):
    """An admin user who is not in workspace_members must see workspace-visible workers."""
    db = tmp_path / "admin_test.db"
    _mk_full_db(db)
    c = sqlite3.connect(db)
    # Bootstrap user owns the workers
    now = "2026-01-01T00:00:00"
    c.execute("INSERT INTO users (id, role, username, password_hash, disabled, created_at, updated_at) VALUES ('bootstrap-user', 'admin', 'admin', 'x', 0, ?, ?)", (now, now))
    # UUID admin — has no workers of their own, not in workspace_members
    c.execute("INSERT INTO users (id, role, username, password_hash, disabled, created_at, updated_at) VALUES ('uuid-admin-123', 'admin', 'newadmin', 'x', 0, ?, ?)", (now, now))
    # Add skill_versions for manifests
    c.execute("INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at) VALUES ('sv1', 'Private worker', '1', '{}', '', '2026-01-01')")
    c.execute("INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at) VALUES ('sv2', 'Workspace worker', '1', '{}', '', '2026-01-01')")
    c.executescript(
        "INSERT INTO workers (id, name, trigger_type, enabled, owner_id, visibility, workspace_id, skill_version_id, created_at) "
        "VALUES ('w-private', 'Private worker', 'manual', 1, 'bootstrap-user', 'private', 'local-default', 'sv1', '2026-01-01');"
        "INSERT INTO workers (id, name, trigger_type, enabled, owner_id, visibility, workspace_id, skill_version_id, created_at) "
        "VALUES ('w-workspace', 'Workspace worker', 'manual', 1, 'bootstrap-user', 'workspace', 'local-default', 'sv2', '2026-01-01');"
    )
    c.commit()
    c.close()

    cs = _load_chat_service(monkeypatch, db)

    # Call as the UUID admin who has no workers of their own
    res = cs._tool_workers_list_all({}, "uuid-admin-123")

    assert res["ok"] is True, f"Expected ok=True, got: {res}"
    ids = {w["id"] for w in res["workers"]}
    assert "w-workspace" in ids, (
        f"#1139: workspace-visible worker not returned for admin user who lacks workspace_members entry. Got: {ids}"
    )
    assert res["count"] >= 1, "#1139: count is 0 for admin user with workspace-visible workers"


def test_bootstrap_user_sees_own_workers(tmp_path, monkeypatch):
    """The bootstrap owner user must always see their private workers."""
    db = tmp_path / "bootstrap_test.db"
    _mk_full_db(db)
    c = sqlite3.connect(db)
    now = "2026-01-01T00:00:00"
    c.execute("INSERT INTO users (id, role, username, password_hash, disabled, created_at, updated_at) VALUES ('bootstrap-user', 'admin', 'admin', 'x', 0, ?, ?)", (now, now))
    c.execute("INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at) VALUES ('sv1', 'Private worker', '1', '{}', '', '2026-01-01')")
    c.execute("INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at) VALUES ('sv2', 'Workspace worker', '1', '{}', '', '2026-01-01')")
    c.executescript(
        "INSERT INTO workers (id, name, trigger_type, enabled, owner_id, visibility, workspace_id, skill_version_id, created_at) "
        "VALUES ('w-private', 'Private worker', 'manual', 1, 'bootstrap-user', 'private', 'local-default', 'sv1', '2026-01-01');"
        "INSERT INTO workers (id, name, trigger_type, enabled, owner_id, visibility, workspace_id, skill_version_id, created_at) "
        "VALUES ('w-workspace', 'Workspace worker', 'manual', 1, 'bootstrap-user', 'workspace', 'local-default', 'sv2', '2026-01-01');"
    )
    c.commit()
    c.close()

    cs = _load_chat_service(monkeypatch, db)
    res = cs._tool_workers_list_all({}, "bootstrap-user")

    ids = {w["id"] for w in res["workers"]}
    assert "w-private" in ids, (
        f"Bootstrap user must see private workers. Got: {ids}"
    )
    assert "w-workspace" in ids, f"Bootstrap user must see workspace workers. Got: {ids}"
