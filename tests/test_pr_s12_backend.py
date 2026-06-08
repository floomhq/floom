import importlib
import json
import sys
import types
import uuid
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
sys.path.insert(0, str(API_DIR))


def _worker_yml(worker_name: str) -> str:
    return f"""schema_version: "0.3"
name: {worker_name}
title: {worker_name}
description: Test worker for PR S12 backend.
version: 0.1.0
exec:
  entry: run.py
  runtime: python311
  command: python run.py
  runner: e2b
  inputs:
    - name: text
      kind: scalar
      type: string
      required: false
  outputs:
    - name: summary
      kind: scalar
      type: string
trigger:
  type: manual
"""


@pytest.fixture()
def api_ctx(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_SECRET", "s12-secret")

    for name in list(sys.modules):
        if name in {"main", "models", "run_service", "worker_registry", "runner_utils", "scheduler"} or name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    main = importlib.import_module("main")
    main.get_auth_provider.cache_clear()
    run_service = importlib.import_module("run_service")
    models = importlib.import_module("models")

    class _FakeDriver:
        def run(self, **_kwargs):
            return models.WorkerResult(
                status="success",
                outputs={"summary": "ok"},
                artifacts=[],
            )

    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *_a, **_k: _FakeDriver())

    def _start_run_sync(run_id: str, worker_id: str, inputs: dict, **kwargs):
        run_service.execute_run(run_id, worker_id, inputs, **kwargs)

    monkeypatch.setattr(main, "start_run", _start_run_sync)

    client = TestClient(main.app)
    headers = {"x-floom-secret": "s12-secret"}
    return {
        "main": main,
        "client": client,
        "headers": headers,
        "tmp_path": tmp_path,
    }


def _create_worker(client: TestClient, headers: dict, worker_name: str | None = None) -> str:
    worker_name = worker_name or f"s12-worker-{uuid.uuid4().hex[:8]}"
    response = client.post(
        "/workers",
        headers=headers,
        json={
            "worker_yml": _worker_yml(worker_name),
            "run_py": "def run(context):\n    return {'status': 'success', 'outputs': {'summary': 'ok'}, 'artifacts': []}\n",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _start_run(client: TestClient, headers: dict, worker_id: str, inputs: dict) -> str:
    response = client.post(
        f"/workers/{worker_id}/runs",
        headers=headers,
        json={"inputs": inputs, "trigger_source": "manual"},
    )
    assert response.status_code == 200, response.text
    return response.json()["run_id"]


def test_overview_shape_and_auth_gate(api_ctx):
    client = api_ctx["client"]
    headers = api_ctx["headers"]

    denied = client.get("/system/overview")
    assert denied.status_code in {401, 403}

    ok = client.get("/system/overview", headers=headers)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert set(body.keys()) == {"stats", "outcomes", "recent_runs", "scheduled_today", "needs_attention"}
    stats = body["stats"]
    assert "runs_24h" in stats
    assert stats["success_rate_7d"] is None
    assert isinstance(stats["runs_24h_sparkline"], list)
    assert len(stats["runs_24h_sparkline"]) == 24

    worker_id = _create_worker(client, headers, "lead-research-bot")
    _start_run(client, headers, worker_id, {"text": "hello"})
    refreshed = client.get("/system/overview", headers=headers)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["outcomes"][0] == {
        "worker_id": worker_id,
        "worker_name": "lead-research-bot",
        "label": "Work shipped",
        "count": 1,
    }


def test_runtime_snapshot_created_and_persisted(api_ctx):
    client = api_ctx["client"]
    headers = api_ctx["headers"]
    main = api_ctx["main"]

    worker_id = _create_worker(client, headers)
    run_id = _start_run(client, headers, worker_id, {"text": "hello"})

    with main.get_db() as conn:
        row = conn.execute(
            "SELECT bundle_snapshot_path FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()
    assert row is not None
    assert row["bundle_snapshot_path"] == f"run-bundles/{run_id}"

    snapshot_worker_yml = Path(main.DB_PATH).resolve().parent / "run-bundles" / run_id / "worker.yml"
    assert snapshot_worker_yml.is_file()


def test_execute_run_fetches_secrets_once_for_log_scrubbing(api_ctx, monkeypatch):
    client = api_ctx["client"]
    headers = api_ctx["headers"]
    main = api_ctx["main"]
    run_service = importlib.import_module("run_service")

    calls: list[tuple[str, str | None]] = []

    def _fake_get_secrets(worker_id: str, *, user_id: str | None = None, repos=None):
        calls.append((worker_id, user_id))
        return {"TOKEN": "secret-value"}

    monkeypatch.setattr(run_service, "get_secrets_for_worker", _fake_get_secrets)

    worker_id = _create_worker(client, headers)
    _start_run(client, headers, worker_id, {"text": "hello"})

    with main.get_db() as conn:
        log_count = conn.execute(
            """
            SELECT COUNT(*) FROM logs l
            JOIN runs r ON r.id = l.run_id
            WHERE r.worker_id = ?
            """,
            (worker_id,),
        ).fetchone()[0]

    assert log_count > 1
    assert calls == [(worker_id, "federico")]


def test_runs_filter_and_total_count_header(api_ctx):
    client = api_ctx["client"]
    headers = api_ctx["headers"]

    worker_a = _create_worker(client, headers)
    worker_b = _create_worker(client, headers)
    _start_run(client, headers, worker_a, {"text": "A"})
    _start_run(client, headers, worker_b, {"text": "B"})

    response = client.get(
        f"/runs?worker_id={worker_a}&status=success&limit=10&offset=0",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert "X-Total-Count" in response.headers
    payload = response.json()
    assert all(item["worker_id"] == worker_a for item in payload)
    assert all(item["status"] == "completed" for item in payload)


def test_run_download_zip_contains_safe_export_files(api_ctx):
    client = api_ctx["client"]
    headers = api_ctx["headers"]

    worker_id = _create_worker(client, headers)
    run_id = _start_run(client, headers, worker_id, {"text": "zip-check"})

    response = client.get(f"/runs/{run_id}/download", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers.get("content-type", "").startswith("application/zip")

    archive = zipfile.ZipFile(Path(api_ctx["tmp_path"]) / "tmp.zip", mode="w")
    archive.close()
    zip_path = Path(api_ctx["tmp_path"]) / "run-download.zip"
    zip_path.write_bytes(response.content)
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())
    assert "metadata.json" in names
    assert "outputs.json" in names
    assert "README.txt" in names
    assert "inputs.json" not in names
    assert "logs.txt" not in names


def test_replay_creates_new_run_with_copied_inputs(api_ctx):
    client = api_ctx["client"]
    headers = api_ctx["headers"]
    main = api_ctx["main"]

    worker_id = _create_worker(client, headers)
    source_run_id = _start_run(client, headers, worker_id, {"text": "replay-me"})

    replay_response = client.post(
        f"/workers/{worker_id}/runs/{source_run_id}/replay",
        headers=headers,
    )
    assert replay_response.status_code == 200, replay_response.text
    replay_run_id = replay_response.json()["run_id"]
    assert replay_run_id != source_run_id

    with main.get_db() as conn:
        source_row = conn.execute("SELECT input_json FROM runs WHERE id = ?", (source_run_id,)).fetchone()
        replay_row = conn.execute("SELECT input_json FROM runs WHERE id = ?", (replay_run_id,)).fetchone()
    assert source_row is not None and replay_row is not None
    assert json.loads(replay_row["input_json"] or "{}") == json.loads(source_row["input_json"] or "{}")


def test_bundle_file_serving_and_path_traversal_block(api_ctx):
    client = api_ctx["client"]
    headers = api_ctx["headers"]

    worker_id = _create_worker(client, headers)
    run_id = _start_run(client, headers, worker_id, {"text": "bundle"})

    file_response = client.get(f"/runs/{run_id}/bundle/worker.yml", headers=headers)
    assert file_response.status_code == 200, file_response.text
    assert "schema_version" in file_response.text

    blocked = client.get(f"/runs/{run_id}/bundle/..%2Fetc%2Fpasswd", headers=headers)
    assert blocked.status_code in {400, 404}
    assert blocked.status_code != 200
