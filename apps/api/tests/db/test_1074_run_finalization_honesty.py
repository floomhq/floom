"""#1074 — run-finalization honesty guard at the persistence boundary.

A finalized run must never hold a contradictory (status, error, output) triple.
`runs.update_status` is the single funnel every driver/finalizer goes through, so
it enforces:
  - COMPLETED carrying a real error (passed in OR already stored) -> coerce to
    FAILED, keep the error, and drop any leaked smoke/gate output.
  - COMPLETED with no error -> NULL any stale error column so the row is honest.
  - A clean completion is untouched (status COMPLETED, real output kept).
"""

from __future__ import annotations

import json

from models import RunStatus


def _worker_and_run(repos, manifest, run_id="run-x"):
    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.runs.create(
        user_id="user-a",
        run_id=run_id,
        worker_id="worker-a",
        status=RunStatus.RUNNING.value,
        started_at="2026-06-14T00:00:00+00:00",
        trigger_source="manual",
        runner="e2b",
    )


def test_completed_with_stored_error_coerces_to_failed_and_drops_output(repo_bundle):
    repos, _db, manifest = repo_bundle
    _worker_and_run(repos, manifest)
    # An earlier write recorded a runner error on the row (status unchanged).
    repos.runs.update(user_id="user-a", run_id="run-x", error="Server disconnected")

    # A later finalize tries to land the run COMPLETED with leaked smoke output.
    repos.runs.update_status(
        user_id="user-a",
        run_id="run-x",
        status=RunStatus.COMPLETED.value,
        output_json={"result": "HELLO WORLD"},
    )

    row = repos.runs.get(user_id="user-a", run_id="run-x")
    assert row["status"] == RunStatus.FAILED.value
    assert row["error"] == "Server disconnected"
    assert not row.get("output_json")  # smoke output must not survive on a failure


def test_completed_with_inline_error_arg_coerces_to_failed_and_drops_output(repo_bundle):
    repos, _db, manifest = repo_bundle
    _worker_and_run(repos, manifest)

    repos.runs.update_status(
        user_id="user-a",
        run_id="run-x",
        status=RunStatus.COMPLETED.value,
        error="Worker directory not found: .../uppercaser",
        error_code="execution_error",
        output_json={"result": "HELLO WORLD, THIS IS A SMOKE TEST"},
    )

    row = repos.runs.get(user_id="user-a", run_id="run-x")
    assert row["status"] == RunStatus.FAILED.value
    assert "Worker directory not found" in (row["error"] or "")
    assert row["error_code"] == "execution_error"
    assert not row.get("output_json")


def test_clean_completion_clears_stale_blank_error(repo_bundle):
    repos, _db, manifest = repo_bundle
    _worker_and_run(repos, manifest)
    # Leftover blank error column from an earlier write.
    repos.runs.update(user_id="user-a", run_id="run-x", error="")

    repos.runs.update_status(
        user_id="user-a",
        run_id="run-x",
        status=RunStatus.COMPLETED.value,
        output_json={"result": "ok"},
    )

    row = repos.runs.get(user_id="user-a", run_id="run-x")
    assert row["status"] == RunStatus.COMPLETED.value
    assert not row.get("error")
    assert json.loads(row["output_json"]) == {"result": "ok"}


def test_genuine_completion_is_untouched(repo_bundle):
    repos, _db, manifest = repo_bundle
    _worker_and_run(repos, manifest)

    repos.runs.update_status(
        user_id="user-a",
        run_id="run-x",
        status=RunStatus.COMPLETED.value,
        output_json={"result": "real output"},
    )

    row = repos.runs.get(user_id="user-a", run_id="run-x")
    assert row["status"] == RunStatus.COMPLETED.value
    assert json.loads(row["output_json"]) == {"result": "real output"}
    assert not row.get("error")
    assert row["completed_at"]
