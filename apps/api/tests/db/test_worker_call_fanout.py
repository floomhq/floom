"""Per-run worker-call fan-out cap.

A run may spawn at most run_token.MAX_WORKER_CALLS_PER_RUN (50) child runs via
worker-to-worker calls. The server-side check at child-run creation counts the
parent's existing children via RunsRepository.count_child_runs (child runs carry
the parent run id in trigger_ref). This covers that counting primitive.
"""


def _ws_manifest(worker_id: str, name: str) -> dict:
    return {
        "id": worker_id,
        "name": name,
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }


def test_count_child_runs_counts_by_trigger_ref(repo_bundle):
    repos, _db, _manifest = repo_bundle
    repos.workers.upsert(
        user_id="owner",
        worker_id="child-worker",
        name="Child Worker",
        manifest_json=_ws_manifest("child-worker", "Child Worker"),
        bundle_path="workers/child-worker",
        visibility="workspace",
    )

    # No children yet.
    assert repos.runs.count_child_runs(parent_run_id="run-parent") == 0

    # Spawn 3 child runs that reference the parent via trigger_ref.
    for i in range(3):
        repos.runs.create(
            user_id="caller",
            run_id=f"run-child-{i}",
            worker_id="child-worker",
            input_json={},
            trigger_source="worker_call:depth=1",
            trigger_ref="run-parent",
            runner="e2b",
        )

    assert repos.runs.count_child_runs(parent_run_id="run-parent") == 3
    # Unrelated parent + empty id both return 0.
    assert repos.runs.count_child_runs(parent_run_id="run-other") == 0
    assert repos.runs.count_child_runs(parent_run_id="") == 0


def test_fanout_constant_is_a_sane_ceiling():
    from run_token import MAX_WORKER_CALLS_PER_RUN

    assert isinstance(MAX_WORKER_CALLS_PER_RUN, int)
    assert MAX_WORKER_CALLS_PER_RUN == 50
