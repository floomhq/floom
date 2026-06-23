from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


WORKER_YML = """
schema_version: "0.3"
id: "await-ext-worker"
name: "await-ext-worker"
title: "Await External Worker"
description: "await external test"
version: "0.1.0"
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs: []
approvals:
  required: false
trigger:
  type: manual
""".strip()


APPROVAL_WORKER_YML = """
schema_version: "0.3"
id: "approval-worker"
name: "approval-worker"
title: "Approval Worker"
description: "approval regression test"
version: "0.1.0"
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs: []
approvals:
  required: true
trigger:
  type: manual
""".strip()


@pytest.fixture
def api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", "await-external-test")

    for name in list(sys.modules):
        if name in {
            "main",
            "models",
            "worker_registry",
            "run_service",
            "webhook_service",
            "chat_service",
        } or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    main = importlib.import_module("main")
    run_service = importlib.import_module("run_service")
    webhook_service = importlib.import_module("webhook_service")
    client = TestClient(
        main.app,
        headers={"x-floom-secret": "await-external-test"},
        raise_server_exceptions=False,
    )
    resp = client.post(
        "/workers",
        json={"worker_yml": WORKER_YML, "run_py": "print('stub')"},
    )
    assert resp.status_code == 200, resp.text
    return main, run_service, webhook_service, client


class _AwaitExternalDriver:
    def __init__(self):
        self.inputs: list[dict] = []

    def run(self, **kwargs):
        from models import WorkerResult

        inputs = dict(kwargs.get("inputs") or {})
        self.inputs.append(inputs)
        if "external_result" in inputs:
            return WorkerResult(
                status="success",
                outputs={"external_result_seen": inputs["external_result"]},
            )
        return WorkerResult(
            status="success",
            outputs={"submitted": inputs.get("job_key")},
            await_external={
                "key": inputs.get("job_key"),
                "label": "Audit job",
                "timeout_seconds": 60,
            },
        )


class _DecisionRequiredDriver:
    def __init__(self):
        self.inputs: list[dict] = []

    def run(self, **kwargs):
        from models import WorkerResult

        inputs = dict(kwargs.get("inputs") or {})
        self.inputs.append(inputs)
        if inputs.get("decision") == "approved":
            return WorkerResult(
                status="success",
                outputs={"phase": inputs.get("_workeros_approval_phase")},
            )
        return WorkerResult(
            status="success",
            outputs={"proposal": True},
            decision_required={
                "label": "Approve proposal",
                "preview": "proposal",
            },
        )


def _signed_headers(secret_hash: str, body: bytes) -> dict[str, str]:
    digest = hmac.new(secret_hash.encode(), body, hashlib.sha256).hexdigest()
    return {"X-Floom-Signature": f"sha256={digest}"}


def test_await_external_suspends_and_signed_resume_injects_result(api):
    main, run_service, webhook_service, client = api
    worker_id = "await-ext-worker"
    driver = _AwaitExternalDriver()

    run_id = run_service.create_run(worker_id, {"job_key": "audit-123"})
    with patch.object(run_service, "get_sandbox_driver", return_value=driver):
        run_service.execute_run(run_id, worker_id, {"job_key": "audit-123"})

    repos = main.get_repositories()
    parked = repos.runs.get(user_id="local-user", run_id=run_id)
    approval = repos.approvals.get_by_run_id(run_id=run_id)
    assert parked["status"] == "pending_approval"
    assert approval["status"] == "pending"
    decision_input = json.loads(approval["decision_input_json"])
    assert decision_input["kind"] == "await_external"
    assert decision_input["key"] == "audit-123"
    assert client.get("/approvals/count").json() == {"pending": 0}

    webhook_service.generate_webhook_secret(worker_id)
    secret_hash = webhook_service.get_webhook_secret_hash(worker_id)
    body = json.dumps(
        {"key": "audit-123", "result": {"score": 98, "passed": True}},
        separators=(",", ":"),
    ).encode()

    bad = client.post(
        f"/webhooks/{worker_id}/resume",
        content=body,
        headers={"X-Floom-Signature": "sha256=bad"},
    )
    assert bad.status_code == 401

    good = client.post(
        f"/webhooks/{worker_id}/resume",
        content=body,
        headers=_signed_headers(secret_hash, body),
    )
    assert good.status_code == 200, good.text
    assert good.json()["status"] == "resumed"
    follow_up_run_id = good.json()["run_id"]
    assert follow_up_run_id and follow_up_run_id != run_id

    approval = repos.approvals.get_by_run_id(run_id=run_id)
    parked = repos.runs.get(user_id="local-user", run_id=run_id)
    follow_up = repos.runs.get(user_id="local-user", run_id=follow_up_run_id)
    assert approval["status"] == "approved"
    assert approval["follow_up_run_id"] == follow_up_run_id
    assert parked["status"] == "completed"
    assert follow_up["status"] == "queued"
    follow_up_inputs = json.loads(follow_up["input_json"])
    assert follow_up_inputs["external_result"] == {"score": 98, "passed": True}

    with patch.object(run_service, "get_sandbox_driver", return_value=driver):
        run_service.execute_run(follow_up_run_id, worker_id, follow_up_inputs)

    assert driver.inputs[-1]["external_result"] == {"score": 98, "passed": True}
    completed = repos.runs.get(user_id="local-user", run_id=follow_up_run_id)
    assert completed["status"] == "completed"


def test_existing_decision_required_approval_still_resumes(api):
    main, run_service, _webhook_service, client = api
    worker_id = "approval-worker"
    resp = client.post(
        "/workers",
        json={"worker_yml": APPROVAL_WORKER_YML, "run_py": "print('stub')"},
    )
    assert resp.status_code == 200, resp.text

    driver = _DecisionRequiredDriver()
    run_id = run_service.create_run(worker_id, {"task": "deploy"})
    with patch.object(run_service, "get_sandbox_driver", return_value=driver):
        run_service.execute_run(run_id, worker_id, {"task": "deploy"})

    repos = main.get_repositories()
    parked = repos.runs.get(user_id="local-user", run_id=run_id)
    approval = repos.approvals.get_by_run_id(run_id=run_id)
    assert parked["status"] == "pending_approval"
    assert approval["status"] == "pending"
    assert json.loads(approval["decision_input_json"]) == {"task": "deploy"}
    assert client.get("/approvals/count").json() == {"pending": 1}

    approved = client.post(f"/runs/{run_id}/approve", json={})
    assert approved.status_code == 200, approved.text
    follow_up_run_id = approved.json()["run_id"]
    approval = repos.approvals.get_by_run_id(run_id=run_id)
    assert approval["status"] == "approved"
    assert approval["follow_up_run_id"] == follow_up_run_id

    follow_up = repos.runs.get(user_id="local-user", run_id=follow_up_run_id)
    follow_up_inputs = json.loads(follow_up["input_json"])
    with patch.object(run_service, "get_sandbox_driver", return_value=driver):
        run_service.execute_run(follow_up_run_id, worker_id, follow_up_inputs)

    assert driver.inputs[-1]["decision"] == "approved"
    assert driver.inputs[-1]["_workeros_approval_phase"] == "execute"
    completed = repos.runs.get(user_id="local-user", run_id=follow_up_run_id)
    assert completed["status"] == "completed"
