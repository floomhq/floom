"""#1068 — input-validation hardening batch:
  1. workers.alerts.create email_to: reject malformed addresses (and restrict to
     workspace members when the membership directory has emails).
  2. secrets.set: reject env-shadowing names (PATH, LD_PRELOAD, ...).
  3. secrets.set empty key -> clean 4xx instead of an unhandled 500.
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH_HEADERS = {"x-floom-secret": "test-secret-1068"}

_WORKER_YML = """id: validation-1068
name: Validation 1068
description: Worker for #1068 validation tests.
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

_RUN_PY = """from typing import Any, Dict


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    return {"status": "success", "outputs": {"result": "ok"}, "artifacts": []}
"""


def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADERS["x-floom-secret"])
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)
    sys.path.insert(0, str(API_DIR))
    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "composio_client", "auth", "contexts",
        ]):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _create_worker(client):
    resp = client.post(
        "/workers", json={"worker_yml": _WORKER_YML, "run_py": _RUN_PY}, headers=AUTH_HEADERS,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


# --- 3 + 2: empty / sensitive secret names (direct handler call; validation
#     happens before auth/repos are touched) ----------------------------------

def test_empty_secret_key_raises_422_not_500():
    import main
    payload = main.SecretUpsertRequest(value="x")
    with pytest.raises(HTTPException) as exc:
        main.upsert_secret("", payload, auth=None, repos=None)
    assert exc.value.status_code == 422


@pytest.mark.parametrize("bad", ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"])
def test_sensitive_secret_names_rejected(bad):
    import main
    payload = main.SecretUpsertRequest(value="x")
    with pytest.raises(HTTPException) as exc:
        main.upsert_secret(bad, payload, auth=None, repos=None)
    assert exc.value.status_code == 422


# --- end-to-end over HTTP -----------------------------------------------------

def test_secret_path_rejected_over_http(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)
    resp = client.post("/secrets/PATH", json={"value": "/usr/bin"}, headers=AUTH_HEADERS)
    assert resp.status_code == 422, resp.text


def test_normal_secret_accepted(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)
    resp = client.post("/secrets/MY_API_KEY", json={"value": "tok"}, headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text


def test_alert_email_malformed_rejected(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)
    worker_id = _create_worker(client)
    resp = client.post(
        f"/workers/{worker_id}/alerts",
        json={"email_to": ["not-an-email"], "on": ["failed"]},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 400, resp.text


def test_alert_email_wellformed_accepted(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)
    worker_id = _create_worker(client)
    resp = client.post(
        f"/workers/{worker_id}/alerts",
        json={"email_to": ["ops@example.com"], "on": ["failed"]},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 201, resp.text
