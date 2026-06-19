"""#766 — DELETE share-link endpoints revoke a public link per asset.

standalone_share_links had a create path but no revoke; once a token was
minted the public link could not be disabled. These DELETE endpoints remove
the token row (frontend toggle-off); a later POST re-mints a fresh token.

Run: cd apps/api && python -m pytest tests/test_share_link_revoke.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-sharerevoke"

_YML = """\
schema_version: "0.3"
name: "shareable"
title: "Shareable Worker"
description: "A worker with a public link"
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
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "shareable"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main
    db.get_repositories.cache_clear()


def _token_count(main) -> int:
    with main.get_db() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM standalone_share_links WHERE entity_type='worker'"
        ).fetchone()["c"]


def test_create_then_revoke_worker_share_link(client_and_main):
    client, main = client_and_main
    created = client.post("/workers/shareable/share-link")
    assert created.status_code == 200, created.text
    first_token = created.json()["token"]
    assert _token_count(main) == 1

    revoked = client.delete("/workers/shareable/share-link")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked"] is True
    assert _token_count(main) == 0

    # idempotent: second revoke reports nothing to revoke
    again = client.delete("/workers/shareable/share-link")
    assert again.json()["revoked"] is False

    # re-create mints a FRESH token (toggle off -> on)
    recreated = client.post("/workers/shareable/share-link")
    assert recreated.status_code == 200
    assert recreated.json()["token"] != first_token
    assert _token_count(main) == 1


def test_revoke_unknown_worker_404(client_and_main):
    client, _ = client_and_main
    assert client.delete("/workers/does-not-exist/share-link").status_code == 404
