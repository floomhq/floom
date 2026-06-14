from __future__ import annotations

import pytest

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import SupabaseRunRepository, _public_stock_worker_ids


class _RunsTable:
    def __init__(self) -> None:
        self.inserted: dict | None = None

    def insert(self, payload: dict):
        self.inserted = payload
        return self

    def eq(self, *_args):
        return self

    def execute(self):
        return type("Response", (), {"data": [self.inserted]})()


class _EmptyWorkersTable:
    """Simulates the workspace-scoped pre-check finding NO row (the catalog
    worker is seeded in another tenant's workspace)."""

    def select(self, *_args):
        return self

    def eq(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        return type("Response", (), {"data": []})()


class _Client:
    def __init__(self) -> None:
        self.runs = _RunsTable()
        self.workers = _EmptyWorkersTable()

    def table(self, name: str):
        if name == "workers":
            return self.workers
        assert name == "runs"
        return self.runs


def _catalog_id() -> str:
    ids = _public_stock_worker_ids()
    assert ids, "PUBLIC_STOCK_WORKER_IDS must resolve from engine main"
    return sorted(ids)[0]


def test_catalog_worker_runs_even_when_precheck_finds_no_row(monkeypatch):
    """A curated catalog/stock worker is runnable by a fresh tenant even though
    the workspace-scoped ownership pre-check finds no row in this workspace. The
    run is stamped with the CALLER's workspace (isolation preserved)."""
    client = _Client()
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]
    monkeypatch.setattr(repo, "get", lambda *, user_id, run_id: {"id": run_id, "user_id": user_id})

    with active_workspace("ws_caller"):
        created = repo.create(
            user_id="fresh_tenant",
            run_id="run_catalog",
            worker_id=_catalog_id(),
            input_json={},
            runner="e2b",
        )

    assert created == {"id": "run_catalog", "user_id": "fresh_tenant"}
    assert client.runs.inserted is not None
    # Stamped with the CALLER's workspace + user, NOT the seed owner's.
    assert client.runs.inserted["workspace_id"] == "ws_caller"
    assert client.runs.inserted["user_id"] == "fresh_tenant"


def test_non_catalog_private_worker_blocks_cross_tenant():
    """Isolation guard (U-02): a non-catalog worker not visible in the caller's
    workspace is rejected (no run inserted)."""
    client = _Client()
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]

    with active_workspace("ws_caller"):
        with pytest.raises(ValueError) as exc:
            repo.create(
                user_id="tenant_a",
                run_id="run_xtenant",
                worker_id="tenant-b-private-worker",
                input_json={},
                runner="e2b",
            )

    assert "does not belong" in str(exc.value)
    assert client.runs.inserted is None
