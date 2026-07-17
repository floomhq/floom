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


_NOW = "2026-01-01T00:00:00Z"


def _seed_db(path: Path) -> None:
    """Seed the REAL schema (init_db already ran against *path*).

    #2270: _tool_workers_list_all now routes through list_operator_workers /
    repos.workers.list, which reads the full workers + skill_versions schema —
    the old hand-rolled 3-column tables no longer parse.
    """
    c = sqlite3.connect(path)
    c.execute(
        "INSERT OR REPLACE INTO users (id,username,role,disabled,password_hash,created_at,updated_at) "
        "VALUES ('admin-1','admin-1','admin',0,'x',?,?)",
        (_NOW, _NOW),
    )
    manifests = [
        ("sv-real", json.dumps({"title": "Real"})),
        ("sv-system", json.dumps({"title": "Sys", "system_worker": True})),
        ("sv-example", json.dumps({"title": "Example", "is_example": True})),
    ]
    for svid, manifest in manifests:
        c.execute(
            "INSERT INTO skill_versions (id,name,version,manifest_json,bundle_path,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (svid, svid, "1.0", manifest, "/x", _NOW),
        )
    rows = [
        ("w-real", "sv-real", "Real worker"),
        ("w-system", "sv-system", "System worker"),
        ("w-example", "sv-example", "Example worker"),
    ]
    for wid, svid, name in rows:
        c.execute(
            "INSERT INTO workers (id,skill_version_id,name,trigger_type,enabled,"
            "owner_id,workspace_id,visibility,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (wid, svid, name, "manual", 1, "admin-1", "local-default", "private", _NOW),
        )
    c.commit()
    c.close()


def _load_chat_service(monkeypatch, db_path: Path):
    # set BOTH: some suite files leak a module-level WORKEROS_DB, which takes
    # priority over FLOOM_DB in db/sqlite.py's path resolution
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    # #2270: canonical listing also enumerates on-disk workers — isolate.
    workers_dir = db_path.parent / "workers-empty"
    workers_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    for name in list(sys.modules):
        if (
            name in ("chat_service", "worker_registry", "runner_utils")
            or name == "db"
            or name.startswith("db.")
        ):
            sys.modules.pop(name, None)
    import db as dbmod

    dbmod.init_db()
    import chat_service

    return chat_service


def test_system_workers_hidden_examples_shown_by_default(tmp_path, monkeypatch):
    db = tmp_path / "f1.db"
    cs = _load_chat_service(monkeypatch, db)
    _seed_db(db)

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
    cs = _load_chat_service(monkeypatch, db)
    _seed_db(db)

    res = cs._tool_workers_list_all({"include_system": True}, "admin-1")

    ids = {w["id"] for w in res["workers"]}
    # include_system opts the hidden system worker back in; the example was
    # never hidden, so all three appear.
    assert ids == {"w-real", "w-system", "w-example"}
    assert "hidden_system_count" not in res
