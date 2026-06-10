from __future__ import annotations

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(name: str, *, title: str, trigger: str = "manual", default_channel: bool = False) -> str:
    default_line = '\n    default: "CDEFAULT123"' if default_channel else ""
    cron = '\n  cron: "*/5 * * * *"' if trigger == "schedule" else ""
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "{title}"
version: "0.1.0"
trigger:
  type: "{trigger}"{cron}
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "local"
  command: "python run.py"
inputs:
  - name: "channel"
    kind: "scalar"
    type: "string"
    required: true
    label: "Channel"{default_line}
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


@pytest.fixture
def app_ctx(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    specs = {
        "sales-summary": _worker_yml("sales-summary", title="Sales Summary"),
        "scheduled-no-default": _worker_yml(
            "scheduled-no-default",
            title="Scheduled No Default",
            trigger="schedule",
        ),
        "scheduled-with-default": _worker_yml(
            "scheduled-with-default",
            title="Scheduled With Default",
            trigger="schedule",
            default_channel=True,
        ),
    }
    for worker_id, yml in specs.items():
        worker_dir = workers_dir / worker_id
        worker_dir.mkdir()
        (worker_dir / "worker.yml").write_text(yml, encoding="utf-8")
        (worker_dir / "run.py").write_text(
            "import json\nfrom pathlib import Path\n"
            "inputs=json.loads(Path('inputs.json').read_text())\n"
            "Path('summary.md').write_text(str(inputs))\n",
            encoding="utf-8",
        )

    db_path = tmp_path / "workeros.db"
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "worker-mgmt-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "scheduler",
        "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": "worker-mgmt-secret"})
    yield client, main, importlib.import_module("scheduler")
    db.get_repositories.cache_clear()


def test_worker_routes_resolve_slug_equivalent_id(app_ctx):
    client, main, _scheduler = app_ctx

    listed = client.get("/workers?shape=list")
    assert listed.status_code == 200, listed.text
    listed_workers = {worker["id"]: worker for worker in listed.json()}
    assert "sales-summary" in listed_workers
    assert listed_workers["sales-summary"]["created_at"]
    assert "updated_at" in listed_workers["sales-summary"]

    detail = client.get("/workers/Sales_Summary")
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == "sales-summary"

    patched = client.patch("/workers/Sales_Summary", json={"input_values": {"channel": "C123"}})
    assert patched.status_code == 200, patched.text
    with main.get_db() as conn:
        row = conn.execute("SELECT input_values_json FROM workers WHERE id = 'sales-summary'").fetchone()
    assert json.loads(row["input_values_json"]) == {"channel": "C123"}

    shared = client.put("/workers/Sales_Summary/visibility", json={"visibility": "workspace"})
    assert shared.status_code == 200, shared.text
    assert shared.json()["visibility"] == "workspace"

    deleted = client.delete("/workers/Sales_Summary")
    assert deleted.status_code == 204, deleted.text
    assert client.get("/workers/sales-summary").status_code == 404


def test_scheduler_skips_missing_required_scheduled_inputs(app_ctx, monkeypatch):
    _client, main, scheduler = app_ctx
    monkeypatch.setattr(scheduler, "start_run", lambda *args, **kwargs: None)
    repos = main.get_repositories()
    now = datetime.now(timezone.utc)
    past = (now - timedelta(minutes=1)).isoformat()

    with main.get_db() as conn:
        conn.execute("UPDATE workers SET enabled = 0 WHERE id != 'scheduled-no-default'")
        conn.execute("UPDATE worker_triggers SET next_run_at = ? WHERE worker_id = 'scheduled-no-default'", (past,))

    considered = scheduler._tick_trigger_rows(repos, now, now.isoformat())

    assert considered == 1
    with main.get_db() as conn:
        runs = conn.execute("SELECT COUNT(*) AS count FROM runs WHERE worker_id = 'scheduled-no-default'").fetchone()
        trigger = conn.execute(
            "SELECT next_run_at FROM worker_triggers WHERE worker_id = 'scheduled-no-default'"
        ).fetchone()
    assert runs["count"] == 0
    assert trigger["next_run_at"] != past


def test_scheduler_uses_manifest_default_inputs_for_schedule_runs(app_ctx, monkeypatch):
    _client, main, scheduler = app_ctx
    monkeypatch.setattr(scheduler, "start_run", lambda *args, **kwargs: None)
    repos = main.get_repositories()
    now = datetime.now(timezone.utc)
    past = (now - timedelta(minutes=1)).isoformat()

    with main.get_db() as conn:
        conn.execute("UPDATE workers SET enabled = 0 WHERE id != 'scheduled-with-default'")
        conn.execute("UPDATE worker_triggers SET next_run_at = ? WHERE worker_id = 'scheduled-with-default'", (past,))

    considered = scheduler._tick_trigger_rows(repos, now, now.isoformat())

    assert considered == 1
    with main.get_db() as conn:
        run = conn.execute(
            "SELECT input_json FROM runs WHERE worker_id = 'scheduled-with-default' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    assert run is not None
    assert json.loads(run["input_json"])["channel"] == "CDEFAULT123"
