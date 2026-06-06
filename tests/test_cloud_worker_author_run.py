from __future__ import annotations

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import SupabaseRunRepository


class _RunsTable:
    def __init__(self) -> None:
        self.inserted: dict | None = None
        self.updated: dict | None = None
        self.filters: list[tuple[str, str]] = []

    def insert(self, payload: dict):
        self.inserted = payload
        return self

    def update(self, payload: dict):
        self.updated = payload
        return self

    def eq(self, key: str, value: str):
        self.filters.append((key, value))
        return self

    def execute(self):
        return type("Response", (), {"data": [self.inserted or self.updated]})()


class _WorkersTable:
    def __init__(self) -> None:
        self.filters: list[tuple[str, str]] = []

    def select(self, *_args):
        return self

    def eq(self, key: str, value: str):
        self.filters.append((key, value))
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        return type("Response", (), {"data": [{"id": "worker-author"}]})()


class _Client:
    def __init__(self) -> None:
        self.runs = _RunsTable()
        self.workers = _WorkersTable()

    def table(self, name: str):
        if name == "workers":
            return self.workers
        assert name == "runs"
        return self.runs


def test_worker_author_run_bypasses_tenant_worker_precheck(monkeypatch):
    client = _Client()
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]
    monkeypatch.setattr(repo, "get", lambda *, user_id, run_id: {"id": run_id, "user_id": user_id})

    with active_workspace("ws_test"):
        created = repo.create(
            user_id="user_1",
            run_id="run_worker_author",
            worker_id="worker-author",
            input_json={"prompt": "smoke"},
            runner="skill",
        )

    assert created == {"id": "run_worker_author", "user_id": "user_1"}
    assert client.runs.inserted is not None
    assert client.runs.inserted["workspace_id"] == "ws_test"
    assert client.runs.inserted["worker_id"] == "worker-author"
    assert client.runs.inserted["user_id"] == "user_1"
    assert client.workers.filters == [("id", "worker-author")]


def test_update_status_does_not_decorate_after_write(monkeypatch):
    client = _Client()
    repo = SupabaseRunRepository(client=client)  # type: ignore[arg-type]
    monkeypatch.setattr(
        repo,
        "get",
        lambda *, user_id, run_id: {"id": run_id, "user_id": user_id, "started_at": None},
    )
    monkeypatch.setattr(
        repo,
        "update",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("update() must not be called")),
    )

    with active_workspace("ws_test"):
        repo.update_status(
            user_id="user_1",
            run_id="run_completed",
            status="completed",
            output_json={"ok": True},
        )

    assert client.runs.updated is not None
    assert client.runs.updated["status"] == "completed"
    assert client.runs.updated["output_json"] == {"ok": True}
    assert ("id", "run_completed") in client.runs.filters
