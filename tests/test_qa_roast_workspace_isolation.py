from __future__ import annotations

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import (
    SupabaseApprovalRepository,
    SupabaseRunRepository,
    SupabaseWorkerRepository,
)


class _Resp:
    def __init__(self, data):
        self.data = data
        self.count = len(data)


class _Table:
    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.filters: list[tuple[str, object]] = []
        self.in_filters: list[tuple[str, set[object]]] = []
        self.or_filters: list[str] = []
        self.update_values: dict | None = None
        self.limit_value: int | None = None

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def in_(self, key, values):
        self.in_filters.append((key, set(values)))
        return self

    def or_(self, value):
        self.or_filters.append(value)
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def update(self, values):
        self.update_values = dict(values)
        return self

    def execute(self):
        rows = list(self.rows)
        for key, value in self.filters:
            rows = [row for row in rows if row.get(key) == value]
        for key, values in self.in_filters:
            rows = [row for row in rows if row.get(key) in values]
        for value in self.or_filters:
            clauses = [clause.split(".", 2) for clause in value.split(",")]
            rows = [
                row
                for row in rows
                if any(len(clause) == 3 and row.get(clause[0]) == clause[2] for clause in clauses)
            ]
        if self.limit_value is not None:
            rows = rows[: self.limit_value]
        if self.update_values is not None:
            for row in rows:
                row.update(self.update_values)
        return _Resp([dict(row) for row in rows])


class _Client:
    def __init__(self, rows_by_table: dict[str, list[dict]]):
        self.rows_by_table = rows_by_table
        self.last_table: _Table | None = None

    def table(self, name: str):
        self.last_table = _Table(self.rows_by_table.setdefault(name, []))
        return self.last_table


def _worker_rows():
    return {
        "workers": [
            {
                "id": "worker_same_id",
                "user_id": "user_1",
                "owner_id": "user_1",
                "workspace_id": "ws_a",
                "skill_version_id": "sv_a",
                "name": "Worker A",
                "trigger_type": "manual",
                "enabled": True,
                "visibility": "private",
            },
            {
                "id": "worker_other",
                "user_id": "user_1",
                "owner_id": "user_1",
                "workspace_id": "ws_b",
                "skill_version_id": "sv_b",
                "name": "Worker B",
                "trigger_type": "manual",
                "enabled": True,
                "visibility": "private",
            },
        ],
        "skill_versions": [
            {
                "id": "sv_a",
                "workspace_id": "ws_a",
                "manifest_json": {"name": "worker-a", "title": "Worker A"},
            },
            {
                "id": "sv_b",
                "workspace_id": "ws_b",
                "manifest_json": {"name": "worker-b", "title": "Worker B"},
            },
        ],
    }


def _run_rows():
    return {
        "runs": [
            {
                "id": "run_a",
                "user_id": "user_1",
                "workspace_id": "ws_a",
                "worker_id": "worker_same_id",
                "status": "running",
                "trigger_source": "manual",
                "runner": "e2b",
                "input_json": {},
                "output_json": {},
                "created_at": "2026-06-24T00:00:00+00:00",
            },
            {
                "id": "run_b",
                "user_id": "user_1",
                "workspace_id": "ws_b",
                "worker_id": "worker_other",
                "status": "running",
                "trigger_source": "manual",
                "runner": "e2b",
                "input_json": {},
                "output_json": {},
                "created_at": "2026-06-24T00:00:00+00:00",
            },
        ],
        "run_logs": [
            {"run_id": "run_a", "user_id": "user_1", "level": "info", "message": "a", "timestamp": "1"},
            {"run_id": "run_b", "user_id": "user_1", "level": "info", "message": "b", "timestamp": "2"},
        ],
    }


def test_approvals_list_and_get_are_workspace_scoped():
    rows = {
        "approvals": [
            {"id": "apr_a", "owner_id": "user_1", "workspace_id": "ws_a", "status": "pending"},
            {"id": "apr_b", "owner_id": "user_1", "workspace_id": "ws_b", "status": "pending"},
        ]
    }
    repo = SupabaseApprovalRepository(client=_Client(rows))

    with active_workspace("ws_a"):
        assert [row["id"] for row in repo.list_pending(owner_id="user_1")] == ["apr_a"]
        assert repo.get(owner_id="user_1", approval_id="apr_b") is None


def test_approvals_count_pending_is_workspace_scoped():
    rows = {
        "approvals": [
            {"id": "apr_a", "owner_id": "user_1", "workspace_id": "ws_a", "status": "pending"},
            {"id": "apr_b", "owner_id": "user_1", "workspace_id": "ws_b", "status": "pending"},
            {"id": "apr_done", "owner_id": "user_1", "workspace_id": "ws_a", "status": "approved"},
            {"id": "apr_other_owner", "owner_id": "user_2", "workspace_id": "ws_a", "status": "pending"},
        ]
    }
    repo = SupabaseApprovalRepository(client=_Client(rows))

    with active_workspace("ws_a"):
        assert repo.count_pending(owner_id="user_1") == 1


def test_worker_get_by_id_hides_same_owner_other_workspace():
    repo = SupabaseWorkerRepository(client=_Client(_worker_rows()))

    with active_workspace("ws_a", "admin"):
        assert repo.get(user_id="user_1", worker_id="worker_same_id")["id"] == "worker_same_id"
        assert repo.get(user_id="user_1", worker_id="worker_other") is None


def test_run_get_cancel_and_logs_hide_same_owner_other_workspace():
    rows = _run_rows()
    repo = SupabaseRunRepository(client=_Client(rows))

    with active_workspace("ws_a", "admin"):
        assert repo.get(user_id="user_1", run_id="run_a")["id"] == "run_a"
        assert repo.get(user_id="user_1", run_id="run_b") is None
        assert repo.cancel(user_id="user_1", run_id="run_b", cancelled_at="now") is None
        assert rows["runs"][1].get("cancel_requested") is None
        assert repo.list_logs(user_id="user_1", run_id="run_b") == []
        assert [row["message"] for row in repo.list_logs(user_id="user_1", run_id="run_a")] == ["a"]


def test_worker_logs_for_worker_are_workspace_scoped_through_run_lookup():
    rows = _run_rows()
    repo = SupabaseRunRepository(client=_Client(rows))

    with active_workspace("ws_a", "admin"):
        assert repo.list_logs_for_worker(user_id="user_1", worker_id="worker_other") == []
        assert [row["message"] for row in repo.list_logs_for_worker(user_id="user_1", worker_id="worker_same_id")] == ["a"]
