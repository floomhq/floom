"""r9 BE: surface stored-but-hidden backend values on the DETAIL panes.

- RunDetail.total_cost_usd — the stored per-run spend (runs.total_cost_usd,
  #793/#795) is now returned on GET /runs/{id}. Returns the value when a real
  (>0) spend is recorded, and is omitted/None when the run has no cost yet (the
  column defaults to 0.0).
- WorkerDetail.next_run_at / last_fired_at — the scheduler bookkeeping stored on
  the workers row (next_run_at + last_scheduled_run_at) is now returned on
  GET /workers/{id}. Returns the values when set, null when the worker has never
  been scheduled/fired.

Run: cd apps/api && python -m pytest tests/test_surface_cost_nextrun_r9.py -q
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

SECRET = "test-secret-cost-nextrun-r9"


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
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(
            ("routers", "services", "core", "db", "auth", "contexts", "runner_sandbox")
        ):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    main.start_run = lambda *a, **k: None
    import run_service

    run_service.start_run = main.start_run
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    return client, main


def _seed_run(worker_id: str, run_id: str, *, total_cost_usd=None):
    """Insert a completed run row. When total_cost_usd is None the column keeps
    its DEFAULT 0.0 (the "no cost recorded yet" state)."""
    from datetime import datetime, timezone

    from db import get_db

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    with get_db() as conn:
        if total_cost_usd is None:
            conn.execute(
                "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at) "
                "VALUES (?, ?, 'completed', 'manual', 'e2b', ?)",
                (run_id, worker_id, now),
            )
        else:
            conn.execute(
                "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at, total_cost_usd) "
                "VALUES (?, ?, 'completed', 'manual', 'e2b', ?, ?)",
                (run_id, worker_id, now, total_cost_usd),
            )


def _set_schedule_fields(worker_id: str, *, next_run_at, last_scheduled_run_at):
    from db import get_db

    with get_db() as conn:
        conn.execute(
            "UPDATE workers SET next_run_at = ?, last_scheduled_run_at = ? WHERE id = ?",
            (next_run_at, last_scheduled_run_at, worker_id),
        )


# --------------------------------------------------------------------------- #
# BE-COST: RunDetail.total_cost_usd
# --------------------------------------------------------------------------- #
class TestRunDetailCost:
    def test_cost_returned_when_set(self, client_main):
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("costworker"), "run_py": "print(1)"}).status_code
            == 200
        )
        _seed_run("costworker", "run_cost_set", total_cost_usd=0.4231)
        resp = client.get("/runs/run_cost_set")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total_cost_usd"] == pytest.approx(0.4231)

    def test_cost_null_when_not_recorded(self, client_main):
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("costworker2"), "run_py": "print(1)"}).status_code
            == 200
        )
        # No cost recorded → column DEFAULT 0.0 → detail hides it (None, omitted).
        _seed_run("costworker2", "run_cost_zero", total_cost_usd=None)
        resp = client.get("/runs/run_cost_zero")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # response_model_exclude_none=True drops a None field entirely.
        assert body.get("total_cost_usd") is None

    def test_repo_update_persists_tokens_and_cost(self, client_main):
        """The bug #2 fix: cost persistence routes through repos.runs.update so
        it lands in whatever backend the deployment uses (sqlite OR cloud
        Supabase). Previously the raw get_db() write missed the cloud entirely.
        """
        import importlib

        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("costworker3"), "run_py": "print(1)"}).status_code
            == 200
        )
        _seed_run("costworker3", "run_cost_repo", total_cost_usd=None)

        db = importlib.import_module("db")
        repos = db.get_repositories()
        # Resolve the worker owner so the repo's ownership-scoped update applies.
        from db import get_db

        with get_db() as conn:
            owner_id = conn.execute(
                "SELECT owner_id FROM workers WHERE id = ?", ("costworker3",)
            ).fetchone()[0]

        # Mirror what _persist_run_cost now does at terminal status.
        repos.runs.update(
            user_id=owner_id,
            run_id="run_cost_repo",
            total_tokens=12345,
            total_cost_usd=0.0617,
        )

        # Ground truth: the columns were written by the repo update path. (The
        # runs SELECT exposes total_cost_usd via the model; total_tokens is read
        # from the transcript at request time, so assert the stored columns
        # directly here.)
        with get_db() as conn:
            stored = conn.execute(
                "SELECT total_tokens, total_cost_usd FROM runs WHERE id = ?",
                ("run_cost_repo",),
            ).fetchone()
        assert stored["total_tokens"] == 12345
        assert stored["total_cost_usd"] == pytest.approx(0.0617)


# --------------------------------------------------------------------------- #
# BE-NEXTRUN: WorkerDetail.next_run_at / last_fired_at
# --------------------------------------------------------------------------- #
class TestWorkerDetailSchedule:
    def test_schedule_fields_returned_when_set(self, client_main):
        client, _ = client_main
        assert (
            client.post(
                "/workers", json={"worker_yml": _yml("schedworker"), "run_py": "print(1)"}
            ).status_code
            == 200
        )
        _set_schedule_fields(
            "schedworker",
            next_run_at="2026-07-01T09:00:00+00:00",
            last_scheduled_run_at="2026-06-30T09:00:00+00:00",
        )
        resp = client.get("/workers/schedworker")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["next_run_at"] == "2026-07-01T09:00:00+00:00"
        assert body["last_fired_at"] == "2026-06-30T09:00:00+00:00"

    def test_schedule_fields_null_when_unset(self, client_main):
        client, _ = client_main
        assert (
            client.post(
                "/workers", json={"worker_yml": _yml("schedworker2"), "run_py": "print(1)"}
            ).status_code
            == 200
        )
        # Never scheduled → both columns NULL → detail omits them.
        resp = client.get("/workers/schedworker2")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body.get("next_run_at") is None
        assert body.get("last_fired_at") is None
