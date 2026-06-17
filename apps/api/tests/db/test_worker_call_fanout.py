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


# --- #1444: per-workspace configurable fan-out limit (within the 50 hard cap) ---

def test_workspace_fanout_setting_validation():
    """The setting accepts 1..ceiling and rejects anything outside that range,
    so a workspace can lower but never raise the cap."""
    from fastapi import HTTPException
    from routers.workspace import _validate_workspace_setting
    from run_token import MAX_WORKER_CALLS_PER_RUN

    assert _validate_workspace_setting("worker_call_fanout_limit", "10") == "10"
    assert (
        _validate_workspace_setting("worker_call_fanout_limit", str(MAX_WORKER_CALLS_PER_RUN))
        == str(MAX_WORKER_CALLS_PER_RUN)
    )
    for bad in ("0", "-1", str(MAX_WORKER_CALLS_PER_RUN + 1), "abc", ""):
        try:
            _validate_workspace_setting("worker_call_fanout_limit", bad)
        except HTTPException as exc:
            assert exc.status_code == 422
        else:
            raise AssertionError(f"expected rejection for {bad!r}")


def test_resolve_workspace_fanout_limit_defaults_and_clamps(repo_bundle):
    """Unset -> hard ceiling; a stored value is clamped into [1, ceiling]."""
    from db import get_db, now_iso
    from run_token import MAX_WORKER_CALLS_PER_RUN
    from services.workspace_ops import (
        WORKER_CALL_FANOUT_SETTING_KEY,
        resolve_workspace_fanout_limit,
    )

    ws = "ws-fanout-test"
    # Unset -> defaults to the hard ceiling.
    assert resolve_workspace_fanout_limit(ws) == MAX_WORKER_CALLS_PER_RUN

    def _set(value: str) -> None:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO workspace_settings (workspace_id, key, value, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value
                """,
                (ws, WORKER_CALL_FANOUT_SETTING_KEY, value, now_iso()),
            )

    _set("5")
    assert resolve_workspace_fanout_limit(ws) == 5
    # Above the ceiling is clamped down (defence in depth even if validation is bypassed).
    _set(str(MAX_WORKER_CALLS_PER_RUN + 100))
    assert resolve_workspace_fanout_limit(ws) == MAX_WORKER_CALLS_PER_RUN
    # Below 1 floors at 1; malformed falls back to the ceiling.
    _set("0")
    assert resolve_workspace_fanout_limit(ws) == 1
    _set("not-an-int")
    assert resolve_workspace_fanout_limit(ws) == MAX_WORKER_CALLS_PER_RUN
