from __future__ import annotations

import pytest

from models import RunStatus


def test_run_repo_scopes_rows_by_owner(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.workers.create(
        user_id="user-b",
        worker_id="worker-b",
        name="Worker B",
        manifest_json=manifest("worker-b", "Worker B"),
        bundle_path="workers/worker-b",
    )

    repos.runs.create(
        user_id="user-a",
        run_id="run-a",
        worker_id="worker-a",
        input_json={"hello": "a"},
        trigger_source="manual",
        runner="e2b",
    )
    repos.runs.create(
        user_id="user-b",
        run_id="run-b",
        worker_id="worker-b",
        input_json={"hello": "b"},
        trigger_source="manual",
        runner="e2b",
    )

    repos.runs.update_status(user_id="user-a", run_id="run-a", status=RunStatus.COMPLETED.value, output_json={"ok": True})

    runs_a, total_a = repos.runs.list(user_id="user-a")
    runs_b, total_b = repos.runs.list(user_id="user-b")
    assert total_a == 1
    assert total_b == 1
    assert [row["id"] for row in runs_a] == ["run-a"]
    assert [row["id"] for row in runs_b] == ["run-b"]
    assert repos.runs.get(user_id="user-a", run_id="run-b") is None

    recent = repos.runs.list_for_worker(user_id="user-a", worker_id="worker-a", limit=10, offset=0)
    assert [row["id"] for row in recent] == ["run-a"]
    assert repos.runs.get(user_id="user-a", run_id="run-a")["status"] == RunStatus.COMPLETED.value


def test_failed_status_update_synthesizes_error_fields(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-silent-fail",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="e2b",
    )

    repos.runs.update_status(
        user_id="user-a",
        run_id="run-silent-fail",
        status=RunStatus.FAILED.value,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-silent-fail")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error"]
    assert row["error_code"] == "unknown_error"


def test_run_service_failed_status_update_synthesizes_error_fields(repo_bundle):
    import run_service

    repos, _db, manifest = repo_bundle
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-service-silent-fail",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="e2b",
    )

    run_service.update_run_status(
        "run-service-silent-fail",
        RunStatus.FAILED.value,
        user_id="user-a",
        repos=repos,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-service-silent-fail")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error"]
    assert row["error_code"] == "unknown_error"


def test_run_service_scrubs_secret_values_before_persisting_output(repo_bundle):
    import json
    import run_service

    repos, _db, manifest = repo_bundle
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-secret-output",
        name="Worker Secret Output",
        manifest_json=manifest("worker-secret-output", "Worker Secret Output"),
        bundle_path="workers/worker-secret-output",
    )
    repos.secrets.set(user_id="user-a", name="API_KEY", value="sk-test-secret-output")
    repos.runs.create(
        user_id="user-a",
        run_id="run-secret-output",
        worker_id="worker-secret-output",
        status=RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="e2b",
    )

    run_service.update_run_status(
        "run-secret-output",
        RunStatus.COMPLETED.value,
        output={
            "plain": "value sk-test-secret-output",
            "nested": {"token": "api_key=sk-test-secret-output"},
            "list": ["sk-test-secret-output"],
        },
        user_id="user-a",
        repos=repos,
    )

    row = repos.runs.get(user_id="user-a", run_id="run-secret-output")
    raw = row["output_json"]
    assert "sk-test-secret-output" not in raw
    stored = json.loads(raw)
    assert stored["plain"] == "value <REDACTED:API_KEY>"
    assert stored["nested"]["token"] == "<REDACTED>"
    assert stored["list"] == ["<REDACTED:API_KEY>"]


def test_run_repo_fails_running_rows_by_owner(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.workers.create(
        user_id="user-b",
        worker_id="worker-b",
        name="Worker B",
        manifest_json=manifest("worker-b", "Worker B"),
        bundle_path="workers/worker-b",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-a",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="e2b",
    )
    repos.runs.create(
        user_id="user-b",
        run_id="run-b",
        worker_id="worker-b",
        status=RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="e2b",
    )

    failed = repos.runs.fail_running(
        user_id="user-a",
        error="interrupted",
        error_code="interrupted_by_restart",
    )

    assert failed == ["run-a"]
    row_a = repos.runs.get(user_id="user-a", run_id="run-a")
    row_b = repos.runs.get(user_id="user-b", run_id="run-b")
    assert row_a["status"] == RunStatus.FAILED.value
    assert row_a["error"] == "interrupted"
    assert row_a["error_code"] == "interrupted_by_restart"
    assert row_a["completed_at"]
    assert row_b["status"] == RunStatus.RUNNING.value


def test_fail_running_synthesizes_missing_error_code(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-bulk-silent-code",
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="e2b",
    )

    failed = repos.runs.fail_running(user_id="user-a", error="interrupted")

    assert failed == ["run-bulk-silent-code"]
    row = repos.runs.get(user_id="user-a", run_id="run-bulk-silent-code")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error"] == "interrupted"
    assert row["error_code"] == "unknown_error"


def test_hitl_duration_excludes_approval_wait(repo_bundle):
    """G5 rescore4 P2: a run that parks at PENDING_APPROVAL captures its real
    execution duration at park time; the later approve->COMPLETED transition
    must NOT recompute duration to include the operator's approval-wait."""
    import datetime as _dt

    repos, _db, manifest = repo_bundle
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-hitl",
        worker_id="worker-a",
        input_json={"x": 1},
        trigger_source="manual",
        runner="e2b",
    )
    # Mark RUNNING with a started_at well in the past so execution time is real.
    repos.runs.update_status(user_id="user-a", run_id="run-hitl", status=RunStatus.RUNNING.value)
    started = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=5)).isoformat()
    repos.runs.update(user_id="user-a", run_id="run-hitl", started_at=started)

    # Park for approval -> duration captured now (~5s of execution).
    repos.runs.update_status(user_id="user-a", run_id="run-hitl", status=RunStatus.PENDING_APPROVAL.value)
    parked = repos.runs.get(user_id="user-a", run_id="run-hitl")
    assert parked["duration_ms"] is not None
    parked_duration = parked["duration_ms"]
    assert 3000 <= parked_duration <= 8000, parked_duration

    # Simulate a long approval wait, then approve -> COMPLETED.
    long_ago = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=5)).isoformat()
    repos.runs.update(user_id="user-a", run_id="run-hitl", started_at=long_ago)
    # (started_at unchanged in real flow; rewritten here only to prove the
    # COMPLETED branch does NOT recompute when duration_ms is already set.)
    repos.runs.update_status(user_id="user-a", run_id="run-hitl", status=RunStatus.COMPLETED.value)
    done = repos.runs.get(user_id="user-a", run_id="run-hitl")
    assert done["status"] == RunStatus.COMPLETED.value
    # Preserved the park-time execution duration; did NOT balloon to wall-clock.
    assert done["duration_ms"] == parked_duration


def test_normal_run_duration_unaffected(repo_bundle):
    """A run that never parks for approval still gets its duration computed at
    the COMPLETED transition (no regression)."""
    import datetime as _dt

    repos, _db, manifest = repo_bundle
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-normal",
        worker_id="worker-a",
        input_json={},
        trigger_source="manual",
        runner="e2b",
    )
    repos.runs.update_status(user_id="user-a", run_id="run-normal", status=RunStatus.RUNNING.value)
    started = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=2)).isoformat()
    repos.runs.update(user_id="user-a", run_id="run-normal", started_at=started)
    repos.runs.update_status(user_id="user-a", run_id="run-normal", status=RunStatus.COMPLETED.value)
    done = repos.runs.get(user_id="user-a", run_id="run-normal")
    assert done["duration_ms"] is not None
    assert done["duration_ms"] >= 1500


def test_run_log_and_artifact_paths_are_scoped_without_get_preflight(monkeypatch, repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-a",
        worker_id="worker-a",
        input_json={},
        trigger_source="manual",
        runner="e2b",
    )

    def _forbidden_get(*_args, **_kwargs):
        raise AssertionError("log/artifact hot paths must not call runs.get")

    monkeypatch.setattr(type(repos.runs), "get", _forbidden_get)

    repos.runs.add_log(
        user_id="user-a",
        run_id="run-a",
        level="info",
        message="first",
        timestamp="2026-06-08T00:00:00+00:00",
    )
    repos.runs.add_log(
        user_id="user-a",
        run_id="run-a",
        level="info",
        message="second",
        timestamp="2026-06-08T00:00:01+00:00",
    )
    logs = repos.runs.list_logs(user_id="user-a", run_id="run-a", limit=1)
    assert [row["message"] for row in logs] == ["first"]

    repos.runs.add_artifact(
        user_id="user-a",
        run_id="run-a",
        artifact_id="artifact-a",
        name="a.txt",
        artifact_type="text/plain",
        path="/tmp/a.txt",
        size_bytes=1,
        created_at="2026-06-08T00:00:00+00:00",
    )
    repos.runs.add_artifact(
        user_id="user-a",
        run_id="run-a",
        artifact_id="artifact-b",
        name="b.txt",
        artifact_type="text/plain",
        path="/tmp/b.txt",
        size_bytes=1,
        created_at="2026-06-08T00:00:01+00:00",
    )
    artifacts = repos.runs.list_artifacts(user_id="user-a", run_id="run-a", limit=1)
    assert [row["id"] for row in artifacts] == ["artifact-a"]


def test_run_log_and_artifact_paths_reject_foreign_owner(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id="run-a",
        worker_id="worker-a",
        input_json={},
        trigger_source="manual",
        runner="e2b",
    )

    with pytest.raises(ValueError, match="run run-a not found for user-b"):
        repos.runs.add_log(
            user_id="user-b",
            run_id="run-a",
            level="info",
            message="foreign",
            timestamp="2026-06-08T00:00:00+00:00",
        )

    with pytest.raises(ValueError, match="run run-a not found for user-b"):
        repos.runs.add_artifact(
            user_id="user-b",
            run_id="run-a",
            artifact_id="artifact-b",
            name="foreign.txt",
            artifact_type="text/plain",
            path="/tmp/foreign.txt",
            size_bytes=1,
            created_at="2026-06-08T00:00:00+00:00",
        )

    assert repos.runs.list_logs(user_id="user-b", run_id="run-a") == []
    assert repos.runs.list_artifacts(user_id="user-b", run_id="run-a") == []
