from __future__ import annotations

from typing import Any

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import SupabaseWorkerRepository


class _Response:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Query:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.filters: list[tuple[str, Any]] = []
        self.in_filters: list[tuple[str, set[Any]]] = []
        self.delete_mode = False
        self.limit_value: int | None = None

    def select(self, *_args: Any, **_kwargs: Any) -> "_Query":
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

    def limit(self, value: int) -> "_Query":
        self.limit_value = value
        return self

    def execute(self) -> _Response:
        rows = self.rows
        for key, value in self.filters:
            rows = [row for row in rows if row.get(key) == value]
        for key, values in self.in_filters:
            rows = [row for row in rows if row.get(key) in values]
        if self.limit_value is not None:
            rows = rows[: self.limit_value]
        if self.delete_mode:
            ids = {id(row) for row in rows}
            self.rows[:] = [row for row in self.rows if id(row) not in ids]
        return _Response(rows)


class _Client:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def table(self, name: str) -> _Query:
        assert name == "skill_versions"
        return _Query(self.rows)


def test_skill_version_lookup_is_workspace_scoped():
    rows = [
        {"id": "sv_same", "workspace_id": "ws_a", "manifest_json": {"name": "a"}},
        {"id": "sv_same_other", "workspace_id": "ws_b", "manifest_json": {"name": "b"}},
    ]
    repo = SupabaseWorkerRepository(client=_Client(rows))  # type: ignore[arg-type]

    with active_workspace("ws_a", "admin"):
        result = repo._skill_versions_by_id(["sv_same", "sv_same_other"])

    assert set(result) == {"sv_same"}


def test_skill_version_delete_is_workspace_scoped():
    rows = [
        {"id": "sv_same", "workspace_id": "ws_a"},
        {"id": "sv_same", "workspace_id": "ws_b"},
    ]
    repo = SupabaseWorkerRepository(client=_Client(rows))  # type: ignore[arg-type]

    with active_workspace("ws_a", "admin"):
        repo.delete_skill_version(skill_version_id="sv_same")

    assert rows == [{"id": "sv_same", "workspace_id": "ws_b"}]


def test_skill_version_write_guard_rejects_cross_workspace_collision():
    rows = [{"id": "sv_same", "workspace_id": "ws_b", "user_id": "user_b"}]
    repo = SupabaseWorkerRepository(client=_Client(rows))  # type: ignore[arg-type]

    with active_workspace("ws_a", "admin"):
        try:
            repo._assert_skill_version_write_allowed(
                skill_version_id="sv_same",
                workspace_id="ws_a",
                user_id="user_a",
            )
        except RuntimeError as exc:
            assert "different workspace" in str(exc)
        else:
            raise AssertionError("cross-workspace skill_version collision must be rejected")
