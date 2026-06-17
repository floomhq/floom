"""Round-09 gap #1 — PATCH /workers/{id} {input_values} round-trips through GET.

The recipe column `input_values_json` is what scheduled/automated runs merge over
schema defaults (scheduler._effective_scheduled_inputs). PATCH already persists it,
but WorkerDetail GET never surfaced `input_values`, so the Operations > Inputs panel
could not LOAD the saved defaults (write-blind). This test pins the round-trip:
PATCH input_values -> GET WorkerDetail.input_values reflects it.

Run: cd apps/api && python -m pytest tests/test_worker_input_values_roundtrip.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-inputvals"

_YML = """\
schema_version: "0.3"
name: "iv-worker"
title: "Input Values Worker"
description: "scheduled digest"
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 8 * * 1"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "period"
    kind: "scalar"
    type: "string"
    required: true
    label: "Period"
  - name: "currency"
    kind: "scalar"
    type: "string"
    required: false
    label: "Currency"
    default: "USD"
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "iv-worker"
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
        main._persist_discovered_workers(conn, workers, user_id="federico")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main, wdir
    db.get_repositories.cache_clear()


def test_get_exposes_input_values_default_empty(client_and_main):
    client, _, _ = client_and_main
    body = client.get("/workers/iv-worker").json()
    # Field must exist on the serialized detail (empty before any save).
    assert "input_values" in body
    assert body["input_values"] in ({}, None) or isinstance(body["input_values"], dict)


def test_patch_input_values_roundtrips_through_get(client_and_main):
    client, _, _ = client_and_main
    resp = client.patch(
        "/workers/iv-worker",
        json={"input_values": {"period": "month", "currency": "EUR"}},
    )
    assert resp.status_code == 200, resp.text
    # The PATCH response itself surfaces the saved recipe.
    assert resp.json().get("input_values") == {"period": "month", "currency": "EUR"}

    # And a fresh GET reflects the saved defaults (what the UI loads).
    again = client.get("/workers/iv-worker").json()
    assert again["input_values"] == {"period": "month", "currency": "EUR"}
