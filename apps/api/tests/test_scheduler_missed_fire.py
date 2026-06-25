from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import scheduler


class _Runs:
    def __init__(self):
        self.created: list[dict] = []

    def create(self, *, user_id: str, **fields):
        row = {"user_id": user_id, **fields}
        self.created.append(row)
        return row

    def count_running_for_worker(self, *, user_id: str, worker_id: str) -> int:
        return 0


class _Workers:
    def __init__(self, row: dict):
        self.row = row
        self.claimed: list[str] = []
        self.next_updates: list[tuple[str, str | None]] = []
        self.fired: list[dict] = []
        self.worker_next_updates: list[tuple[str, str | None]] = []

    def list_due_schedule_triggers(self, *, now_iso: str):
        return [self.row]

    def claim_schedule_trigger(self, *, trigger_id: str, now_iso: str, locked_until: str) -> bool:
        self.claimed.append(trigger_id)
        return True

    def set_trigger_next_run_at(self, *, trigger_id: str, next_run_at: str | None) -> None:
        self.next_updates.append((trigger_id, next_run_at))

    def mark_trigger_fired(self, *, trigger_id: str, last_fired_at: str, next_run_at: str | None) -> None:
        self.fired.append(
            {
                "trigger_id": trigger_id,
                "last_fired_at": last_fired_at,
                "next_run_at": next_run_at,
            }
        )

    def set_next_run_at(self, *, worker_id: str, next_run_at: str | None) -> None:
        self.worker_next_updates.append((worker_id, next_run_at))


class _Repos:
    def __init__(self, row: dict):
        self.runs = _Runs()
        self.workers = _Workers(row)


def _trigger_row(next_run_at: str) -> dict:
    return {
        "id": "trigger-a",
        "worker_id": "worker-a",
        "owner_id": "user-a",
        "cron_timezone": "UTC",
        "config_json": json.dumps({"cron": "*/5 * * * *", "timezone": "UTC"}),
        "next_run_at": next_run_at,
    }


def test_late_schedule_trigger_records_one_schedule_missed_marker(monkeypatch):
    now = datetime(2026, 6, 24, 12, 20, tzinfo=timezone.utc)
    repos = _Repos(_trigger_row((now - timedelta(minutes=10)).isoformat()))
    normal_runs: list[dict] = []
    started: list[str] = []

    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSED_GRACE_SECONDS", "120")
    monkeypatch.setattr(scheduler, "_worker_is_archived", lambda _worker_id: False)
    monkeypatch.setattr(scheduler, "_owner_is_active", lambda _repos, _user_id: True)
    monkeypatch.setattr(scheduler, "_effective_scheduled_inputs", lambda _repos, _worker_id, **_kwargs: ({}, []))
    monkeypatch.setattr(scheduler, "_missing_secrets_for_scheduled_worker", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(scheduler, "_missing_connections_for_scheduled_worker", lambda *_args, **_kwargs: [])

    def _create_run(worker_id, inputs, **kwargs):
        normal_runs.append({"worker_id": worker_id, "inputs": inputs, **kwargs})
        return "run-normal"

    monkeypatch.setattr(scheduler, "create_run", _create_run)
    monkeypatch.setattr(
        scheduler,
        "start_run",
        lambda run_id, *_args, **_kwargs: started.append(run_id),
    )
    monkeypatch.setattr(scheduler, "_emit_trigger_fired", lambda **_kwargs: None)

    considered = scheduler._tick_trigger_rows(repos, now, now.isoformat())

    assert considered == 1
    assert len(repos.runs.created) == 1
    missed = repos.runs.created[0]
    assert missed["trigger_source"] == "schedule_missed"
    assert missed["trigger_ref"] == "trigger-a"
    assert missed["status"] == "failed"
    assert missed["error_code"] == "schedule_missed"
    assert len(normal_runs) == 1
    assert started == ["run-normal"]


def test_preflight_missing_secret_records_failed_schedule_run(monkeypatch):
    now = datetime(2026, 6, 24, 12, 20, tzinfo=timezone.utc)
    repos = _Repos(_trigger_row((now - timedelta(seconds=30)).isoformat()))
    normal_runs: list[dict] = []

    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSED_GRACE_SECONDS", "300")
    monkeypatch.setattr(scheduler, "_worker_is_archived", lambda _worker_id: False)
    monkeypatch.setattr(scheduler, "_owner_is_active", lambda _repos, _user_id: True)
    monkeypatch.setattr(scheduler, "_effective_scheduled_inputs", lambda _repos, _worker_id, **_kwargs: ({}, []))
    monkeypatch.setattr(scheduler, "_missing_secrets_for_scheduled_worker", lambda *_args, **_kwargs: ["API_KEY"])
    monkeypatch.setattr(scheduler, "_missing_connections_for_scheduled_worker", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(scheduler, "create_run", lambda *args, **kwargs: normal_runs.append(kwargs))

    considered = scheduler._tick_trigger_rows(repos, now, now.isoformat())

    assert considered == 1
    assert normal_runs == []
    assert len(repos.runs.created) == 1
    skipped = repos.runs.created[0]
    assert skipped["trigger_source"] == "schedule"
    assert skipped["trigger_ref"] == "trigger-a"
    assert skipped["status"] == "failed"
    assert skipped["error_code"] == "missing_secret"
    assert "API_KEY" in skipped["error"]
    assert repos.workers.next_updates
