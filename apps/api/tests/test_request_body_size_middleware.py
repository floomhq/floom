from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    env_file = tmp_path / "api.env"
    env_file.write_text("")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(env_file))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))

    for name in [
        "main",
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "files",
        "worker_registry",
        "run_service",
        "webhook_service",
        "composio_client",
        "scheduler",
        "auth",
        "auth.context",
        "auth.dependency",
        "auth.factory",
        "auth.interface",
        "auth.local",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_post_workers_replays_buffered_body_once(monkeypatch, tmp_path):
    main = load_main(monkeypatch, tmp_path)
    payload = {
        "worker_yml": """id: phase2-smoke
name: Phase 2 Smoke
description: Echo smoke worker.
trigger:
  type: manual
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
inputs: []
outputs:
  - name: result
    type: string
    label: Result
secrets: []
connections: []
""",
        "run_py": """from typing import Any, Dict


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    context["log"]("phase2 smoke run")
    return {"status": "success", "outputs": {"result": "ok"}, "artifacts": []}
""",
    }

    with TestClient(main.app) as client:
        response = client.post(
            "/workers",
            headers={"x-floom-secret": "test-secret"},
            json=payload,
        )

        assert response.status_code == 200, response.text
        assert response.json()["id"] == "phase2-smoke"

        list_response = client.get(
            "/workers",
            headers={"x-floom-secret": "test-secret"},
        )
        assert list_response.status_code == 200, list_response.text
        assert any(item["id"] == "phase2-smoke" for item in list_response.json())


def test_default_json_oversize_returns_friendly_message(monkeypatch, tmp_path):
    main = load_main(monkeypatch, tmp_path)
    payload = {"prompt": "x" * (main.DEFAULT_JSON_BODY_LIMIT_BYTES + 1)}

    with TestClient(main.app) as client:
        response = client.post(
            "/workers/draft-from-prompt",
            headers={"x-floom-secret": "test-secret"},
            json=payload,
        )

    assert response.status_code == 413
    detail = response.json()["detail"]
    assert "Request body is too large" in detail
    assert detail != "Request body too large"


def test_worker_files_put_accepts_four_mb_payload(monkeypatch, tmp_path):
    main = load_main(monkeypatch, tmp_path)
    worker_yml = """id: large-files
name: Large Files
description: Worker with bundled data.
trigger:
  type: manual
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
inputs: []
outputs:
  - name: result
    type: string
    label: Result
secrets: []
connections: []
"""
    run_py = """import json

with open("result.json", "w", encoding="utf-8") as handle:
    json.dump({"status": "success", "outputs": {"result": "ok"}, "artifacts": []}, handle)
"""

    with TestClient(main.app) as client:
        created = client.post(
            "/workers",
            headers={"x-floom-secret": "test-secret"},
            json={"worker_yml": worker_yml, "run_py": run_py},
        )
        assert created.status_code == 200, created.text

        large_payload = "x" * (4 * 1024 * 1024)
        updated = client.put(
            "/workers/large-files/files",
            headers={"x-floom-secret": "test-secret"},
            json={
                "files": [
                    {"path": "worker.yml", "content": worker_yml},
                    {"path": "run.py", "content": run_py},
                    {"path": "candidates.json", "content": large_payload},
                ]
            },
        )

    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["id"] == "large-files"
    assert any(item["path"] == "candidates.json" for item in body["files"])
