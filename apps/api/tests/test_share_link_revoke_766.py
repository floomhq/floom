"""#766 — revoking a share link deletes it; the public token then 404s, and a
fresh link gets a new token (proving the row was removed).
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "share-revoke-secret"


def _worker_yml(name: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{name.title()}"
description: "A worker."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "local"
  command: "python run.py"
inputs: []
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    (workers_dir / "sharer").mkdir(parents=True)
    (workers_dir / "sharer" / "worker.yml").write_text(_worker_yml("sharer"), encoding="utf-8")
    (workers_dir / "sharer" / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler", "main"]:
        sys.modules.pop(name, None)
    import types
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def test_revoke_share_link_invalidates_token(client):
    created = client.post("/workers/sharer/share-link")
    assert created.status_code == 200, created.text
    token = created.json()["token"]

    # Public resolve works before revoke.
    assert client.get(f"/s/{token}").status_code == 200

    # Revoke.
    revoked = client.delete("/workers/sharer/share-link")
    assert revoked.status_code == 204, revoked.text

    # Token now 404s.
    assert client.get(f"/s/{token}").status_code == 404

    # A fresh link mints a NEW token (old row truly gone).
    again = client.post("/workers/sharer/share-link")
    assert again.status_code == 200
    assert again.json()["token"] != token


def test_revoke_is_idempotent(client):
    # Revoking with no existing link is a no-op 204, not an error.
    assert client.delete("/workers/sharer/share-link").status_code == 204
