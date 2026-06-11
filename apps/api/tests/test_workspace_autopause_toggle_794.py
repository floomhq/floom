"""#794 — workspace behaviour toggle 'auto_pause_enabled' is now enforced from
the workspace_settings table (DB setting overrides the env var).

(The GET/PUT /workspace/settings endpoints + table already existed; this wires
the auto_pause toggle into the run-failure path. failure_email/approval_default
enforcement tracked separately.)

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


def test_default_is_on(run_service):
    rs, db = run_service
    assert rs._auto_pause_on_consecutive_failures_enabled() is True


def test_db_setting_off_overrides(run_service):
    rs, db = run_service
    _set_setting(db, "auto_pause_enabled", "0")
    assert rs._auto_pause_on_consecutive_failures_enabled() is False


def test_db_setting_on(run_service):
    rs, db = run_service
    _set_setting(db, "auto_pause_enabled", "true")
    assert rs._auto_pause_on_consecutive_failures_enabled() is True


def test_db_setting_beats_env(run_service, monkeypatch):
    rs, db = run_service
    monkeypatch.setenv("WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES", "0")
    _set_setting(db, "auto_pause_enabled", "1")
    # DB 'on' wins over env 'off'
    assert rs._auto_pause_on_consecutive_failures_enabled() is True


def test_env_used_when_no_db_setting(run_service, monkeypatch):
    rs, db = run_service
    monkeypatch.setenv("WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES", "0")
    assert rs._auto_pause_on_consecutive_failures_enabled() is False
