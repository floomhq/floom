from __future__ import annotations

from copy import deepcopy
from typing import Any

from apps.api.auth.workspace_context import active_workspace
from apps.api.db import supabase_repos
from apps.api.db.supabase_repos import SupabaseVersionRepository


class _Response:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Not:
    def __init__(self, query: "_Query") -> None:
        self._query = query

    def in_(self, key: str, values: list[str]) -> "_Query":
        self._query.not_in_filters.append((key, set(values)))
        return self._query


class _Query:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.filters: list[tuple[str, Any]] = []
        self.in_filters: list[tuple[str, set[Any]]] = []
        self.not_in_filters: list[tuple[str, set[Any]]] = []
        self.limit_value: int | None = None
        self.order_key: str | None = None
        self.order_desc = False
        self.insert_payload: dict[str, Any] | None = None
        self.delete_mode = False
        self.not_ = _Not(self)

    def select(self, *_args: Any, **_kwargs: Any) -> "_Query":
        return self

    def insert(self, payload: dict[str, Any]) -> "_Query":
        self.insert_payload = payload
        return self

    def delete(self) -> "_Query":
        self.delete_mode = True
        return self

    def eq(self, key: str, value: Any) -> "_Query":
        self.filters.append((key, value))
        return self

    def in_(self, key: str, values: list[str]) -> "_Query":
        self.in_filters.append((key, set(values)))
        return self

    def order(self, key: str, *, desc: bool = False) -> "_Query":
        self.order_key = key
        self.order_desc = desc
        return self

    def limit(self, value: int) -> "_Query":
        self.limit_value = value
        return self

    def _matched(self) -> list[dict[str, Any]]:
        rows = self.rows
        for key, value in self.filters:
            rows = [row for row in rows if row.get(key) == value]
        for key, values in self.in_filters:
            rows = [row for row in rows if row.get(key) in values]
        for key, values in self.not_in_filters:
            rows = [row for row in rows if row.get(key) not in values]
        if self.order_key is not None:
            rows = sorted(rows, key=lambda row: row.get(self.order_key), reverse=self.order_desc)
        if self.limit_value is not None:
            rows = rows[: self.limit_value]
        return rows

    def execute(self) -> _Response:
        if self.insert_payload is not None:
            row = deepcopy(self.insert_payload)
            self.rows.append(row)
            return _Response([row])
        rows = self._matched()
        if self.delete_mode:
            ids = {id(row) for row in rows}
            self.rows[:] = [row for row in self.rows if id(row) not in ids]
        return _Response(rows)


class _Client:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def table(self, name: str) -> _Query:
        assert name == "asset_versions"
        return _Query(self.rows)


def _repo(monkeypatch, rows: list[dict[str, Any]]) -> SupabaseVersionRepository:
    client = _Client(rows)
    monkeypatch.setattr(supabase_repos, "get_supabase_service_client", lambda: client)
    return SupabaseVersionRepository()


def test_asset_version_list_and_get_are_workspace_scoped(monkeypatch):
    rows = [
        {"id": "ver_a", "workspace_id": "ws_a", "asset_type": "worker", "asset_id": "same", "version_number": 1},
        {"id": "ver_b", "workspace_id": "ws_b", "asset_type": "worker", "asset_id": "same", "version_number": 2},
    ]
    repo = _repo(monkeypatch, rows)

    with active_workspace("ws_a", "admin"):
        listed = repo.list(asset_type="worker", asset_id="same")
        assert [row["id"] for row in listed] == ["ver_a"]
        assert repo.get(version_id="ver_a")["id"] == "ver_a"
        assert repo.get(version_id="ver_b") is None


def test_asset_version_create_stamps_workspace_and_versions_within_workspace(monkeypatch):
    rows = [
        {"id": "old_a", "workspace_id": "ws_a", "asset_type": "worker", "asset_id": "same", "version_number": 3},
        {"id": "old_b", "workspace_id": "ws_b", "asset_type": "worker", "asset_id": "same", "version_number": 99},
    ]
    repo = _repo(monkeypatch, rows)

    with active_workspace("ws_a", "admin"):
        created = repo.create(
            asset_type="worker",
            asset_id="same",
            user_id="user_a",
            snapshot_json="{}",
            change_source="user",
        )

    assert created["workspace_id"] == "ws_a"
    assert created["version_number"] == 4


def test_asset_version_delete_for_context_only_deletes_active_workspace(monkeypatch):
    rows = [
        {"id": "pack_a", "workspace_id": "ws_a", "asset_type": "brain_pack", "asset_id": "ctx"},
        {"id": "file_a", "workspace_id": "ws_a", "asset_type": "brain_file", "asset_id": "ctx:file.txt"},
        {"id": "pack_b", "workspace_id": "ws_b", "asset_type": "brain_pack", "asset_id": "ctx"},
        {"id": "file_b", "workspace_id": "ws_b", "asset_type": "brain_file", "asset_id": "ctx:file.txt"},
    ]
    repo = _repo(monkeypatch, rows)

    with active_workspace("ws_a", "admin"):
        deleted = repo.delete_for_context(name="ctx")

    assert deleted == 2
    assert {row["id"] for row in rows} == {"pack_b", "file_b"}


def test_asset_version_delete_for_asset_only_deletes_active_workspace(monkeypatch):
    rows = [
        {"id": "ver_a", "workspace_id": "ws_a", "asset_type": "worker", "asset_id": "same"},
        {"id": "ver_b", "workspace_id": "ws_b", "asset_type": "worker", "asset_id": "same"},
    ]
    repo = _repo(monkeypatch, rows)

    with active_workspace("ws_a", "admin"):
        assert repo.delete_for_asset(asset_type="worker", asset_id="same") == 1

    assert rows == [{"id": "ver_b", "workspace_id": "ws_b", "asset_type": "worker", "asset_id": "same"}]
