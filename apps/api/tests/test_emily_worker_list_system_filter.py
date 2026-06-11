"""#841 — Emily's worker list must hide system/example workers by default.

RCA: ``_tool_workers_list_all`` computed ``system_worker`` / ``is_example``
flags from each worker's manifest but never used them — "what workers do I
have?" dumped every system and example worker into the chat card.

Fix: rows flagged system/example are filtered out by default; the response
carries ``hidden_system_count`` so Emily can mention they exist, and the tool
accepts ``include_system: true`` to opt back in.

Run:
    cd apps/api && python -m pytest tests/test_emily_worker_list_system_filter.py -v
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _seed_db(path: Path) -> None:
    c = sqlite3.connect(path)
    c.execute(
        "CREATE TABLE workers (id TEXT, name TEXT, trigger_type TEXT, enabled INTEGER, "
        "owner_id TEXT, visibility TEXT, workspace_id TEXT, skill_version_id TEXT)"
    )
    c.execute("CREATE TABLE skill_versions (id TEXT, manifest_json TEXT)")
    c.execute("CREATE TABLE users (id TEXT, role TEXT)")
    c.execute("INSERT INTO users (id, role) VALUES ('admin-1','admin')")
    rows = [
        ("w-real", "Real worker", "manual", 1, "admin-1", "private", "local-default", "sv-real"),
        ("w-system", "System worker", "manual", 1, "admin-1", "private", "local-default", "sv-system"),
        ("w-example", "Example worker", "manual", 1, "admin-1", "private", "local-default", "sv-example"),
    ]
    c.executemany("INSERT INTO workers VALUES (?,?,?,?,?,?,?,?)", rows)
    manifests = [
        ("sv-real", json.dumps({"title": "Real"})),
        ("sv-system", json.dumps({"title": "Sys", "system_worker": True})),
        ("sv-example", json.dumps({"title": "Example", "is_example": True})),
    ]
    c.executemany("INSERT INTO skill_versions VALUES (?,?)", manifests)
    c.commit()
    c.close()


def _load_chat_service(monkeypatch, db_path: Path):
    # set BOTH: some suite files leak a module-level WORKEROS_DB, which takes
    # priority over FLOOM_DB in db/sqlite.py's path resolution
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    for name in list(sys.modules):
        if name in ("chat_service",) or name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)
    import chat_service

    return chat_service


def test_system_and_example_workers_hidden_by_default(tmp_path, monkeypatch):
    db = tmp_path / "f1.db"
    _seed_db(db)
    cs = _load_chat_service(monkeypatch, db)

    res = cs._tool_workers_list_all({}, "admin-1")

    ids = {w["id"] for w in res["workers"]}
    assert ids == {"w-real"}
    assert res["count"] == 1
    assert res["hidden_system_count"] == 2


def test_include_system_opts_back_in(tmp_path, monkeypatch):
    db = tmp_path / "f2.db"
    _seed_db(db)
    cs = _load_chat_service(monkeypatch, db)

    res = cs._tool_workers_list_all({"include_system": True}, "admin-1")

    ids = {w["id"] for w in res["workers"]}
    assert ids == {"w-real", "w-system", "w-example"}
    assert "hidden_system_count" not in res
