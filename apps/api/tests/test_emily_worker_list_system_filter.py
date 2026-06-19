"""#841 (REVERSED, seed-all model) — Emily's worker list hides ONLY genuine
system/internal workers; example/"starter" workers are now real, owned,
runnable workers and are SHOWN.

Original #841 also hid ``is_example`` rows from "what workers do I have?".
That has been reversed: example/starter workers are seeded as real workers
(exactly as the dashboard worker grid already shows them), so Emily lists and
runs them like any other worker. ``is_example`` is now a cosmetic label only,
never a hiding signal.

Current rule (single source of truth): a row is hidden by default iff
``_worker_hidden_from_api(id, owned)`` is True (the ``_SYSTEM_WORKER_IDS`` set
— workspace-agent / worker-author / slack-listener / whatsapp-listener — plus
"."/``_mcp_``/``audit-local-``/``smoke-`` ids) OR the manifest declares
``system_worker: true``. The response still carries ``hidden_system_count`` so
Emily can mention those exist, and ``include_system: true`` opts them back in.

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
    # Include `username` so init_db()'s `CREATE UNIQUE INDEX ON users(username)`
    # (run when _tool_workers_list_all imports main, which calls init_db on this
    # seeded DB) does not fail with "no such column: username". The minimal
    # (id, role) shape collided with the real users-table migration when this
    # file ran in isolation (main not already imported by an earlier test).
    c.execute("CREATE TABLE users (id TEXT, username TEXT, role TEXT)")
    c.execute("INSERT INTO users (id, username, role) VALUES ('admin-1','admin-1','admin')")
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


def test_system_workers_hidden_examples_shown_by_default(tmp_path, monkeypatch):
    db = tmp_path / "f1.db"
    _seed_db(db)
    cs = _load_chat_service(monkeypatch, db)

    res = cs._tool_workers_list_all({}, "admin-1")

    ids = {w["id"] for w in res["workers"]}
    # Seed-all model: the example worker is a real, owned worker — it is SHOWN
    # alongside the plain real worker. Only the genuine system worker
    # (system_worker: true) is hidden by default.
    assert ids == {"w-real", "w-example"}
    assert res["count"] == 2
    assert res["hidden_system_count"] == 1


def test_include_system_opts_back_in(tmp_path, monkeypatch):
    db = tmp_path / "f2.db"
    _seed_db(db)
    cs = _load_chat_service(monkeypatch, db)

    res = cs._tool_workers_list_all({"include_system": True}, "admin-1")

    ids = {w["id"] for w in res["workers"]}
    # include_system opts the hidden system worker back in; the example was
    # never hidden, so all three appear.
    assert ids == {"w-real", "w-system", "w-example"}
    assert "hidden_system_count" not in res
