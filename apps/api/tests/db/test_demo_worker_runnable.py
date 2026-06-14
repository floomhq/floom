"""Regression: stock/example demo workers must be runnable by any member.

Root cause (2026-06-14 audits, Issue 10 / OSS #7): stock demos like
`outbound-approval-demo` were persisted `visibility='private'` + fede-owned, so
a fresh non-owner member hit `ValueError: worker <id> does not belong to <uid>`
at RunsRepository.create (which only permits owner OR visibility='workspace').
That ValueError was masked as a generic 400 "Invalid request". Fix:
_persist_discovered_workers seeds curated stock/example workers as
visibility='workspace'.
"""

from pathlib import Path

import pytest


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


def test_workspace_worker_runnable_by_non_owner(repo_bundle):
    """A visibility='workspace' worker can be run by a non-owner member."""
    repos, _db, _manifest = repo_bundle
    repos.workers.upsert(
        user_id="owner-fede",
        worker_id="outbound-approval-demo",
        name="Outbound Approval Demo",
        manifest_json=_ws_manifest("outbound-approval-demo", "Outbound Approval Demo"),
        bundle_path="workers/outbound-approval-demo",
        visibility="workspace",
    )
    # A different user (fresh member) must be able to create a run.
    created = repos.runs.create(
        user_id="fresh-member",
        run_id="run-demo-1",
        worker_id="outbound-approval-demo",
        input_json={"prospect_name": "Audit Test"},
        trigger_source="manual",
        runner="e2b",
    )
    assert created is not None
    # Run is attributed to the worker owner so owner-scoped queries keep working.
    runs_owner, total_owner = repos.runs.list(user_id="owner-fede")
    assert total_owner == 1
    assert runs_owner[0]["id"] == "run-demo-1"


def test_private_worker_not_runnable_by_non_owner(repo_bundle):
    """A private worker still rejects a non-owner (the guard is intact)."""
    repos, _db, _manifest = repo_bundle
    repos.workers.upsert(
        user_id="owner-fede",
        worker_id="private-real-worker",
        name="Private Real Worker",
        manifest_json=_ws_manifest("private-real-worker", "Private Real Worker"),
        bundle_path="workers/private-real-worker",
        visibility="private",
    )
    with pytest.raises(ValueError) as exc:
        repos.runs.create(
            user_id="fresh-member",
            run_id="run-private-1",
            worker_id="private-real-worker",
            input_json={},
            trigger_source="manual",
            runner="e2b",
        )
    assert "does not belong" in str(exc.value)


def test_persist_seeds_stock_demos_as_workspace_visibility():
    """Source guard: _persist_discovered_workers must seed stock/example demos
    (PROTECTED_STOCK_WORKER_IDS or is_example:true) as visibility='workspace'."""
    src = (Path(__file__).parents[2] / "main.py").read_text(encoding="utf-8")
    fn_start = src.find("def _persist_discovered_workers")
    assert fn_start != -1
    fn_body = src[fn_start: fn_start + 6000]
    assert "is_stock_demo" in fn_body, "Must compute a stock/example demo flag"
    assert "PROTECTED_STOCK_WORKER_IDS" in fn_body, (
        "Stock demos must be keyed off the curated PROTECTED_STOCK_WORKER_IDS set"
    )
    assert 'is_example' in fn_body, "Must also treat is_example:true manifests as shared"
    assert "is_system_worker or is_stock_demo" in fn_body, (
        "Both system workers AND stock demos must map to workspace visibility"
    )
