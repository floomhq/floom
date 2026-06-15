"""#1080 cross-workspace isolation for WorkerRepository.list (member role).

The dashboard worker grid and the overview headline counts both read workers via
``repos.workers.list(user_id, role="member")``. That query used
``WHERE owner_id = ? OR visibility = 'workspace'`` with NO workspace scope, so a
member saw — and the grid/overview counted — every ``visibility='workspace'``
worker GLOBALLY, including workers from OTHER workspaces. Emily's
``list_for_agent`` was already scoped via the ``workspace_members`` join; ``list``
was not, so the two surfaces disagreed and a tenant's workspace-shared workers
leaked cross-workspace.

The fix scopes ``list``'s member branch by ``workspace_members`` exactly like
``list_for_agent``. This test guards it.

Run:
    cd apps/api && python -m pytest tests/test_cross_workspace_list_isolation.py -v
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_NOW = "2026-01-01T00:00:00Z"


def _load_db(monkeypatch, db_path: Path):
    # WORKEROS_DB takes priority over FLOOM_DB in db/sqlite.py path resolution.
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    for name in list(sys.modules):
        if name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)
    import db

    db.init_db()
    return db


def _seed(db_path: Path) -> None:
    c = sqlite3.connect(db_path)
    for uid in ("rao", "bob", "carol"):
        c.execute(
            "INSERT OR REPLACE INTO users (id,username,role,disabled,password_hash,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (uid, uid, "member", 0, "x", _NOW, _NOW),
        )
    # WS-A = {rao(owner), bob(member)} ; WS-B = {carol(owner)}
    for ws, uid, role in [("ws-a", "rao", "owner"), ("ws-a", "bob", "member"), ("ws-b", "carol", "owner")]:
        c.execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (ws, uid, role, "active", _NOW, _NOW),
        )
    c.execute(
        "INSERT INTO skill_versions (id,name,version,manifest_json,bundle_path,created_at) VALUES (?,?,?,?,?,?)",
        ("sv", "sv", "1.0", "{}", "/x", _NOW),
    )
    # workspace-visible + private workers in each workspace
    workers = [
        ("a-shared", "ws-a", "workspace", "rao"),
        ("a-priv", "ws-a", "private", "rao"),
        ("b-shared", "ws-b", "workspace", "carol"),
        ("b-priv", "ws-b", "private", "carol"),
    ]
    for wid, ws, vis, owner in workers:
        c.execute(
            "INSERT INTO workers (id,skill_version_id,name,owner_id,workspace_id,visibility,enabled,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (wid, "sv", wid, owner, ws, vis, 1, _NOW),
        )
    c.commit()
    c.close()


def test_member_list_does_not_leak_workspace_workers_across_workspaces(tmp_path, monkeypatch):
    db = tmp_path / "xws.db"
    dbmod = _load_db(monkeypatch, db)
    _seed(db)
    repo = dbmod.get_repositories().workers

    def ids(uid):
        return {r["id"] for r in repo.list(user_id=uid, role="member")}

    bob = ids("bob")      # member of WS-A only
    carol = ids("carol")  # member of WS-B only

    # bob (WS-A) sees WS-A's workspace-shared worker, NOT WS-B's.
    assert "a-shared" in bob
    assert "b-shared" not in bob, "cross-workspace leak: bob (WS-A) saw WS-B's workspace worker"
    # private workers never leak to a non-owner.
    assert "a-priv" not in bob  # rao's private
    assert "b-priv" not in bob

    # carol (WS-B) sees WS-B's workspace-shared worker, NOT WS-A's.
    assert "b-shared" in carol
    assert "a-shared" not in carol, "cross-workspace leak: carol (WS-B) saw WS-A's workspace worker"
    assert "a-priv" not in carol


def test_owner_and_admin_still_see_their_workers(tmp_path, monkeypatch):
    db = tmp_path / "xws2.db"
    dbmod = _load_db(monkeypatch, db)
    _seed(db)
    repo = dbmod.get_repositories().workers

    # Owner sees their own private + workspace worker via the owner clause.
    rao = {r["id"] for r in repo.list(user_id="rao", role="member")}
    assert {"a-shared", "a-priv"} <= rao
    assert "b-priv" not in rao  # carol's private, different owner+workspace

    # Admin sees everything regardless of owner/workspace.
    admin = {r["id"] for r in repo.list(user_id="rao", role="admin")}
    assert {"a-shared", "a-priv", "b-shared", "b-priv"} <= admin
