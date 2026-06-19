"""#765 — share a RUN via a read-only public link.

Runs had no share-link equivalent (workers/brain/workspace did). Adds
POST /runs/{id}/share-link (owner mints a token), DELETE (revoke), and
GET /runs/public/{id}?token= (anonymous read-only run view). Reuses the
standalone_share_links infra with entity_type='run'.

Run: cd apps/api && python -m pytest tests/test_run_share_link.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-runshare"
OWNER = "local-user"

_YML = """\
schema_version: "0.3"
name: "sharedrun"
title: "Shared Run Worker"
description: "produces a run we can share"
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
    wdir = workers_dir / "sharedrun"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
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
        for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
            sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)
    repos = main.get_repositories()
    repos.runs.create(
        user_id=OWNER,
        run_id="run_share_1",
        worker_id="sharedrun",
        status=main.RunStatus.COMPLETED.value,
        trigger_source="manual",
        runner="e2b",
        input_json={},
        output_json={"answer": "42"},
    )
    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield client, main
    db.get_repositories.cache_clear()


def test_share_then_public_view(client_and_main):
    client, _ = client_and_main
    created = client.post("/runs/run_share_1/share-link")
    assert created.status_code == 200, created.text
    token = created.json()["token"]
    assert token.startswith("fls_")

    # anonymous client (no secret) can read the run via the token
    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    pub = anon.get(f"/runs/public/run_share_1?token={token}")
    assert pub.status_code == 200, pub.text
    assert pub.json()["id"] == "run_share_1"
    assert pub.json()["output"]["answer"] == "42"


def test_share_then_standalone_share_page_payload(client_and_main):
    client, _ = client_and_main
    created = client.post("/runs/run_share_1/share-link")
    assert created.status_code == 200, created.text
    token = created.json()["token"]

    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    pub = anon.get(f"/s/{token}")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    assert body["entity_type"] == "run"
    assert body["title"] == "Run · Shared Run Worker"
    assert body["run"]["id"] == "run_share_1"
    assert body["run"]["output"]["answer"] == "42"


def test_public_view_wrong_token_404(client_and_main):
    client, _ = client_and_main
    client.post("/runs/run_share_1/share-link")
    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    assert anon.get("/runs/public/run_share_1?token=fls_wrongwrongwrong").status_code == 404


def test_token_for_run_cannot_open_other_run(client_and_main):
    client, main = client_and_main
    repos = main.get_repositories()
    repos.runs.create(
        user_id=OWNER, run_id="run_other", worker_id="sharedrun",
        status=main.RunStatus.COMPLETED.value, trigger_source="manual",
        runner="e2b", input_json={}, output_json={},
    )
    token = client.post("/runs/run_share_1/share-link").json()["token"]
    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    # token minted for run_share_1 must not open run_other
    assert anon.get(f"/runs/public/run_other?token={token}").status_code == 404


def test_revoke_disables_public_view(client_and_main):
    client, _ = client_and_main
    token = client.post("/runs/run_share_1/share-link").json()["token"]
    revoked = client.delete("/runs/run_share_1/share-link")
    assert revoked.status_code == 200
    assert revoked.json()["revoked"] is True
    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    assert anon.get(f"/runs/public/run_share_1?token={token}").status_code == 404


def test_share_unknown_run_404(client_and_main):
    client, _ = client_and_main
    assert client.post("/runs/nope/share-link").status_code == 404
