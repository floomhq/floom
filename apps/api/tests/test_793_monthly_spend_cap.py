"""#793 — per-worker monthly spend cap.

WorkerLimits gains `max_monthly_cost_usd` (None = unlimited), surfaced in
WorkerDetail.config and enforced at dispatch: a run is refused (402,
error_code=spend_cap_exceeded) once the worker's month-to-date cost has
reached the cap.

Run: cd apps/api && python -m pytest tests/test_793_monthly_spend_cap.py -q
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

SECRET = "test-secret-793"


def _worker_yml(worker_id: str, cap: float | None) -> str:
    cap_line = f"  max_monthly_cost_usd: {cap}\n" if cap is not None else ""
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: "Spend cap worker"
        description: d
        version: "0.1.0"
        limits:
          max_tool_iterations: 12
          max_output_tokens: 12000
          max_total_tokens: 50000
          timeout_seconds: 300
        {cap_line.rstrip()}
        exec:
          entry: "run.py"
          runtime: "python311"
          runner: "e2b"
          command: "python run.py"
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        """
    ).strip() + "\n"


@pytest.fixture
def client_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    # don't actually dispatch a sandbox
    main.start_run = lambda *a, **k: None
    import run_service
    run_service.start_run = main.start_run
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    return client, main


def _create(client, worker_id, cap):
    return client.post("/workers", json={"worker_yml": _worker_yml(worker_id, cap), "run_py": "print(1)"})


def _seed_run_cost(worker_id: str, cost_usd: float, *, created_at: str) -> None:
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at, total_cost_usd) "
            "VALUES (?, ?, 'completed', 'manual', 'e2b', ?, ?)",
            (f"run_{worker_id}_{int(cost_usd * 100)}_{created_at[:7]}", worker_id, created_at, cost_usd),
        )


def test_field_surfaces_in_worker_detail(client_main):
    client, _ = client_main
    assert _create(client, "capworker", 5.0).status_code == 200
    detail = client.get("/workers/capworker").json()
    limits = detail["config"]["runtime"]["limits"]
    assert limits["max_monthly_cost_usd"] == 5.0


def test_unlimited_when_field_absent(client_main):
    client, _ = client_main
    assert _create(client, "nocap", None).status_code == 200
    detail = client.get("/workers/nocap").json()
    assert detail["config"]["runtime"]["limits"]["max_monthly_cost_usd"] is None


def test_run_refused_when_month_to_date_cost_at_cap(client_main):
    client, _ = client_main
    assert _create(client, "spender", 1.00).status_code == 200
    # this month's spend already at the cap
    _seed_run_cost("spender", 1.00, created_at="2099-12-15T00:00:00+00:00")
    # NOTE: the aggregate is "current UTC month"; seed in the live month instead:
    from datetime import datetime, timezone

    this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
    _seed_run_cost("spender", 1.50, created_at=this_month)

    resp = client.post("/workers/spender/runs", json={"inputs": {}, "trigger_source": "manual"})
    assert resp.status_code == 402, resp.text
    body = resp.json()["detail"]
    assert body["error_code"] == "spend_cap_exceeded"
    assert "spend cap" in body["message"].lower()


def test_run_allowed_under_cap(client_main):
    client, _ = client_main
    assert _create(client, "thrifty", 10.0).status_code == 200
    from datetime import datetime, timezone

    this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
    _seed_run_cost("thrifty", 2.00, created_at=this_month)  # well under the $10 cap
    resp = client.post("/workers/thrifty/runs", json={"inputs": {}, "trigger_source": "manual"})
    assert resp.status_code == 200, resp.text


def test_prior_month_spend_does_not_count(client_main):
    client, _ = client_main
    assert _create(client, "freshmonth", 1.00).status_code == 200
    _seed_run_cost("freshmonth", 5.00, created_at="2000-01-15T00:00:00+00:00")  # ancient
    resp = client.post("/workers/freshmonth/runs", json={"inputs": {}, "trigger_source": "manual"})
    assert resp.status_code == 200, resp.text
