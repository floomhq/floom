"""#794 — workspace behaviour toggle 'auto_pause_enabled' remains accepted by
the workspace_settings table for compatibility.

Broad consecutive-failure auto-pause is now disabled as a silent-death
mechanism. The setting/env var no longer makes the run-failure path disable
workers. failure_email/approval_default enforcement tracked separately.

Run: cd apps/api && python -m pytest tests/test_workspace_autopause_toggle_794.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture
def run_service(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.delenv("WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES", raising=False)
    for name in list(sys.modules):
        if name == "run_service" or name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("run_service"), db


def _set_setting(db, key, value, workspace_id="local-default"):
    with db.get_db() as conn:
        conn.execute(
            "INSERT INTO workspace_settings (workspace_id, key, value, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value",
            (workspace_id, key, value, db.now_iso()),
        )


def test_default_is_off_noop(run_service):
    rs, db = run_service
    assert rs._auto_pause_on_consecutive_failures_enabled() is False


def test_db_setting_off_overrides(run_service):
    rs, db = run_service
    _set_setting(db, "auto_pause_enabled", "0")
    assert rs._auto_pause_on_consecutive_failures_enabled() is False


def test_db_setting_on(run_service):
    rs, db = run_service
    _set_setting(db, "auto_pause_enabled", "true")
    assert rs._auto_pause_on_consecutive_failures_enabled() is False


def test_db_setting_beats_env(run_service, monkeypatch):
    rs, db = run_service
    monkeypatch.setenv("WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES", "0")
    _set_setting(db, "auto_pause_enabled", "1")
    assert rs._auto_pause_on_consecutive_failures_enabled() is False


def test_env_used_when_no_db_setting(run_service, monkeypatch):
    rs, db = run_service
    monkeypatch.setenv("WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES", "0")
    assert rs._auto_pause_on_consecutive_failures_enabled() is False


def test_permanent_failures_do_not_count_toward_broad_pause(run_service):
    rs, _db = run_service

    class Runs:
        def list(self, **_kwargs):
            return (
                [
                    {
                        "status": "failed",
                        "trigger_source": "schedule",
                        "error_code": "invalid_worker",
                    }
                    for _ in range(5)
                ],
                5,
            )

    class Workers:
        def update(self, **_kwargs):
            raise AssertionError("broad auto-pause must not disable workers")

        def get(self, **_kwargs):
            return {"manifest": {"name": "worker-a"}}

    class Repos:
        runs = Runs()
        workers = Workers()

    assert (
        rs._maybe_pause_worker_after_consecutive_failures(
            worker_id="worker-a",
            user_id="user-a",
            repos=Repos(),
        )
        is False
    )
