"""#1201: GET /workers/{worker_id}/spend, a single worker's month-to-date
spend + its configured monthly cap, read-only.

Run: cd apps/api && python -m pytest tests/test_1201_worker_spend_endpoint.py -q
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

SECRET = "test-secret-1201"


def _yml(worker_id: str, *, monthly_cost_cap: float | None = None) -> str:
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
    if monthly_cost_cap is not None:
        base += f"limits:\n  max_monthly_cost_usd: {monthly_cost_cap}\n"
    return base


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


def _seed_cost(worker_id, cost, created_at):
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at, total_cost_usd) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"r_{worker_id}_{int(cost*100)}", worker_id, "completed", "manual", "e2b", created_at, cost),
        )


class TestWorkerSpendEndpoint:
    def test_returns_month_to_date_spend_and_cap(self, client_main):
        from datetime import datetime, timezone

        client, _ = client_main
        assert client.post(
            "/workers", json={"worker_yml": _yml("spendworkeralpha", monthly_cost_cap=25.0), "run_py": "print(1)"}
        ).status_code == 200
        this_month = datetime.now(timezone.utc).strftime("%Y-%m-05T00:00:00+00:00")
        _seed_cost("spendworkeralpha", 7.5, this_month)

        resp = client.get("/workers/spendworkeralpha/spend")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["worker_id"] == "spendworkeralpha"
        assert body["month_spend_usd"] >= 7.5
        assert body["monthly_cap_usd"] == 25.0

    def test_worker_with_no_cap_returns_null_cap(self, client_main):
        client, _ = client_main
        assert client.post(
            "/workers", json={"worker_yml": _yml("spendworkerbeta"), "run_py": "print(1)"}
        ).status_code == 200

        resp = client.get("/workers/spendworkerbeta/spend")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["month_spend_usd"] == 0.0
        assert body["monthly_cap_usd"] is None

    def test_unknown_worker_404s(self, client_main):
        client, _ = client_main
        resp = client.get("/workers/does-not-exist-at-all/spend")
        assert resp.status_code == 404, resp.text
