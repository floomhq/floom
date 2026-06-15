from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service


class _Runs:
    def get_any(self, *, run_id: str):
        return {"id": run_id, "retry_attempt": 0}


class _Repos:
    runs = _Runs()


def test_retryable_driver_failure_schedules_one_retry(monkeypatch):
    scheduled: list[dict] = []
    logs: list[tuple[str, str]] = []

    def _fake_schedule_retry(**kwargs):
        scheduled.append(kwargs)

    monkeypatch.setattr(run_service, "_schedule_retry", _fake_schedule_retry)

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={"x": 1},
        owner_id="user-a",
        config=None,
        result_retryable=True,
        repos=_Repos(),
        log_fn=lambda msg, level="info": logs.append((msg, level)),
    )

    assert did_schedule is True
    assert len(scheduled) == 1
    assert scheduled[0]["original_run_id"] == "run-original"
    assert scheduled[0]["worker_id"] == "worker-a"
    assert scheduled[0]["inputs"] == {"x": 1}
    assert scheduled[0]["attempt"] == 1
    assert scheduled[0]["delay_seconds"] == 60
    assert scheduled[0]["user_id"] == "user-a"
    assert isinstance(scheduled[0]["repos"], _Repos)
    assert any("Scheduling retryable failure 1/1 in 60s" in msg for msg, _level in logs)


def test_non_retryable_failure_without_policy_does_not_schedule(monkeypatch):
    scheduled: list[dict] = []
    monkeypatch.setattr(run_service, "_schedule_retry", lambda **kwargs: scheduled.append(kwargs))

    did_schedule = run_service._schedule_retry_for_failed_run(
        run_id="run-original",
        worker_id="worker-a",
        inputs={},
        owner_id="user-a",
        config=None,
        result_retryable=False,
        repos=_Repos(),
        log_fn=lambda *_args, **_kwargs: None,
    )

    assert did_schedule is False
    assert scheduled == []
