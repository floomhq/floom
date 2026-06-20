"""#797 — workspace model defaults, run limits, and monthly spend cap are
ENFORCED (not just stored in the KV table).

- default_model: agent worker with no model resolves to the workspace default.
- default_timeout_seconds: workspace timeout is a ceiling (tightest wins).
- monthly_spend_cap_usd (workspace): create_run refuses once workspace-wide
  month-to-date cost reaches the cap.
- GET /workspace/settings surfaces current_month_spend_usd.

Run: cd apps/api && python -m pytest tests/test_797_workspace_defaults_enforcement.py -q
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

SECRET = "test-secret-797"


def _yml(worker_id: str) -> str:
    return textwrap.dedent(
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


@pytest.fixture
def client_main(monkeypatch, tmp_path):
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts", "runner_sandbox")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    main.start_run = lambda *a, **k: None
    import run_service
    run_service.start_run = main.start_run
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    return client, main


def _set(client, key, value):
    assert client.put(f"/workspace/settings/{key}", json={"value": value}).status_code in (200, 204)


def _seed_cost(worker_id, cost, created_at):
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at, total_cost_usd) "
            "VALUES (?, ?, 'completed', 'manual', 'e2b', ?, ?)",
            (f"r_{worker_id}_{int(cost*100)}", worker_id, created_at, cost),
        )


class TestDefaultModel:
    def test_default_model_resolves_when_worker_has_none(self):
        # unit: the agent driver helper falls back to the workspace default
        import runner_sandbox.agent_driver as ad

        ad._ws_setting = lambda key: "claude-opus-4-8" if key == "default_model" else None
        assert ad._ws_default_model() == "claude-opus-4-8"

    def test_resolution_precedence_in_source(self):
        import inspect
        import runner_sandbox.agent_driver as ad

        src = inspect.getsource(ad)
        # Precedence: explicit per-run model → workspace default → global default.
        # The global default is resolved lazily (default_worker_agent_model()) so
        # cloud dotenv config that arrives after import is honored (Bedrock, not
        # the frozen OpenAI fallback).
        assert "or _ws_default_model()" in src
        assert "or _ws_fallback_model()" in src
        assert "or default_worker_agent_model()" in src

    def test_fallback_model_resolves_after_workspace_default(self):
        import runner_sandbox.agent_driver as ad

        ad._ws_setting = lambda key: "gpt-5.1-mini" if key == "fallback_model" else None
        assert ad._ws_default_model() is None
        assert ad._ws_fallback_model() == "gpt-5.1-mini"

    def test_workspace_max_output_tokens_used_when_worker_default(self):
        import runner_sandbox.agent_driver as ad
        import types

        ad._ws_setting = lambda key: "8192" if key == "max_output_tokens" else None
        assert ad._resolve_max_output_tokens(types.SimpleNamespace(max_output_tokens=1_000_000)) == 8192
        assert ad._resolve_max_output_tokens(types.SimpleNamespace(max_output_tokens=4096)) == 4096


class TestTimeoutCeiling:
    def test_resolve_timeout_seconds_uses_workspace_when_set(self):
        """#1127/#1314: workspace default_timeout_seconds overrides per-worker limit upward."""
        import runner_sandbox.agent_driver as ad
        import types

        # Simulate limits with per-worker default of 300 s
        limits = types.SimpleNamespace(timeout_seconds=300)

        # Workspace sets 3600 s → _resolve_timeout_seconds should return 3600
        ad._ws_setting = lambda key: "3600" if key == "default_timeout_seconds" else None
        assert ad._resolve_timeout_seconds(300, limits) == 3600

    def test_resolve_timeout_seconds_uses_per_worker_when_ws_unset(self):
        """#1127/#1314: without a workspace setting, per-worker limit applies."""
        import runner_sandbox.agent_driver as ad
        import types

        limits = types.SimpleNamespace(timeout_seconds=300)
        ad._ws_setting = lambda key: None
        assert ad._resolve_timeout_seconds(300, limits) == 300

    def test_resolve_timeout_seconds_never_exceeds_3600(self):
        """#1127/#1314: absolute ceiling is MAX_RUN_TIMEOUT_SECONDS (3600)."""
        import runner_sandbox.agent_driver as ad
        import types

        limits = types.SimpleNamespace(timeout_seconds=300)
        # Even if somehow a larger value slipped in, cap at 3600
        ad._ws_setting = lambda key: "9999" if key == "default_timeout_seconds" else None
        assert ad._resolve_timeout_seconds(300, limits) == 3600

    def test_workspace_setting_rejects_3601(self):
        """#1127/#1314: validate_default_timeout_seconds rejects values > 3600."""
        import pytest
        from runtime_limits import validate_default_timeout_seconds

        with pytest.raises(ValueError, match="3600"):
            validate_default_timeout_seconds(3601)

    def test_workspace_setting_accepts_3600(self):
        """#1127/#1314: validate_default_timeout_seconds accepts 3600 exactly."""
        from runtime_limits import validate_default_timeout_seconds

        assert validate_default_timeout_seconds(3600) == 3600

    def test_workspace_setting_rejects_zero(self):
        """#1127/#1314: validate_default_timeout_seconds rejects non-positive values."""
        import pytest
        from runtime_limits import validate_default_timeout_seconds

        with pytest.raises(ValueError, match="positive"):
            validate_default_timeout_seconds(0)

    def test_workspace_timeout_in_source(self):
        """Verify _resolve_timeout_seconds function and ws lookup are in source."""
        import inspect
        import runner_sandbox.agent_driver as ad

        src = inspect.getsource(ad)
        assert '_ws_default_int("default_timeout_seconds")' in src
        assert "_resolve_timeout_seconds" in src


class TestWorkspaceSpendCap:
    def test_run_refused_at_workspace_cap(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("capworkeralpha"), "run_py": "print(1)"}).status_code == 200
        _set(client, "monthly_spend_cap_usd", "5.0")
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
        # two different workers' spend aggregates to the workspace total
        assert client.post("/workers", json={"worker_yml": _yml("capworkerbeta"), "run_py": "print(1)"}).status_code == 200
        _seed_cost("capworkeralpha", 3.0, this_month)
        _seed_cost("capworkerbeta", 2.5, this_month)  # 5.5 total > 5.0 cap
        resp = client.post("/workers/capworkeralpha/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 402, resp.text
        body = resp.json()["detail"]
        assert body["error_code"] == "spend_cap_exceeded"
        assert "workspace" in body["message"].lower()

    def test_run_allowed_under_workspace_cap(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("capworkergamma"), "run_py": "print(1)"}).status_code == 200
        _set(client, "monthly_spend_cap_usd", "100.0")
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
        _seed_cost("capworkergamma", 10.0, this_month)
        resp = client.post("/workers/capworkergamma/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 200, resp.text


class TestCurrentSpendSurfaced:
    def test_settings_returns_current_month_spend(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("capworkerdelta"), "run_py": "print(1)"}).status_code == 200
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
        _seed_cost("capworkerdelta", 4.25, this_month)
        settings = client.get("/workspace/settings").json()
        assert "current_month_spend_usd" in settings
        assert float(settings["current_month_spend_usd"]) >= 4.25
