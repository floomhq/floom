from __future__ import annotations

from typing import Any

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import SupabaseWorkerRepository


class _Response:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Query:
    def __init__(self, rows: list[dict[str, Any]], *, missing_workspace_column: bool = False) -> None:
        self.rows = rows
        self.missing_workspace_column = missing_workspace_column
        self.selected = ""
        self.filters: list[tuple[str, Any]] = []
        self.in_filters: list[tuple[str, set[Any]]] = []
        self.delete_mode = False
        self.limit_value: int | None = None

    def select(self, *args: Any, **_kwargs: Any) -> "_Query":
        self.selected = str(args[0]) if args else ""
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
        if self.missing_workspace_column and (
            any(key == "workspace_id" for key, _value in self.filters)
            or "workspace_id" in self.selected
        ):
            raise RuntimeError(
                "PostgREST error 42703: column skill_versions.workspace_id does not exist"
            )
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
    def __init__(
        self,
        rows: list[dict[str, Any]],
        *,
        missing_workspace_column: bool = False,
    ) -> None:
        self.rows = rows
        self.missing_workspace_column = missing_workspace_column

    def table(self, name: str) -> _Query:
        assert name == "skill_versions"
        return _Query(self.rows, missing_workspace_column=self.missing_workspace_column)


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


def test_skill_version_lookup_falls_back_when_prod_schema_lacks_workspace_id():
    rows = [{"id": "sv_legacy", "manifest_json": {"name": "legacy"}}]
    repo = SupabaseWorkerRepository(
        client=_Client(rows, missing_workspace_column=True)  # type: ignore[arg-type]
    )

    with active_workspace("ws_a", "admin"):
        result = repo._skill_versions_by_id(["sv_legacy"])

    assert result == {"sv_legacy": rows[0]}


def test_skill_version_write_guard_falls_back_when_prod_schema_lacks_workspace_id():
    rows = [{"id": "sv_legacy", "user_id": "user_a"}]
    repo = SupabaseWorkerRepository(
        client=_Client(rows, missing_workspace_column=True)  # type: ignore[arg-type]
    )

    with active_workspace("ws_a", "admin"):
        repo._assert_skill_version_write_allowed(
            skill_version_id="sv_legacy",
            workspace_id="ws_a",
            user_id="user_a",
        )


def test_skill_versions_workspace_scope_migration_adds_column():
    migration = (
        "supabase/migrations/0040_skill_versions_workspace_scope.sql"
    )
    with open(migration, encoding="utf-8") as handle:
        sql = handle.read().lower()

    assert "alter table public.skill_versions" in sql
    assert "add column if not exists workspace_id" in sql
