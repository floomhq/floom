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
    from models import WorkerNotRunnableError

    with pytest.raises(WorkerNotRunnableError) as exc:
        repos.runs.create(
            user_id="fresh-member",
            run_id="run-private-1",
            worker_id="private-real-worker",
            input_json={},
            trigger_source="manual",
            runner="e2b",
        )
    # Subclasses ValueError (kept for back-compat) and still carries the
    # "does not belong" marker the run endpoint's fallback matches on.
    assert isinstance(exc.value, ValueError)
    assert "does not belong" in str(exc.value)


def test_catalog_stock_worker_runnable_by_fresh_tenant_even_when_private(repo_bundle):
    """Runnable-by-attribution carve-out: a curated PUBLIC_STOCK_WORKER_IDS
    catalog worker is runnable by any user even if its persisted row is
    seed-owned + visibility='private'. The run is attributed to the worker's
    owner (same as the workspace path) so the owner-scoped run JOIN resolves."""
    import main

    repos, _db, _manifest = repo_bundle
    stock_id = sorted(main.PUBLIC_STOCK_WORKER_IDS)[0]
    repos.workers.upsert(
        user_id="seed-owner",
        worker_id=stock_id,
        name="Stock Catalog Worker",
        manifest_json=_ws_manifest(stock_id, "Stock Catalog Worker"),
        bundle_path=f"workers/{stock_id}",
        visibility="private",
    )
    created = repos.runs.create(
        user_id="fresh-tenant",
        run_id="run-catalog-1",
        worker_id=stock_id,
        input_json={},
        trigger_source="manual",
        runner="e2b",
    )
    assert created is not None
    assert created["id"] == "run-catalog-1"
    # Attributed to the worker owner (the shared catalog row), like a workspace
    # worker — so owner-scoped run queries keep working.
    runs_owner, total_owner = repos.runs.list(user_id="seed-owner")
    assert total_owner == 1
    assert runs_owner[0]["id"] == "run-catalog-1"


def test_non_catalog_private_worker_still_blocks_cross_tenant(repo_bundle):
    """Isolation guard (U-02): a non-catalog private worker authored by another
    tenant is NOT runnable, even though the catalog carve-out exists."""
    from models import WorkerNotRunnableError

    repos, _db, _manifest = repo_bundle
    repos.workers.upsert(
        user_id="tenant-b",
        worker_id="tenant-b-private",
        name="Tenant B Private",
        manifest_json=_ws_manifest("tenant-b-private", "Tenant B Private"),
        bundle_path="workers/tenant-b-private",
        visibility="private",
    )
    with pytest.raises(WorkerNotRunnableError):
        repos.runs.create(
            user_id="tenant-a",
            run_id="run-xtenant-1",
            worker_id="tenant-b-private",
            input_json={},
            trigger_source="manual",
            runner="e2b",
        )


def test_persist_seeds_stock_demos_as_workspace_visibility():
    """Source guard: the worker-persist path must seed stock/example demos
    (PROTECTED_STOCK_WORKER_IDS or is_example:true) as visibility='workspace'.

    PR #1073 (oss-prep) moved the persist logic out of main.py into
    services/worker_registry_ops.py and split the per-worker visibility
    computation into the `_persist_one_worker` helper (the SAVEPOINT wrapper
    `_persist_discovered_workers` just loops over it). The visibility markers
    now live in `_persist_one_worker`, so inspect that function there."""
    src = (
        Path(__file__).parents[2] / "services" / "worker_registry_ops.py"
    ).read_text(encoding="utf-8")
    fn_start = src.find("def _persist_one_worker")
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
