"""Round-09 P0 #1 — the 1-vs-9 workers split-brain.

The dashboard worker grid (``repos.workers.list``, owner+workspace-member
scoped) and Emily's ``workers__list_all`` tool (``_tool_workers_list_all`` ->
``repos.workers.list_for_agent``) MUST report the SAME worker set for the same
user/workspace. Live regression: the grid header read "1 workers" while Emily's
tool returned 9 — the extra 8 were SEEDED stock/example/test workers the user
does NOT own (csv_enricher, worker-author, node-smoke-test, …) that Emily's
``list_for_agent`` pulls in via the stock-id padding clause + the
``visibility IN ('workspace','shared','public')`` clause, but the owner-scoped
grid never shows on cloud.

Fix: ``_tool_workers_list_all`` excludes seeded stock/example/test workers the
caller does NOT own from the user-facing list (footnoted in
``hidden_system_count``), so the count matches the grid. A stock worker the user
genuinely OWNS (the OSS seed-all case) is still shown — the discriminator is
ownership, not the cosmetic ``is_example`` label.

Run:
    cd apps/api && python -m pytest tests/test_emily_worker_split_brain_round09.py -v
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_NOW = "2026-01-01T00:00:00Z"


def _load_modules(monkeypatch, db_path: Path):
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    for name in list(sys.modules):
        if name in ("chat_service",) or name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)
    import db
    db.init_db()
    import chat_service
    return db, chat_service


def _user(c, uid, role):
    c.execute(
        "INSERT OR REPLACE INTO users (id,username,role,disabled,password_hash,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (uid, uid, role, 0, "x", _NOW, _NOW),
    )


def _member(c, ws, uid, role):
    c.execute(
        "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (ws, uid, role, "active", _NOW, _NOW),
    )


def _sv(c, svid, manifest):
    c.execute(
        "INSERT INTO skill_versions (id,name,version,manifest_json,bundle_path,created_at) "
        "VALUES (?,?,?,?,?,?)",
        (svid, svid, "1.0", json.dumps(manifest), "/x", _NOW),
    )


def _worker(c, wid, svid, owner, ws, vis):
    c.execute(
        "INSERT INTO workers (id,skill_version_id,name,owner_id,workspace_id,visibility,enabled,created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (wid, svid, wid, owner, ws, vis, 1, _NOW),
    )


def test_emily_count_matches_grid_seeded_stock_excluded(tmp_path, monkeypatch):
    db = tmp_path / "split.db"
    dbmod, cs = _load_modules(monkeypatch, db)

    c = sqlite3.connect(db)
    _user(c, "op-1", "member")
    _user(c, "vendor", "admin")
    _member(c, "local-default", "op-1", "owner")
    # The ONE worker the operator owns — this is what the grid shows.
    _sv(c, "sv-mine", {"title": "My worker"})
    _worker(c, "my-worker", "sv-mine", "op-1", "local-default", "private")
    # SEEDED stock/example/test workers the operator does NOT own. On cloud these
    # are owned by the vendor/seed identity, public-visible, so Emily's
    # list_for_agent pulls them in via the stock-id padding + public clause, but
    # the owner-scoped grid never shows them. These are the "extra 8".
    _sv(c, "sv-csv", {"title": "CSV Enricher", "is_example": True})
    _worker(c, "csv_enricher", "sv-csv", "vendor", "seed-ws", "public")
    _sv(c, "sv-wa", {"title": "Worker Author", "system_worker": True})
    _worker(c, "worker-author", "sv-wa", "vendor", "seed-ws", "public")
    _sv(c, "sv-nst", {"title": "node-smoke-test", "is_example": True})
    _worker(c, "node-smoke-test", "sv-nst", "vendor", "seed-ws", "public")
    _sv(c, "sv-rb", {"title": "Research Brief", "is_example": True})
    _worker(c, "research_brief", "sv-rb", "vendor", "seed-ws", "public")
    c.commit()
    c.close()

    # What the dashboard worker grid shows: repos.workers.list (owner-scoped,
    # member role) — the operator's own worker only.
    grid_rows = dbmod.get_repositories().workers.list(user_id="op-1", role="member")
    grid_ids = {r["id"] for r in grid_rows}
    assert grid_ids == {"my-worker"}, grid_ids

    # What Emily reports: _tool_workers_list_all. Must equal the grid set.
    res = cs._tool_workers_list_all({}, "op-1")
    emily_ids = {w["id"] for w in res["workers"]}

    assert emily_ids == grid_ids, (
        f"split-brain: Emily {sorted(emily_ids)} != grid {sorted(grid_ids)}"
    )
    assert res["count"] == len(grid_ids) == 1
    # The seeded stock/example/test workers the operator does not own are
    # footnoted, never counted as the operator's workers.
    assert res.get("hidden_system_count", 0) >= 3


def test_owned_example_still_shown(tmp_path, monkeypatch):
    """An example worker the operator GENUINELY owns (OSS seed-all) is still
    shown — the discriminator is ownership, not the is_example label."""
    db = tmp_path / "owned.db"
    dbmod, cs = _load_modules(monkeypatch, db)

    c = sqlite3.connect(db)
    _user(c, "op-1", "member")
    _member(c, "local-default", "op-1", "owner")
    _sv(c, "sv-mine", {"title": "My worker"})
    _worker(c, "my-worker", "sv-mine", "op-1", "local-default", "private")
    # operator OWNS this example copy
    _sv(c, "sv-rb", {"title": "My Research Brief", "is_example": True})
    _worker(c, "my-research_brief", "sv-rb", "op-1", "local-default", "private")
    c.commit()
    c.close()

    res = cs._tool_workers_list_all({}, "op-1")
    ids = {w["id"] for w in res["workers"]}
    assert ids == {"my-worker", "my-research_brief"}, ids
    assert res["count"] == 2
