"""Regression test for cloud issue #237.

Locks the workspace scoping of ``SupabaseWorkerRepository.list_for_agent`` and
``get_for_agent`` (apps/api/db/supabase_repos.py). The engine's Emily
workers__run resolver routes through these methods; a regression in cloud repo
scoping would re-open a cross-tenant private-worker leak.

Hermetic: there is NO real Supabase. A minimal fake Supabase client replicates
the postgrest builder semantics the repo relies on (select/eq/in_/or_/order/
limit/execute), modelled on the harness in tests/test_supabase_repos.py.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from apps.api.auth.workspace_context import active_workspace
from apps.api.db import supabase_repos as repos_module
from apps.api.db.supabase_repos import SupabaseWorkerRepository


# --- Minimal hermetic Supabase fake (mirrors tests/test_supabase_repos.py) ---


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, rows):
        self.rows = rows
        self.table_name = None
        self.filters: list[tuple[str, str]] = []
        self.in_filters: list[tuple[str, set[str]]] = []
        self.or_filters: list[str] = []
        self.limit_value = None
        self.selected = None

    def select(self, value, **_kwargs):
        self.selected = value
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

    def limit(self, value):
        self.limit_value = value
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = self.rows
        for key, value in self.filters:
            rows = [row for row in rows if row.get(key) == value]
        for key, values in self.in_filters:
            rows = [row for row in rows if row.get(key) in values]
        for value in self.or_filters:
            clauses = [clause.split(".", 2) for clause in value.split(",")]
            rows = [
                row
                for row in rows
                if any(
                    len(clause) == 3
                    and clause[1] == "eq"
                    and str(row.get(clause[0])) == clause[2]
                    for clause in clauses
                )
            ]
        if self.limit_value is not None:
            rows = rows[: self.limit_value]
        return _FakeResponse(rows)


class _FakeClient:
    def __init__(self, rows):
        self.rows_by_table = rows if isinstance(rows, dict) else None
        self.rows = rows
        self.table_ref = _FakeTable([])

    def table(self, name):
        rows = self.rows_by_table.get(name, []) if self.rows_by_table is not None else self.rows
        self.table_ref = _FakeTable(rows)
        self.table_ref.table_name = name
        return self.table_ref


# --- Seed-row helpers (shape per tests/test_supabase_repos.py) ---


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _manifest(worker_id: str, name: str) -> dict[str, object]:
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


CALLER_USER = "user_caller"
CALLER_WS = "ws_caller"
OWN_WORKER = "own-worker"
OWN_SKILL = "sv_own"

FOREIGN_USER = "user_foreign"
FOREIGN_WS = "ws_foreign"
FOREIGN_WORKER = "foreign-private-worker"
FOREIGN_SKILL = "sv_foreign"


def _two_tenant_client() -> _FakeClient:
    now_iso = _now_iso()
    return _FakeClient(
        {
            "workers": [
                {
                    "id": OWN_WORKER,
                    "user_id": CALLER_USER,
                    "workspace_id": CALLER_WS,
                    "skill_version_id": OWN_SKILL,
                    "name": "Own Worker",
                    "trigger_type": "manual",
                    "visibility": "private",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                },
                {
                    "id": FOREIGN_WORKER,
                    "user_id": FOREIGN_USER,
                    "workspace_id": FOREIGN_WS,
                    "skill_version_id": FOREIGN_SKILL,
                    "name": "Foreign Private Worker",
                    "trigger_type": "manual",
                    "visibility": "private",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                },
            ],
            "skill_versions": [
                {
                    "id": OWN_SKILL,
                    "user_id": CALLER_USER,
                    "name": OWN_WORKER,
                    "version": "0.1.0",
                    "manifest_json": _manifest(OWN_WORKER, "Own Worker"),
                    "bundle_path": f"workers/{OWN_WORKER}",
                    "created_at": now_iso,
                },
                {
                    "id": FOREIGN_SKILL,
                    "user_id": FOREIGN_USER,
                    "name": FOREIGN_WORKER,
                    "version": "0.1.0",
                    "manifest_json": _manifest(FOREIGN_WORKER, "Foreign Private Worker"),
                    "bundle_path": f"workers/{FOREIGN_WORKER}",
                    "created_at": now_iso,
                },
            ],
        }
    )


@pytest.fixture(autouse=True)
def _reset_recipe_cache():
    """list() populates a request-scoped contextvar cache; reset it so each
    test (and each call within a test) starts clean and no foreign row leaks in
    via a stale cache."""
    token = repos_module._recipe_cache.set(None)
    try:
        yield
    finally:
        repos_module._recipe_cache.reset(token)


# --- Tests ---


def test_list_for_agent_does_not_leak_foreign_workspace_worker():
    client = _two_tenant_client()
    with active_workspace(CALLER_WS, "member"):
        rows = SupabaseWorkerRepository(client=client).list_for_agent(
            user_id=CALLER_USER,
        )
    ids = {row["id"] for row in rows}
    # Positive control: caller's own worker is returned.
    assert OWN_WORKER in ids
    # Isolation: a private worker in a DIFFERENT workspace/user is NOT returned.
    assert FOREIGN_WORKER not in ids


def test_list_for_agent_admin_view_still_does_not_leak_foreign_workspace():
    """include_all_users=True (admin inventory intent) must still be scoped to
    the active workspace — it never crosses into another tenant's workspace."""
    client = _two_tenant_client()
    with active_workspace(CALLER_WS, "admin"):
        rows = SupabaseWorkerRepository(client=client).list_for_agent(
            user_id=CALLER_USER,
            include_all_users=True,
        )
    ids = {row["id"] for row in rows}
    assert OWN_WORKER in ids
    assert FOREIGN_WORKER not in ids


def test_get_for_agent_returns_none_for_foreign_workspace_worker():
    client = _two_tenant_client()
    with active_workspace(CALLER_WS, "member"):
        result = SupabaseWorkerRepository(client=client).get_for_agent(
            user_id=CALLER_USER,
            worker_id=FOREIGN_WORKER,
        )
    assert result is None


def test_get_for_agent_returns_own_workspace_worker():
    client = _two_tenant_client()
    with active_workspace(CALLER_WS, "member"):
        result = SupabaseWorkerRepository(client=client).get_for_agent(
            user_id=CALLER_USER,
            worker_id=OWN_WORKER,
        )
    assert result is not None
    assert result["id"] == OWN_WORKER
