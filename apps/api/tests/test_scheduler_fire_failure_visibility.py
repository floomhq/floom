"""A scheduled fire that dies must leave a FAILED run behind.

Production incident: every scheduled fire for an owner past their monthly
spend cap raised ``SpendCapExceeded`` inside ``create_run()``, BEFORE the runs
row was inserted. The scheduler logged it and advanced ``next_run_at``, so no
run row ever existed, the worker's ``last_run_status`` stayed "completed" from
days earlier, and the worker rendered as healthy while it had not fired for
100+ hours. Seventeen workers were silently dead for four days.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import scheduler
from run_service import SpendCapExceeded


class _Runs:
    """Fake runs repo whose list projection omits ``runner``, like sqlite."""

    def __init__(self):
        self.created: list[dict] = []
        self.create_error: Exception | None = None

    def create(self, *, user_id: str, **fields):
        if self.create_error is not None:
            raise self.create_error
        row = {"user_id": user_id, **fields}
        self.created.append(row)
        return row

    def count_running_for_worker(self, *, user_id: str, worker_id: str) -> int:
        return 0

    def list_for_worker(self, *, user_id: str, worker_id: str, limit: int, offset: int):
        rows = [r for r in self.created if r.get("worker_id") == worker_id]
        rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
        # Mirrors the real SELECT: no ``runner`` column in this projection.
        projected = [
            {
                "id": r["run_id"],
                "worker_id": r["worker_id"],
                "status": r.get("status"),
                "error": r.get("error"),
                "error_code": r.get("error_code"),
                "created_at": r.get("created_at"),
            }
            for r in rows
        ]
        return projected[offset : offset + limit]

    def get(self, *, user_id: str, run_id: str):
        return next((r for r in self.created if r["run_id"] == run_id), None)


class _Workers:
    def __init__(self, rows: dict | list[dict]):
        self.rows = rows if isinstance(rows, list) else [rows]
        self.next_updates: list[tuple[str, str | None]] = []
        self.fired: list[dict] = []
        self.worker_next_updates: list[tuple[str, str | None]] = []
        self.worker_scheduled_updates: list[dict] = []

    def list_due_schedule_triggers(self, *, now_iso: str):
        return list(self.rows)

    def claim_schedule_trigger(self, *, trigger_id: str, now_iso: str, locked_until: str) -> bool:
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

    def mark_scheduled_run(
        self,
        *,
        worker_id: str,
        last_scheduled_run_at: str,
        next_run_at: str | None,
    ) -> None:
        self.worker_scheduled_updates.append(
            {
                "worker_id": worker_id,
                "last_scheduled_run_at": last_scheduled_run_at,
                "next_run_at": next_run_at,
            }
        )

    def get_schedule_state(self, *, worker_id: str):
        return None

    def count_schedule_trigger_rows(self) -> int:
        return 0


class _Repos:
    def __init__(self, rows: dict | list[dict]):
        self.runs = _Runs()
        self.workers = _Workers(rows)


def _trigger_row(next_run_at: str) -> dict:
    return {
        "id": "trigger-a",
        "worker_id": "worker-a",
        "owner_id": "user-a",
        "cron_timezone": "UTC",
        "config_json": json.dumps({"cron": "*/15 * * * *", "timezone": "UTC"}),
        "next_run_at": next_run_at,
    }


def _patch_preflight(monkeypatch):
    monkeypatch.setenv("WORKEROS_SCHEDULE_MISSED_GRACE_SECONDS", "300")
    monkeypatch.setattr(scheduler, "_worker_is_archived", lambda _worker_id: False)
    monkeypatch.setattr(scheduler, "_owner_is_active", lambda _repos, _user_id: True)
    monkeypatch.setattr(
        scheduler,
        "_effective_scheduled_inputs",
        lambda _repos, _worker_id, **_kwargs: ({"topic": "weekly"}, []),
    )
    monkeypatch.setattr(scheduler, "_missing_secrets_for_scheduled_worker", lambda *_a, **_k: [])
    monkeypatch.setattr(scheduler, "_missing_connections_for_scheduled_worker", lambda *_a, **_k: [])
    monkeypatch.setattr(
        scheduler,
        "_maybe_pause_scheduled_worker_after_setup_failure",
        lambda **_kwargs: False,
    )
    monkeypatch.setattr(scheduler, "_emit_trigger_fired", lambda **_kwargs: None)


def _spend_cap_error() -> SpendCapExceeded:
    return SpendCapExceeded(
        "User has reached their monthly spend cap ($25.69 of $25.00)."
    )


def test_spend_cap_rejection_records_one_visible_failed_run(monkeypatch):
    now = datetime(2026, 7, 20, 12, 15, tzinfo=timezone.utc)
    repos = _Repos(_trigger_row((now - timedelta(seconds=30)).isoformat()))
    _patch_preflight(monkeypatch)

    def _create_run(*_args, **_kwargs):
        raise _spend_cap_error()

    monkeypatch.setattr(scheduler, "create_run", _create_run)
    monkeypatch.setattr(
        scheduler,
        "start_run",
        lambda *_a, **_k: pytest.fail("start_run must not run when create_run raised"),
    )

    assert scheduler._tick_trigger_rows(repos, now, now.isoformat()) == 1

    assert len(repos.runs.created) == 1
    failed = repos.runs.created[0]
    assert failed["status"] == "failed"
    assert failed["error_code"] == "spend_cap_exceeded"
    assert failed["runner"] == "scheduler"
    assert failed["trigger_source"] == "schedule"
    assert failed["trigger_ref"] == "trigger-a"
    assert failed["duration_ms"] == 0
    assert failed["input_json"] == {"topic": "weekly"}
    assert "$25.00" in failed["error"]

    # The trigger still advanced, so the scheduler never hot loops on the cap.
    expected_next = scheduler.compute_next_run_at("*/15 * * * *", now, "UTC")
    assert repos.workers.next_updates[-1] == ("trigger-a", expected_next)
    # last_fired_at is reserved for genuine success.
    assert repos.workers.fired == []


def test_repeated_spend_cap_failures_coalesce_but_still_advance(monkeypatch):
    now = datetime(2026, 7, 20, 12, 15, tzinfo=timezone.utc)
    row = _trigger_row((now - timedelta(seconds=30)).isoformat())
    repos = _Repos(row)
    _patch_preflight(monkeypatch)
    monkeypatch.setattr(scheduler, "create_run", lambda *_a, **_k: (_ for _ in ()).throw(_spend_cap_error()))

    scheduler._tick_trigger_rows(repos, now, now.isoformat())
    assert len(repos.runs.created) == 1

    later = now + timedelta(minutes=15)
    row["next_run_at"] = (later - timedelta(seconds=30)).isoformat()
    scheduler._tick_trigger_rows(repos, later, later.isoformat())

    # Same open episode, same billing month: no second row.
    assert len(repos.runs.created) == 1
    # Advancement is unconditional, coalesced or not.
    expected_next = scheduler.compute_next_run_at("*/15 * * * *", later, "UTC")
    assert repos.workers.next_updates[-1] == ("trigger-a", expected_next)


def test_different_failure_class_ends_the_episode_and_records_again(monkeypatch):
    now = datetime(2026, 7, 20, 12, 15, tzinfo=timezone.utc)
    row = _trigger_row((now - timedelta(seconds=30)).isoformat())
    repos = _Repos(row)
    _patch_preflight(monkeypatch)
    monkeypatch.setattr(scheduler, "create_run", lambda *_a, **_k: (_ for _ in ()).throw(_spend_cap_error()))

    scheduler._tick_trigger_rows(repos, now, now.isoformat())
    assert [r["error_code"] for r in repos.runs.created] == ["spend_cap_exceeded"]

    later = now + timedelta(minutes=15)
    row["next_run_at"] = (later - timedelta(seconds=30)).isoformat()
    monkeypatch.setattr(
        scheduler,
        "create_run",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("worker bundle missing")),
    )
    scheduler._tick_trigger_rows(repos, later, later.isoformat())

    assert [r["error_code"] for r in repos.runs.created] == [
        "spend_cap_exceeded",
        "schedule_fire_failed",
    ]
    assert "worker bundle missing" in repos.runs.created[-1]["error"]


def test_start_run_failure_fails_the_existing_run_without_a_second_row(monkeypatch):
    now = datetime(2026, 7, 20, 12, 15, tzinfo=timezone.utc)
    repos = _Repos(_trigger_row((now - timedelta(seconds=30)).isoformat()))
    _patch_preflight(monkeypatch)
    monkeypatch.setattr(scheduler, "create_run", lambda *_a, **_k: "run-live")
    monkeypatch.setattr(
        scheduler,
        "start_run",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("executor unreachable")),
    )
    status_updates: list[dict] = []
    monkeypatch.setattr(
        scheduler,
        "update_run_status",
        lambda run_id, status, **kwargs: status_updates.append(
            {"run_id": run_id, "status": status, **kwargs}
        ),
    )

    assert scheduler._tick_trigger_rows(repos, now, now.isoformat()) == 1

    # The run row created by create_run() is the one occurrence; no duplicate.
    assert repos.runs.created == []
    assert len(status_updates) == 1
    assert status_updates[0]["run_id"] == "run-live"
    assert status_updates[0]["status"] == "failed"
    assert status_updates[0]["error_code"] == "schedule_fire_failed"
    assert "executor unreachable" in status_updates[0]["error"]
    expected_next = scheduler.compute_next_run_at("*/15 * * * *", now, "UTC")
    assert repos.workers.next_updates[-1] == ("trigger-a", expected_next)


def test_failure_recording_that_throws_still_advances_the_schedule(monkeypatch):
    now = datetime(2026, 7, 20, 12, 15, tzinfo=timezone.utc)
    repos = _Repos(_trigger_row((now - timedelta(seconds=30)).isoformat()))
    _patch_preflight(monkeypatch)
    monkeypatch.setattr(scheduler, "create_run", lambda *_a, **_k: (_ for _ in ()).throw(_spend_cap_error()))

    def _explode(*_args, **_kwargs):
        raise RuntimeError("runs table unavailable")

    monkeypatch.setattr(scheduler, "_create_synthetic_failed_schedule_run", _explode)

    assert scheduler._tick_trigger_rows(repos, now, now.isoformat()) == 1

    expected_next = scheduler.compute_next_run_at("*/15 * * * *", now, "UTC")
    assert repos.workers.next_updates[-1] == ("trigger-a", expected_next)


def test_legacy_worker_scalar_path_also_records_the_cap_failure(monkeypatch):
    repos = _Repos([])
    _patch_preflight(monkeypatch)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "create_run", lambda *_a, **_k: (_ for _ in ()).throw(_spend_cap_error()))
    monkeypatch.setattr(
        scheduler,
        "_list_scheduled_worker_instances",
        lambda: [
            {
                "id": "worker-legacy",
                "owner_id": "user-legacy",
                "cron_expr": "*/15 * * * *",
                "cron_timezone": "UTC",
            }
        ],
    )
    monkeypatch.setattr(
        scheduler,
        "_get_or_init_next_run_at",
        lambda *_a, **_k: (
            datetime.now(timezone.utc) - timedelta(seconds=30)
        ).isoformat(),
    )

    scheduler._tick()

    assert len(repos.runs.created) == 1
    failed = repos.runs.created[0]
    assert failed["worker_id"] == "worker-legacy"
    assert failed["error_code"] == "spend_cap_exceeded"
    assert failed["runner"] == "scheduler"
    assert failed["trigger_ref"] is None
    assert repos.workers.worker_next_updates
    assert repos.workers.worker_next_updates[-1][0] == "worker-legacy"
    assert repos.workers.worker_next_updates[-1][1] is not None
