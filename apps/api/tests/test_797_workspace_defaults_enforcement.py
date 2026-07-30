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


def _seed_cost(worker_id, cost, created_at, *, actor_user_id=None):
    from db import get_db

    columns = ["id", "worker_id", "status", "trigger_source", "runner", "created_at", "total_cost_usd"]
    values = [f"r_{worker_id}_{int(cost*100)}", worker_id, "completed", "manual", "e2b", created_at, cost]
    if actor_user_id is not None:
        columns.insert(2, "actor_user_id")
        values.insert(2, actor_user_id)
    placeholders = ", ".join("?" for _ in columns)
    with get_db() as conn:
        conn.execute(f"INSERT INTO runs ({', '.join(columns)}) VALUES ({placeholders})", tuple(values))


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
    def test_worker_limits_default_timeout_is_900(self):
        """#928: default run timeout is 900 s while the max remains 3600."""
        from models import WorkerLimits
        from runtime_limits import DEFAULT_RUN_TIMEOUT_SECONDS, MAX_RUN_TIMEOUT_SECONDS

        assert DEFAULT_RUN_TIMEOUT_SECONDS == 900
        assert MAX_RUN_TIMEOUT_SECONDS == 3600
        assert WorkerLimits().timeout_seconds == 900

    def test_resolve_timeout_seconds_uses_workspace_when_set(self):
        """#1127/#1314: workspace default_timeout_seconds overrides per-worker limit upward."""
        import runner_sandbox.agent_driver as ad
        import types

        # Simulate limits with the current per-worker default.
        limits = types.SimpleNamespace(timeout_seconds=900)

        # Workspace sets 3600 s, so _resolve_timeout_seconds returns 3600.
        ad._ws_setting = lambda key: "3600" if key == "default_timeout_seconds" else None
        assert ad._resolve_timeout_seconds(900, limits) == 3600

    def test_resolve_timeout_seconds_uses_per_worker_when_ws_unset(self):
        """#1127/#1314: without a workspace setting, per-worker limit applies."""
        import runner_sandbox.agent_driver as ad
        import types

        limits = types.SimpleNamespace(timeout_seconds=900)
        ad._ws_setting = lambda key: None
        assert ad._resolve_timeout_seconds(900, limits) == 900

    def test_resolve_timeout_seconds_never_exceeds_3600(self):
        """#1127/#1314: absolute ceiling is MAX_RUN_TIMEOUT_SECONDS (3600)."""
        import runner_sandbox.agent_driver as ad
        import types

        limits = types.SimpleNamespace(timeout_seconds=900)
        # Even if somehow a larger value slipped in, cap at 3600
        ad._ws_setting = lambda key: "9999" if key == "default_timeout_seconds" else None
        assert ad._resolve_timeout_seconds(900, limits) == 3600

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
    def test_create_run_spend_cap_uses_repo_backend(self, client_main, monkeypatch):
        import run_service

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("repocapalpha"), "run_py": "print(1)"}).status_code == 200
        monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "100")
        monkeypatch.setenv("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "100")
        _set(client, "daily_spend_cap_usd", "5.0")
        _set(client, "monthly_spend_cap_usd", "100.0")

        calls = []

        class _Runs:
            def cost_total_usd(self, **kwargs):
                calls.append(kwargs)
                if kwargs.get("workspace_scoped") and kwargs.get("since", "")[:10]:
                    return 5.0
                return 0.0

            def create(self, **_kwargs):
                raise AssertionError("run should be refused before insert")

        class _Workers:
            def get_recipe(self, *, worker_id, **_kwargs):
                return {
                    "owner_id": "local-user",
                    "config": run_service.get_worker_config(worker_id),
                    "enabled": True,
                }

            def get_owner(self, *, worker_id):
                return "local-user"

        repos = types.SimpleNamespace(workers=_Workers(), runs=_Runs())

        with pytest.raises(run_service.SpendCapExceeded):
            run_service.create_run("repocapalpha", {}, user_id="local-user", repos=repos)

        assert any(call.get("workspace_scoped") is True for call in calls)

    def test_run_refused_at_default_user_daily_cap_across_workspaces(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("userdailyalpha"), "run_py": "print(1)"}).status_code == 200
        assert client.post("/workers", json={"worker_yml": _yml("userdailybeta"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "100.0")
        _set(client, "monthly_spend_cap_usd", "100.0")
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT01:00:00+00:00")
        _seed_cost("userdailyalpha", 2.0, today, actor_user_id="local-user")
        _seed_cost("userdailybeta", 3.0, today, actor_user_id="local-user")
        resp = client.post("/workers/userdailyalpha/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 402, resp.text
        body = resp.json()["detail"]
        assert body["error_code"] == "spend_cap_exceeded"
        assert "user" in body["message"].lower()
        assert "daily spend cap" in body["message"].lower()

    def test_user_daily_cap_is_scoped_to_actor(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("userdailygamma"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "100.0")
        _set(client, "monthly_spend_cap_usd", "100.0")
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT01:00:00+00:00")
        _seed_cost("userdailygamma", 5.0, today, actor_user_id="other-user")
        resp = client.post("/workers/userdailygamma/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 200, resp.text

    def test_run_refused_at_default_user_monthly_cap(self, client_main, monkeypatch):
        from datetime import datetime, timezone

        monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "100")
        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("usermonthlyalpha"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "100.0")
        _set(client, "monthly_spend_cap_usd", "100.0")
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
        _seed_cost("usermonthlyalpha", 25.0, this_month, actor_user_id="local-user")
        resp = client.post("/workers/usermonthlyalpha/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 402, resp.text
        body = resp.json()["detail"]
        assert body["error_code"] == "spend_cap_exceeded"
        assert "user" in body["message"].lower()
        assert "monthly spend cap" in body["message"].lower()

    def test_run_refused_at_default_daily_workspace_cap(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("dailydefaultalpha"), "run_py": "print(1)"}).status_code == 200
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT01:00:00+00:00")
        _seed_cost("dailydefaultalpha", 5.0, today)
        resp = client.post("/workers/dailydefaultalpha/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 402, resp.text
        body = resp.json()["detail"]
        assert body["error_code"] == "spend_cap_exceeded"
        assert "daily spend cap" in body["message"].lower()

    def test_run_allowed_when_daily_cap_overridden_above_default(self, client_main, monkeypatch):
        from datetime import datetime, timezone

        monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "100")
        monkeypatch.setenv("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "100")
        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("dailyoverridealpha"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "10.0")
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT01:00:00+00:00")
        _seed_cost("dailyoverridealpha", 5.5, today)
        resp = client.post("/workers/dailyoverridealpha/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 200, resp.text

    def test_run_refused_at_default_monthly_workspace_cap(self, client_main, monkeypatch):
        from datetime import datetime, timezone

        monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "100")
        monkeypatch.setenv("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "100")
        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("monthlydefaultalpha"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "100.0")
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
        _seed_cost("monthlydefaultalpha", 25.0, this_month)
        resp = client.post("/workers/monthlydefaultalpha/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 402, resp.text
        body = resp.json()["detail"]
        assert body["error_code"] == "spend_cap_exceeded"
        assert "monthly spend cap" in body["message"].lower()

    def test_run_refused_at_workspace_cap(self, client_main, monkeypatch):
        from datetime import datetime, timezone

        monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "100")
        monkeypatch.setenv("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "100")
        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("capworkeralpha"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "100.0")
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

    def test_run_allowed_under_workspace_cap(self, client_main, monkeypatch):
        from datetime import datetime, timezone

        monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "100")
        monkeypatch.setenv("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "100")
        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("capworkergamma"), "run_py": "print(1)"}).status_code == 200
        _set(client, "daily_spend_cap_usd", "100.0")
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
        # #1201: seed a run for "today" (not a hardcoded day-05), so the
        # day-spend assertion below isn't date-dependent flaky past the 5th
        # of any given month.
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT01:00:00+00:00")
        _seed_cost("capworkerdelta", 4.25, today)
        settings = client.get("/workspace/settings").json()
        assert "current_day_spend_usd" in settings
        assert "current_month_spend_usd" in settings
        assert float(settings["current_day_spend_usd"]) >= 4.25
        assert float(settings["current_month_spend_usd"]) >= 4.25

    def test_workspace_spend_endpoint_returns_current_spend_and_caps(self, client_main):
        """#1201: GET /workspace/spend is the purpose-built readout next to
        the spend-cap setting (settings-page stat + any other consumer)."""
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post("/workers", json={"worker_yml": _yml("spendendpointalpha"), "run_py": "print(1)"}).status_code == 200
        _set(client, "monthly_spend_cap_usd", "50.0")
        _set(client, "daily_spend_cap_usd", "10.0")
        today = datetime.now(timezone.utc).strftime("%Y-%m-%dT01:00:00+00:00")
        _seed_cost("spendendpointalpha", 6.5, today)

        resp = client.get("/workspace/spend")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["day_spend_usd"] >= 6.5
        assert body["month_spend_usd"] >= 6.5
        assert body["daily_cap_usd"] == 10.0
        assert body["monthly_cap_usd"] == 50.0

    def test_workspace_spend_endpoint_returns_active_workspace_caps(self, client_main):
        """The cap read uses the request's active workspace, not local-default."""
        client, _ = client_main
        _set(client, "daily_spend_cap_usd", "10.0")
        _set(client, "monthly_spend_cap_usd", "50.0")

        created = client.post("/workspaces", json={"name": "Spend visibility"})
        assert created.status_code == 200, created.text
        workspace_id = created.json()["id"]
        headers = {"x-floom-workspace": workspace_id}
        assert client.put(
            "/workspace/settings/daily_spend_cap_usd",
            json={"value": "21.0"},
            headers=headers,
        ).status_code in (200, 204)
        assert client.put(
            "/workspace/settings/monthly_spend_cap_usd",
            json={"value": "84.0"},
            headers=headers,
        ).status_code in (200, 204)

        resp = client.get("/workspace/spend", headers=headers)

        assert resp.status_code == 200, resp.text
        assert resp.json()["daily_cap_usd"] == 21.0
        assert resp.json()["monthly_cap_usd"] == 84.0

    def test_workspace_spend_endpoint_uses_repo_backend_when_available(self, client_main):
        """#1201: regression guard for the exact bug this PR fixes: the
        workspace spend read must go through Repositories.runs.cost_total_usd
        (workspace_scoped=True) when the deploy provides one, not silently
        fall back to the engine's local sqlite (empty on a hosted deploy)."""
        import run_service

        client, main = client_main
        calls = []

        class _Runs:
            def cost_total_usd(self, **kwargs):
                calls.append(kwargs)
                return 3.25

        class _FakeRepos:
            runs = _Runs()

        main.app.dependency_overrides[main.get_repos] = lambda: _FakeRepos()
        try:
            resp = client.get("/workspace/spend")
        finally:
            main.app.dependency_overrides.pop(main.get_repos, None)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["day_spend_usd"] == 3.25
        assert body["month_spend_usd"] == 3.25
        assert any(call.get("workspace_scoped") is True for call in calls)
