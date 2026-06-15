"""#1080 — example workers must not inflate the dashboard headline.

A brand-new operator with 0 real workers previously saw the dashboard report
active/needs-attention counts sourced from `is_example` workers (often owned by
other workspaces), while Emily (#841) reported zero. The two surfaces must
agree: example/stock workers are shipped templates, not the operator's own
workers, so they are excluded from the active/paused headline counts and from
the needs-attention inbox.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(name: str, *, is_example: bool) -> str:
    example_line = "is_example: true\n" if is_example else ""
    return f"""\
schema_version: '0.3'
name: {name}
title: {name}
description: probe worker for #1080 overview test.
version: 0.1.0
{example_line}targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
secrets:
- {name.upper().replace('-', '_')}_SECRET
trigger:
  type: manual
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    specs = {"real-probe": False, "example-probe": True}
    for name, is_example in specs.items():
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(_worker_yml(name, is_example=is_example), encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
        (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-1080")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    repos = db.get_repositories()

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-1080"}) as client:
        yield client, main, repos
    db.get_repositories.cache_clear()


def test_example_worker_excluded_from_counts_and_attention(client_and_main):
    client, main, _repos = client_and_main

    resp = client.get("/system/overview")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Only the real worker counts toward the active headline; the example does not.
    assert body["stats"]["active_workers_count"] == 1, body["stats"]

    # The example worker (which also declares a missing secret) must NOT appear
    # in the needs-attention inbox; the real worker, missing its secret, may.
    attention_workers = {item.get("worker_id") for item in body["needs_attention"]}
    assert "example-probe" not in attention_workers, body["needs_attention"]
    assert "real-probe" in attention_workers, body["needs_attention"]
