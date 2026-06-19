"""#1080 (REVERSED, seed-all model) — example workers ARE real, owned workers
and DO count toward the dashboard headline + needs-attention.

Original #1080 excluded `is_example` workers from the active/paused headline
and the needs-attention inbox to keep them from inflating a brand-new
operator's dashboard. That has been reversed: example/"starter" workers are
seeded as real, owned, runnable workers — exactly as the dashboard worker grid
already showed them — so they are counted in the headline and surfaced in
needs-attention like any other worker. `is_example` is now a cosmetic label
only. The dashboard and Emily (#841) agree because BOTH now show examples.

The real #1080 fix (cloud) is per-workspace scoping of the visible set, NOT
hiding examples: only GENUINE system/internal workers (system_worker: true or
_worker_hidden_from_api) are excluded from the counts.
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
    # Pin the secret-auth identity to the same user the fixture persists workers
    # under, so the overview request (authenticated via x-floom-secret) resolves
    # to "local-user" and sees the seeded workers. Without this the dev .env loaded
    # by WORKEROS_DEV=1 supplies a different default user id and the overview
    # would see zero workers regardless of the example/system reversal.
    monkeypatch.setenv("WORKEROS_USER_ID", "local-user")
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
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-1080"}) as client:
        yield client, main, repos
    db.get_repositories.cache_clear()


def test_example_worker_counted_and_surfaced(client_and_main):
    client, main, _repos = client_and_main

    resp = client.get("/system/overview")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Seed-all model: BOTH the real worker and the example worker are real,
    # owned, active workers — they both count toward the active headline.
    assert body["stats"]["active_workers_count"] == 2, body["stats"]

    # Both workers declare a missing secret, so BOTH must surface in the
    # needs-attention inbox (the example is no longer treated as a template that
    # is excluded from setup-incomplete prompts).
    attention_workers = {item.get("worker_id") for item in body["needs_attention"]}
    assert "example-probe" in attention_workers, body["needs_attention"]
    assert "real-probe" in attention_workers, body["needs_attention"]
