from __future__ import annotations

import inspect
from typing import Any

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import SupabaseRunRepository


class _Resp:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Table:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self._eq: list[tuple[str, Any]] = []
        self._in: list[tuple[str, set[Any]]] = []
        self._gte: list[tuple[str, Any]] = []
        self._lte: list[tuple[str, Any]] = []
        self._order: tuple[str, bool] | None = None
        self._range: tuple[int, int] | None = None

    def select(self, *_args: Any, **_kwargs: Any) -> "_Table":
        return self

    def eq(self, key: str, value: Any) -> "_Table":
        self._eq.append((key, value))
        return self

    def in_(self, key: str, values: list[Any] | tuple[Any, ...]) -> "_Table":
        self._in.append((key, set(values)))
        return self

    def gte(self, key: str, value: Any) -> "_Table":
        self._gte.append((key, value))
        return self

    def lte(self, key: str, value: Any) -> "_Table":
        self._lte.append((key, value))
        return self

    def order(self, key: str, *, desc: bool = False) -> "_Table":
        self._order = (key, desc)
        return self

    def range(self, start: int, end: int) -> "_Table":
        self._range = (start, end)
        return self

    def execute(self) -> _Resp:
        rows = [dict(row) for row in self._rows]
        for key, value in self._eq:
            rows = [row for row in rows if row.get(key) == value]
        for key, values in self._in:
            rows = [row for row in rows if row.get(key) in values]
        for key, value in self._gte:
            rows = [row for row in rows if str(row.get(key) or "") >= str(value)]
        for key, value in self._lte:
            rows = [row for row in rows if str(row.get(key) or "") <= str(value)]
        if self._order is not None:
            key, desc = self._order
            rows = sorted(rows, key=lambda row: str(row.get(key) or ""), reverse=desc)
        if self._range is not None:
            start, end = self._range
            rows = rows[start : end + 1]
        return _Resp(rows)


class _Client:
    def __init__(self, rows_by_table: dict[str, list[dict[str, Any]]]) -> None:
        self._rows_by_table = rows_by_table

    def table(self, name: str) -> _Table:
        return _Table(self._rows_by_table.get(name, []))


def _repo() -> SupabaseRunRepository:
    return SupabaseRunRepository(
        client=_Client(
            {
                "runs": [
                    {
                        "id": "run_w1_done_today",
                        "user_id": "user_1",
                        "workspace_id": "ws_1",
                        "worker_id": "w1",
                        "status": "completed",
                        "trigger_source": "manual",
                        "created_at": "2026-06-15T09:00:00+00:00",
                        "started_at": "2026-06-15T09:00:00+00:00",
                        "completed_at": "2026-06-15T09:01:00+00:00",
                        "duration_ms": 60000,
                    },
                    {
                        "id": "run_w2_queued_today",
                        "user_id": "user_1",
                        "workspace_id": "ws_1",
                        "worker_id": "w2",
                        "status": "queued",
                        "trigger_source": "schedule",
                        "created_at": "2026-06-15T08:00:00+00:00",
                    },
                    {
                        "id": "run_w1_failed_24h",
                        "user_id": "user_1",
                        "workspace_id": "ws_1",
                        "worker_id": "w1",
                        "status": "failed",
                        "trigger_source": "schedule",
                        "created_at": "2026-06-14T20:00:00+00:00",
                        "started_at": "2026-06-14T20:00:00+00:00",
                        "completed_at": "2026-06-14T20:02:00+00:00",
                        "duration_ms": 120000,
                        "error_code": "boom",
                    },
                    {
                        "id": "run_w3_running_today",
                        "user_id": "user_1",
                        "workspace_id": "ws_1",
                        "worker_id": "w3",
                        "status": "running",
                        "trigger_source": "manual",
                        "created_at": "2026-06-15T10:00:00+00:00",
                    },
                    {
                        "id": "run_w2_done_previous",
                        "user_id": "user_1",
                        "workspace_id": "ws_1",
                        "worker_id": "w2",
                        "status": "completed",
                        "trigger_source": "manual",
                        "created_at": "2026-06-05T12:00:00+00:00",
                    },
                    {
                        "id": "run_other_workspace",
                        "user_id": "user_1",
                        "workspace_id": "ws_2",
                        "worker_id": "w1",
                        "status": "completed",
                        "trigger_source": "manual",
                        "created_at": "2026-06-15T11:00:00+00:00",
                    },
                ],
                "workers": [
                    {
                        "id": "w1",
                        "workspace_id": "ws_1",
                        "user_id": "user_1",
                        "name": "Worker One",
                        "skill_version_id": None,
                    },
                    {
                        "id": "w2",
                        "workspace_id": "ws_1",
                        "user_id": "user_1",
                        "name": "Worker Two",
                        "skill_version_id": None,
                    },
                    {
                        "id": "w3",
                        "workspace_id": "ws_1",
                        "user_id": "user_1",
                        "name": "Worker Three",
                        "skill_version_id": None,
                    },
                ],
                "skill_versions": [],
            }
        )
    )


def test_supabase_run_repository_implements_overview_protocol_methods() -> None:
    for name in (
        "overview_status_rollup",
        "overview_sparkline_buckets",
        "overview_current_counts",
        "overview_top_completed_by_worker",
        "overview_recent_visible_runs",
        "overview_latest_failures_by_worker",
        "overview_terminal_runs",
    ):
        assert callable(getattr(SupabaseRunRepository, name, None)), name
        assert inspect.signature(getattr(SupabaseRunRepository, name))


def test_supabase_overview_queries_match_engine_shapes_and_workspace_scope(monkeypatch) -> None:
    monkeypatch.setattr(SupabaseRunRepository, "_OVERVIEW_PAGE_SIZE", 2)
    repo = _repo()

    with active_workspace("ws_1"):
        rollup = repo.overview_status_rollup(
            user_id="user_1",
            since="2026-06-01T00:00:00+00:00",
            window_7d="2026-06-08T00:00:00+00:00",
            today_start="2026-06-15T00:00:00+00:00",
        )
        current = repo.overview_current_counts(
            user_id="user_1",
            statuses=["queued", "running"],
        )
        top = repo.overview_top_completed_by_worker(
            user_id="user_1",
            since="2026-06-01T00:00:00+00:00",
            limit=2,
        )
        recent = repo.overview_recent_visible_runs(
            user_id="user_1",
            worker_ids=["w1", "w2"],
            limit=2,
        )
        failures = repo.overview_latest_failures_by_worker(
            user_id="user_1",
            worker_ids=["w1", "w2"],
            since="2026-06-14T00:00:00+00:00",
            limit=3,
        )
        terminal = repo.overview_terminal_runs(
            user_id="user_1",
            worker_ids=["w1", "w2"],
            since="2026-06-01T00:00:00+00:00",
        )
        sparkline = repo.overview_sparkline_buckets(
            user_id="user_1",
            since="2026-06-15T00:00:00+00:00",
            until="2026-06-15T12:00:00+00:00",
            bucket_seconds=3600,
        )

    by_worker_status = {
        (row["worker_id"], row["status"]): row
        for row in rollup
    }
    assert by_worker_status[("w1", "completed")]["count_7d"] == 1
    assert by_worker_status[("w1", "completed")]["count_today"] == 1
    assert by_worker_status[("w2", "completed")]["count_previous_7d"] == 1

    assert current == {"queued": 1, "running": 1}
    assert top == [{"worker_id": "w1", "count": 1}, {"worker_id": "w2", "count": 1}]
    assert [row["id"] for row in recent] == ["run_w1_done_today", "run_w2_queued_today"]
    assert recent[0]["worker_name"] == "Worker One"
    assert failures[0]["worker_id"] == "w1"
    assert failures[0]["failure_count"] == 1
    assert {row["id"] for row in terminal} == {
        "run_w1_done_today",
        "run_w1_failed_24h",
        "run_w2_done_previous",
    }
    assert {(row["bucket"], row["status"], row["total"]) for row in sparkline} == {
        (8, "queued", 1),
        (9, "completed", 1),
        (10, "running", 1),
    }
