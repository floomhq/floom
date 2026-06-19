from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _load_main(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(api_dir))

    db_path = tmp_path / "floom.db"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    for name in [
        "main",
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "composio_client",
    ]:
        sys.modules.pop(name, None)

    return importlib.import_module("main")


def test_persist_discovered_workers_does_not_reenter_sqlite_repo(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    worker = {
        "id": "local-discovery-smoke",
        "name": "Local Discovery Smoke",
        "manifest": {
            "name": "local-discovery-smoke",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
        },
        "config": {"trigger": {"type": "manual"}},
    }

    with main.get_db() as conn:
        main._persist_discovered_workers(conn, [worker], user_id="local-user")

    with main.get_db() as conn:
        row = conn.execute(
            "SELECT id, name, owner_id FROM workers WHERE id = ?",
            (worker["id"],),
        ).fetchone()

    assert row is not None
    assert row["name"] == worker["name"]
    assert row["owner_id"] == "local-user"
