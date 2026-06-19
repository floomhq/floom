"""#794 — workspace behaviour toggles are ENFORCED (not just stored).

- approval_default="always" → a new worker with no explicit approvals block
  is created with approvals.required=true; an explicit block still wins.
- failure_email_enabled → a failed run emails the workspace recipient
  (best-effort; verified via the dispatch wiring + recipient resolver).
- auto_pause_enabled already enforced (PR #886).

Run: cd apps/api && python -m pytest tests/test_794_behaviour_enforcement.py -q
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

SECRET = "test-secret-794"


def _yml(worker_id: str, *, with_approvals: bool = False) -> str:
    base = textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: t
        description: d
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        """
    ).strip() + "\n"
    if with_approvals:
        base += "approvals:\n  required: false\n"
    return base


@pytest.fixture
def client_main(monkeypatch, tmp_path):
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    return client, main


def _set_setting(client, key, value):
    assert client.put(f"/workspace/settings/{key}", json={"value": value}).status_code in (200, 204)


def _approvals_required(detail: dict) -> bool:
    return bool(((detail.get("config") or {}).get("approvals") or {}).get("required"))


class TestApprovalDefault:
    def test_default_always_applies_to_worker_without_approvals(self, client_main):
        client, _ = client_main
        _set_setting(client, "approval_default", "always")
        assert client.post("/workers", json={"worker_yml": _yml("autoappr"), "run_py": "print(1)"}).status_code == 200
        detail = client.get("/workers/autoappr").json()
        assert _approvals_required(detail) is True

    def test_explicit_approvals_block_wins(self, client_main):
        client, _ = client_main
        _set_setting(client, "approval_default", "always")
        assert client.post("/workers", json={"worker_yml": _yml("optout", with_approvals=True), "run_py": "print(1)"}).status_code == 200
        detail = client.get("/workers/optout").json()
        assert _approvals_required(detail) is False  # explicit required:false respected

    def test_no_default_means_no_approval(self, client_main):
        client, _ = client_main
        # approval_default unset
        assert client.post("/workers", json={"worker_yml": _yml("plain"), "run_py": "print(1)"}).status_code == 200
        detail = client.get("/workers/plain").json()
        assert _approvals_required(detail) is False


class TestFailureEmail:
    def test_recipient_resolver_reads_setting_then_env(self, client_main, monkeypatch):
        import run_service

        # workspace setting wins
        from db import get_db
        with get_db() as conn:
            conn.execute(
                "INSERT INTO workspace_settings (workspace_id, key, value, updated_at) "
                "VALUES ('local-default', 'failure_email_to', 'ops@example.com', '2026-01-01')"
            )
        assert run_service._workspace_failure_email_recipients() == ["ops@example.com"]

    def test_env_fallback_when_setting_absent(self, client_main, monkeypatch):
        import run_service

        monkeypatch.setenv("NOTIFY_EMAIL", "fallback@example.com")
        assert run_service._workspace_failure_email_recipients() == ["fallback@example.com"]

    def test_failure_email_wired_into_terminal_dispatch(self, client_main):
        import inspect
        import run_service

        src = inspect.getsource(run_service._dispatch_terminal_run_alerts)
        assert 'failure_email_enabled' in src
        assert '_workspace_failure_email_recipients()' in src
        assert '_send_email_notification(' in src
