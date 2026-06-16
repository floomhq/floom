from __future__ import annotations

from typing import Any

from apps.api.db.supabase_repos import SupabaseRunRepository


class _Resp:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _RunsTable:
    def __init__(self, store: dict[str, dict[str, Any]]) -> None:
        self._store = store
        self._payload: dict[str, Any] | None = None
        self._eq: dict[str, Any] = {}

    def update(self, payload: dict[str, Any]) -> "_RunsTable":
        self._payload = payload
        return self

    def eq(self, key: str, value: Any) -> "_RunsTable":
        self._eq[key] = value
        return self

    def execute(self) -> _Resp:
        assert self._payload is not None
        run_id = self._eq.get("id")
        row = self._store.get(str(run_id))
        if row is None:
            return _Resp([])
        for key, value in self._eq.items():
            if row.get(key) != value:
                return _Resp([])
        row.update(self._payload)
        return _Resp([dict(row)])


class _Client:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._store = {str(row["id"]): dict(row) for row in rows}

    def table(self, name: str) -> _RunsTable:
        assert name == "runs"
        return _RunsTable(self._store)


def test_claim_queued_atomically_moves_queued_run_to_running() -> None:
    client = _Client([
        {
            "id": "run_1",
            "user_id": "user_1",
            "worker_id": "worker_1",
            "status": "queued",
            "cancel_requested": False,
            "started_at": None,
            "error": "previous error",
            "error_code": "previous_code",
        }
    ])
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]

    claimed = repo.claim_queued(
        user_id="user_1",
        run_id="run_1",
        started_at="2026-06-16T00:00:00+00:00",
    )

    assert claimed is not None
    assert claimed["id"] == "run_1"
    assert claimed["status"] == "running"
    assert claimed["started_at"] == "2026-06-16T00:00:00+00:00"
    assert claimed["error"] is None
    assert claimed["error_code"] is None
    assert client._store["run_1"]["status"] == "running"


def test_claim_queued_loses_compare_and_set_after_first_claim() -> None:
    client = _Client([
        {
            "id": "run_1",
            "user_id": "user_1",
            "worker_id": "worker_1",
            "status": "queued",
            "cancel_requested": False,
        }
    ])
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]

    first = repo.claim_queued(user_id="user_1", run_id="run_1", started_at="t1")
    second = repo.claim_queued(user_id="user_1", run_id="run_1", started_at="t2")

    assert first is not None
    assert second is None
    assert client._store["run_1"]["started_at"] == "t1"


def test_claim_queued_rejects_cancelled_or_foreign_runs() -> None:
    client = _Client([
        {
            "id": "cancelled",
            "user_id": "user_1",
            "worker_id": "worker_1",
            "status": "queued",
            "cancel_requested": True,
        },
        {
            "id": "foreign",
            "user_id": "user_2",
            "worker_id": "worker_2",
            "status": "queued",
            "cancel_requested": False,
        },
    ])
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]

    cancelled = repo.claim_queued(user_id="user_1", run_id="cancelled", started_at="t1")
    foreign = repo.claim_queued(user_id="user_1", run_id="foreign", started_at="t1")

    assert cancelled is None
    assert foreign is None
    assert client._store["cancelled"]["status"] == "queued"
    assert client._store["foreign"]["status"] == "queued"
