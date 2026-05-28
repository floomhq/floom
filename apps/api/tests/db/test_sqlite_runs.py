from __future__ import annotations

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
