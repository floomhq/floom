"""#978 — webhook URL (a token-bearing run capability) must not be returned
to view-only callers.

POST /webhooks/{id}?token=... triggers a run with no session auth, so the
URL is a durable execution capability. A specific-people grant adds VIEW
only; the worker-detail projection used to return webhook_url to anyone who
could fetch detail. It must now be gated on can_run.

This drives the real app over HTTP (a genuine webhook worker), then flips
only the permission decision under test, so it cannot pass with the gate
removed.

Run: cd apps/api && python -m pytest tests/test_978_webhook_url_run_gated.py -q
"""
from __future__ import annotations

import importlib
import sys
import textwrap
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

WEBHOOK_YML = textwrap.dedent(
    """
    schema_version: "0.3"
    id: "wh-worker"
    name: "wh-worker"
    title: "Webhook worker"
    description: "d"
    version: "0.1.0"
    exec:
      entry: "run.py"
      runtime: "python311"
      runner: "e2b"
      command: "python run.py"
      inputs: []
      outputs: []
    trigger:
      type: webhook
      webhook:
        secret: true
    connections: []
    """
).strip() + "\n"


@pytest.fixture
def client_main(monkeypatch, tmp_path):
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
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "webhook_service", "chat_service") or name.startswith(("db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None
    )
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": "dev"}, raise_server_exceptions=False)
    resp = client.post(
        "/workers", json={"worker_yml": WEBHOOK_YML, "run_py": "print(1)"}
    )
    assert resp.status_code == 200, resp.text
    return client, main


def test_owner_runner_gets_webhook_url(client_main):
    client, _ = client_main
    detail = client.get("/workers/wh-worker").json()
    assert detail.get("webhook_url"), "owner (can_run) must receive the webhook URL"
    assert "token=" in detail["webhook_url"]


def test_view_only_caller_gets_no_webhook_url(client_main, monkeypatch):
    client, main = client_main
    from models import AssetPermissions

    # flip ONLY the permission decision: a view-only grantee (can_run False).
    view_only = AssetPermissions(
        is_owner=False, can_view=True, can_edit=False,
        can_run=False, can_delete=False, can_share=False,
    )
    monkeypatch.setattr(main, "_worker_permissions", lambda *a, **k: view_only)
    detail = client.get("/workers/wh-worker").json()
    assert detail.get("webhook_url") is None, (
        "view-only caller must not receive the token-bearing webhook URL (#978)"
    )
