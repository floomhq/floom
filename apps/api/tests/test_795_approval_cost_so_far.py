"""#795 — approval Run tab: cost so far (token count + USD estimate).

A paused (pending_approval) run snapshots its tokens-so-far onto the approval
at creation; the approval response surfaces tokens_so_far + cost_usd_so_far so
the Run tab renders "1.2k tok · $0.01" without a separate run fetch.

Run: cd apps/api && python -m pytest tests/test_795_approval_cost_so_far.py -q
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-795"


@pytest.fixture
def client_main(monkeypatch, tmp_path):
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_USER_ID", "local-user")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service", "cost") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    return client, main


_WORKER_YML = (
    'schema_version: "0.3"\nid: "w-appr"\nname: "w-appr"\ntitle: t\n'
    'description: d\nversion: "0.1.0"\nexec:\n  entry: run.py\n  runtime: python311\n'
    '  runner: e2b\n  command: python run.py\n  inputs: []\n  outputs: []\n'
    'trigger:\n  type: manual\nconnections: []\n'
)


def _seed_run_and_approval(client, *, tokens, cost):
    # create a real worker so the approval FK (worker_id) is satisfied
    assert client.post("/workers", json={"worker_yml": _WORKER_YML, "run_py": "print(1)"}).status_code == 200
    from db import get_db, now_iso

    with get_db() as conn:
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at) "
            "VALUES ('run_appr', 'w-appr', 'pending_approval', 'manual', 'e2b', ?)",
            (now_iso(),),
        )
        conn.execute(
            "INSERT INTO approvals (id, run_id, worker_id, status, created_at, owner_id, tokens_so_far, cost_usd_so_far) "
            "VALUES ('appr_1', 'run_appr', 'w-appr', 'pending', ?, 'local-user', ?, ?)",
            (now_iso(), tokens, cost),
        )


def test_migration_77_columns_exist(client_main):
    _client, _ = client_main
    from db import get_db

    with get_db() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(approvals)").fetchall()}
    assert {"tokens_so_far", "cost_usd_so_far"} <= cols


def test_approval_response_surfaces_cost_so_far(client_main):
    client, _ = client_main
    _seed_run_and_approval(client, tokens=1200, cost=0.006)
    resp = client.get("/approvals")
    assert resp.status_code == 200, resp.text
    appr = next((a for a in resp.json() if a["id"] == "appr_1"), None)
    assert appr is not None, "seeded approval not listed"
    assert appr["tokens_so_far"] == 1200
    assert appr["cost_usd_so_far"] == 0.006


def test_snapshot_helper_uses_cost_estimator(client_main):
    # the snapshot path computes cost from tokens via the shared estimator
    import cost

    assert cost.estimate_cost_usd(1_000_000) == round(cost.usd_per_mtok(), 6)
    # null tokens (pure-script / no transcript) → 0 cost, never raises
    assert cost.estimate_cost_usd(None) == 0.0


def test_run_service_snapshots_into_create(client_main, monkeypatch):
    # guards the wiring: the approval create call passes tokens_so_far/cost
    import inspect
    import run_service

    src = inspect.getsource(run_service)
    assert "tokens_so_far=_tokens_so_far" in src
    assert "cost_usd_so_far=_cost_so_far" in src
    assert "total_tokens_from_transcript(run_id)" in src
