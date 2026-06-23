from __future__ import annotations

from services.run_serialize import _effective_run_status, _make_run_summary


def test_running_run_with_terminal_timing_serializes_as_completed():
    row = {
        "id": "run_1704",
        "worker_id": "worker",
        "worker_name": "Worker",
        "status": "running",
        "trigger_source": "manual",
        "input_json": "{}",
        "created_at": "2026-06-20T21:00:00Z",
        "started_at": "2026-06-20T21:00:01Z",
        "completed_at": "2026-06-20T21:00:58Z",
        "duration_ms": 56700,
        "error": None,
        "error_code": None,
    }

    summary = _make_run_summary(row)

    assert summary.status == "completed"
    assert summary.duration_ms == 56700
    assert summary.completed_at == "2026-06-20T21:00:58Z"


def test_running_run_with_terminal_timing_and_error_serializes_as_failed():
    assert _effective_run_status(
        {
            "status": "running",
            "completed_at": "2026-06-20T21:00:58Z",
            "duration_ms": 56700,
            "error": "boom",
        }
    ) == "failed"
