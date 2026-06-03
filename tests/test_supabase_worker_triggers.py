"""Unit tests for the Cloud SupabaseWorkerRepository trigger methods.

These mirror the engine's normalized worker_triggers behaviour (engine
apps/api/db/sqlite.py) that the scheduler + webhook path call unguarded.
A lightweight in-memory fake stands in for the Supabase PostgREST client so
the tests run without a live database.
"""

from __future__ import annotations

from typing import Any

import pytest

import apps.api.db.supabase_repos as repos_module
from apps.api.db.supabase_repos import SupabaseWorkerRepository


class _FakeResponse:
    def __init__(self, data: list[dict[str, Any]], count: int | None = None) -> None:
        self.data = data
        self.count = count


class _FakeTable:
    def __init__(self, store: dict[str, list[dict[str, Any]]], name: str) -> None:
        self._store = store
        self._name = name
        self._op = "select"
        self._eq: list[tuple[str, Any]] = []
        self._in: list[tuple[str, list[Any]]] = []
        self._payload: Any = None
        self._on_conflict: str | None = None
        self._limit: int | None = None
        self._count_mode: str | None = None

    # -- builder ----------------------------------------------------------
    def select(self, _cols: str = "*", count: str | None = None) -> "_FakeTable":
        self._op = "select"
        self._count_mode = count
        return self

    def insert(self, payload: dict[str, Any]) -> "_FakeTable":
        self._op = "insert"
        self._payload = payload
        return self

    def upsert(self, payload: dict[str, Any], on_conflict: str | None = None) -> "_FakeTable":
        self._op = "upsert"
        self._payload = payload
        self._on_conflict = on_conflict
        return self

    def update(self, payload: dict[str, Any]) -> "_FakeTable":
        self._op = "update"
        self._payload = payload
        return self

    def delete(self) -> "_FakeTable":
        self._op = "delete"
        return self

    def eq(self, key: str, value: Any) -> "_FakeTable":
        self._eq.append((key, value))
        return self

    def in_(self, key: str, values: list[Any]) -> "_FakeTable":
        self._in.append((key, list(values)))
        return self

    def order(self, _key: str, desc: bool = False) -> "_FakeTable":
        return self

    def limit(self, value: int) -> "_FakeTable":
        self._limit = value
        return self

    # -- exec -------------------------------------------------------------
    def _matches(self, row: dict[str, Any]) -> bool:
        for key, value in self._eq:
            if row.get(key) != value:
                return False
        for key, values in self._in:
            if row.get(key) not in values:
                return False
        return True

    def execute(self) -> _FakeResponse:
        rows = self._store.setdefault(self._name, [])
        if self._op == "insert":
            rows.append(dict(self._payload))
            return _FakeResponse([dict(self._payload)])
        if self._op == "upsert":
            key = self._on_conflict or "id"
            ident = self._payload.get(key)
            for existing in rows:
                if existing.get(key) == ident:
                    existing.update(self._payload)
                    return _FakeResponse([dict(existing)])
            rows.append(dict(self._payload))
            return _FakeResponse([dict(self._payload)])

        matched = [row for row in rows if self._matches(row)]
        if self._op == "select":
            out = [dict(r) for r in matched]
            if self._limit is not None:
                out = out[: self._limit]
            count = len(matched) if self._count_mode == "exact" else None
            return _FakeResponse(out, count=count)
        if self._op == "update":
            for row in matched:
                row.update(self._payload)
            return _FakeResponse([dict(r) for r in matched])
        if self._op == "delete":
            self._store[self._name] = [row for row in rows if not self._matches(row)]
            return _FakeResponse([dict(r) for r in matched])
        raise AssertionError(f"unsupported op {self._op}")


class _FakeClient:
    def __init__(self, store: dict[str, list[dict[str, Any]]]) -> None:
        self._store = store

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(self._store, name)


@pytest.fixture
def repo(monkeypatch):
    store: dict[str, list[dict[str, Any]]] = {
        "worker_triggers": [],
        "workers": [
            {"id": "w1", "user_id": "owner-1", "enabled": True},
            {"id": "w2", "user_id": "owner-2", "enabled": False},
        ],
    }
    # workspace_id stamping is resolved via the workspaces module helper.
    monkeypatch.setattr(
        repos_module.workspace_repo,
        "workspace_id_for_worker",
        lambda *, worker_id: f"ws_for_{worker_id}",
    )
    client = _FakeClient(store)
    r = SupabaseWorkerRepository(client=client)
    return r, store


def test_reconcile_creates_normalized_rows(repo):
    r, store = repo
    rows = r.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "cron", "cron": "0 9 * * *"},
            {"type": "webhook"},
        ],
    )
    assert [row["id"] for row in rows] == ["trg_w1_0", "trg_w1_1"]
    # cron normalizes to schedule; webhook stamps webhook_path = worker_id.
    by_id = {row["id"]: row for row in rows}
    assert by_id["trg_w1_0"]["type"] == "schedule"
    assert by_id["trg_w1_1"]["type"] == "webhook"
    assert by_id["trg_w1_1"]["webhook_path"] == "w1"
    assert by_id["trg_w1_0"]["workspace_id"] == "ws_for_w1"


def test_reconcile_preserves_next_run_at_when_schedule_unchanged(repo):
    r, store = repo
    r.reconcile_triggers(worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    r.set_trigger_next_run_at(trigger_id="trg_w1_0", next_run_at="2026-06-04T09:00:00+00:00")
    # Re-reconcile with the SAME schedule config -> next_run_at preserved.
    rows = r.reconcile_triggers(worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    assert rows[0]["next_run_at"] == "2026-06-04T09:00:00+00:00"


def test_reconcile_deletes_removed_triggers(repo):
    r, store = repo
    r.reconcile_triggers(
        worker_id="w1",
        triggers=[{"type": "schedule", "cron": "0 9 * * *"}, {"type": "webhook"}],
    )
    # Drop the webhook trigger.
    rows = r.reconcile_triggers(worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    assert [row["id"] for row in rows] == ["trg_w1_0"]
    assert r.find_trigger_for_webhook(worker_id="w1") is None


def test_reconcile_empty_clears_all_rows(repo):
    r, store = repo
    r.reconcile_triggers(worker_id="w1", triggers=[{"type": "webhook"}])
    r.reconcile_triggers(worker_id="w1", triggers=[])
    assert r.list_trigger_rows(worker_id="w1") == []


def test_find_trigger_for_webhook(repo):
    r, store = repo
    r.reconcile_triggers(worker_id="w1", triggers=[{"type": "webhook"}])
    row = r.find_trigger_for_webhook(worker_id="w1")
    assert row is not None and row["type"] == "webhook" and row["worker_id"] == "w1"


def test_find_trigger_by_external_id(repo):
    r, store = repo
    r.reconcile_triggers(
        worker_id="w1",
        triggers=[{"type": "composio"}],
        external_trigger_id="ext-123",
    )
    row = r.find_trigger_by_external_id(external_trigger_id="ext-123")
    assert row is not None and row["type"] == "composio_event"


def test_list_due_schedule_triggers_filters_disabled_worker_and_adds_owner(repo):
    r, store = repo
    # w1 is enabled (owner-1), w2 is disabled (owner-2).
    r.reconcile_triggers(worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    r.reconcile_triggers(worker_id="w2", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    due = r.list_due_schedule_triggers(now_iso="2026-06-03T00:00:00+00:00")
    # Only w1's row is due (w2 is a disabled worker); owner_id surfaced.
    assert [row["worker_id"] for row in due] == ["w1"]
    assert due[0]["owner_id"] == "owner-1"
    assert due[0]["workspace_id"] == "ws_for_w1"


def test_count_schedule_trigger_rows_is_global(repo):
    r, store = repo
    r.reconcile_triggers(worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    r.reconcile_triggers(worker_id="w2", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    # Counts across ALL tenants (both schedule rows), regardless of worker state.
    assert r.count_schedule_trigger_rows() == 2


def test_mark_trigger_fired_updates_row(repo):
    r, store = repo
    r.reconcile_triggers(worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}])
    r.mark_trigger_fired(
        trigger_id="trg_w1_0",
        last_fired_at="2026-06-03T09:00:00+00:00",
        next_run_at="2026-06-04T09:00:00+00:00",
    )
    row = r.list_trigger_rows(worker_id="w1")[0]
    assert row["last_fired_at"] == "2026-06-03T09:00:00+00:00"
    assert row["next_run_at"] == "2026-06-04T09:00:00+00:00"
