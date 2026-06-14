"""Tests for scheduled worker input-default detection.

Verifies that the worker detail response correctly surfaces which inputs are
required-but-missing-defaults, so the frontend setup banner can show them.

Specifically tests:
- A scheduled worker with required inputs and no defaults is surfaced correctly.
- A scheduled worker with all defaults set is not flagged.
- A manual worker with required inputs and no defaults is NOT flagged (only schedule matters).
- Updating a worker.yml to add defaults clears the incomplete state.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# Scheduled worker — required input has NO default → banner should show
_SCHEDULED_MISSING_DEFAULTS_YML = """\
schema_version: "0.3"
name: "scheduled-no-defaults"
title: "Scheduled No Defaults"
description: "A scheduled worker with a required input that has no default."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "*/5 * * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "channel_id"
    kind: "scalar"
    type: "string"
    required: true
    label: "Channel ID"
  - name: "max_items"
    kind: "scalar"
    type: "number"
    required: false
    label: "Max Items"
    default: 5
connections: []
"""

# Scheduled worker — all required inputs HAVE defaults → no banner
_SCHEDULED_WITH_DEFAULTS_YML = """\
schema_version: "0.3"
name: "scheduled-with-defaults"
title: "Scheduled With Defaults"
description: "A scheduled worker where all required inputs have defaults."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 9 * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "channel_id"
    kind: "scalar"
    type: "string"
    required: true
    label: "Channel ID"
    default: "123456789012345678"
connections: []
"""

# Manual worker — required input has no default → banner should NOT show
_MANUAL_MISSING_DEFAULTS_YML = """\
schema_version: "0.3"
name: "manual-no-defaults"
title: "Manual No Defaults"
description: "A manual worker — missing defaults do not block scheduled runs."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "channel_id"
    kind: "scalar"
    type: "string"
    required: true
    label: "Channel ID"
connections: []
"""

_SCHEDULED_MISSING_SECRET_YML = """\
schema_version: "0.3"
name: "scheduled-missing-secret"
title: "Scheduled Missing Secret"
description: "A scheduled worker that cannot run until its credential exists."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "*/5 * * * *"
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
secrets:
  - MISSING_API_KEY
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()

    for name, yml in [
        ("scheduled-no-defaults", _SCHEDULED_MISSING_DEFAULTS_YML),
        ("scheduled-with-defaults", _SCHEDULED_WITH_DEFAULTS_YML),
        ("manual-no-defaults", _MANUAL_MISSING_DEFAULTS_YML),
        ("scheduled-missing-secret", _SCHEDULED_MISSING_SECRET_YML),
    ]:
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(yml, encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-defaults")
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
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-defaults"})
    yield client, main, workers_dir
    db.get_repositories.cache_clear()


def _get_worker(client, worker_id: str) -> dict:
    resp = client.get(f"/workers/{worker_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _incomplete_scheduled_inputs(worker: dict) -> list[dict]:
    """Mirror the frontend incompleteScheduledInputs derivation."""
    trigger_type = (worker.get("trigger_type") or "").lower()
    config = worker.get("config", {})
    if trigger_type not in ("schedule", "cron"):
        # Also check config.trigger
        t = config.get("trigger") or {}
        trigger_type = (t.get("type") or "").lower()
    if trigger_type not in ("schedule", "cron"):
        return []
    return [
        inp for inp in config.get("inputs", [])
        if inp.get("required") and (inp.get("default") is None or inp.get("default") == "")
    ]


def test_list_shape_includes_lightweight_input_descriptors(client_and_main):
    client, _, _ = client_and_main
    resp = client.get("/workers?shape=list")
    assert resp.status_code == 200, resp.text

    workers = {worker["id"]: worker for worker in resp.json()}
    inputs = workers["scheduled-no-defaults"]["inputs"]

    assert inputs == [
        {"name": "channel_id", "type": "text"},
        {"name": "max_items", "type": "number"},
    ]


def test_full_shape_keeps_full_input_descriptors(client_and_main):
    client, _, _ = client_and_main
    resp = client.get("/workers?shape=full")
    assert resp.status_code == 200, resp.text

    workers = {worker["id"]: worker for worker in resp.json()}
    inputs = workers["scheduled-no-defaults"]["inputs"]

    assert inputs[0]["name"] == "channel_id"
    assert inputs[0]["type"] == "text"
    assert inputs[0]["label"] == "Channel ID"
    assert inputs[0]["required"] is True


def test_scheduled_worker_with_missing_defaults_is_flagged(client_and_main):
    client, _, _ = client_and_main
    worker = _get_worker(client, "scheduled-no-defaults")
    incomplete = _incomplete_scheduled_inputs(worker)
    assert len(incomplete) == 1
    assert incomplete[0]["name"] == "channel_id"


def test_scheduled_worker_with_all_defaults_is_not_flagged(client_and_main):
    client, _, _ = client_and_main
    worker = _get_worker(client, "scheduled-with-defaults")
    incomplete = _incomplete_scheduled_inputs(worker)
    assert incomplete == [], f"Expected no incomplete inputs, got: {incomplete}"


def test_scheduled_run_creation_applies_worker_yml_defaults(client_and_main):
    """Scheduler-created runs with empty inputs still receive YAML defaults."""
    _, _, _ = client_and_main
    run_service = importlib.import_module("run_service")
    db = importlib.import_module("db")
    repos = db.get_repositories()

    run_id = run_service.create_run(
        "scheduled-with-defaults",
        {},
        trigger_source="schedule",
        user_id="federico",
        repos=repos,
    )

    row = repos.runs.get_any(run_id=run_id)
    assert row is not None
    payload = row["input_json"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    assert payload["channel_id"] == "123456789012345678"


def test_repeated_scheduled_missing_secret_failures_auto_pause_worker(client_and_main, monkeypatch):
    _, _, workers_dir = client_and_main
    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSING_SECRET_PAUSE_AFTER", "3")
    run_service = importlib.import_module("run_service")
    db = importlib.import_module("db")
    repos = db.get_repositories()

    run_ids = []
    for _ in range(3):
        run_id = run_service.create_run(
            "scheduled-missing-secret",
            {},
            trigger_source="schedule",
            user_id="federico",
            repos=repos,
        )
        run_ids.append(run_id)
        run_service.execute_run(
            run_id,
            "scheduled-missing-secret",
            {},
            user_id="federico",
            repos=repos,
        )

    for run_id in run_ids:
        row = repos.runs.get(user_id="federico", run_id=run_id)
        assert row["status"] == "failed"
        assert row["error_code"] == "missing_secret"

    worker = repos.workers.get(user_id="federico", worker_id="scheduled-missing-secret")
    assert worker["enabled"] is False
    assert worker["manifest"]["paused"] is True
    assert "paused: true" in (workers_dir / "scheduled-missing-secret" / "worker.yml").read_text(encoding="utf-8")


def test_manual_worker_with_missing_defaults_is_not_flagged(client_and_main):
    """Manual workers do not need defaults — scheduled runs can't happen."""
    client, _, _ = client_and_main
    worker = _get_worker(client, "manual-no-defaults")
    incomplete = _incomplete_scheduled_inputs(worker)
    assert incomplete == [], f"Manual workers should not be flagged: {incomplete}"


def test_patching_defaults_clears_incomplete_state(client_and_main):
    """After patching worker.yml to add a default, the worker is no longer flagged."""
    client, main, workers_dir = client_and_main

    # Verify it starts as incomplete
    worker = _get_worker(client, "scheduled-no-defaults")
    assert len(_incomplete_scheduled_inputs(worker)) == 1

    # Patch the YAML on disk to add a default for channel_id
    yml_path = workers_dir / "scheduled-no-defaults" / "worker.yml"
    original = yml_path.read_text(encoding="utf-8")
    patched = original.replace(
        '    label: "Channel ID"\n',
        '    label: "Channel ID"\n    default: "987654321098765432"\n',
    )
    yml_path.write_text(patched, encoding="utf-8")

    # Update the worker via the files API
    resp = client.put(
        "/workers/scheduled-no-defaults/files",
        json={"files": [{"path": "worker.yml", "content": patched}]},
    )
    # Accept either 200 or 204
    assert resp.status_code in (200, 204), resp.text

    main.invalidate_worker_cache()
    worker = _get_worker(client, "scheduled-no-defaults")
    assert _incomplete_scheduled_inputs(worker) == [], \
        "After adding default, worker should no longer be flagged"
