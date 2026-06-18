"""Round-09 P0 #3 — cloud Emily / dashboard worker split-brain follow-up.

The live cloud surface showed the dashboard grid = 1 worker while Emily's tool
backend listed 9 (the 1-vs-9 split-brain). The engine slice-1 fix made the OSS
`list_for_agent` hide the same set the grid hides and return ``owner_id`` so the
shared hide-helpers (``_worker_hidden_from_api`` / ``_build_owned_tracked_ids``)
work. This locks the CLOUD ``SupabaseWorkerRepository.list_for_agent``:

  1. it returns ``owner_id`` on every row (the engine chat tool + grid hide
     helpers expect it; the reshaped agent row previously dropped it), and
  2. for a single workspace, the Emily-agent id set EQUALS the dashboard-grid id
     set (no extra workers Emily can see that the grid hides), including when the
     workspace contains both the caller's own workers AND another member's
     SHARED worker.

Hermetic: reuses the minimal fake Supabase client from
tests/test_workers_for_agent_scope_237.py (no real Supabase).
"""

from __future__ import annotations

import pytest

from apps.api.auth.workspace_context import active_workspace
from apps.api.db import supabase_repos as repos_module
from apps.api.db.supabase_repos import SupabaseWorkerRepository

from tests.test_workers_for_agent_scope_237 import (
    CALLER_USER,
    CALLER_WS,
    OWN_WORKER,
    _FakeClient,
    _manifest,
    _now_iso,
    _two_tenant_client,
)


SHARED_WORKER = "shared-teammate-worker"
SHARED_SKILL = "sv_shared"
TEAMMATE_USER = "user_teammate"


@pytest.fixture(autouse=True)
def _reset_recipe_cache():
    token = repos_module._recipe_cache.set(None)
    try:
        yield
    finally:
        repos_module._recipe_cache.reset(token)


def _client_same_ws_shared() -> _FakeClient:
    """Caller's own worker + a teammate's SHARED worker in the SAME workspace."""
    client = _two_tenant_client()
    now_iso = _now_iso()
    client.rows_by_table["workers"].append(
        {
            "id": SHARED_WORKER,
            "user_id": TEAMMATE_USER,
            "workspace_id": CALLER_WS,  # SAME workspace as the caller
            "skill_version_id": SHARED_SKILL,
            "name": "Teammate Shared Worker",
            "trigger_type": "manual",
            "visibility": "shared",
            "grants_json": {},
            "input_values_json": {},
            "triggers_json": [],
            "enabled": True,
            "created_at": now_iso,
        }
    )
    client.rows_by_table["skill_versions"].append(
        {
            "id": SHARED_SKILL,
            "user_id": TEAMMATE_USER,
            "name": SHARED_WORKER,
            "version": "0.1.0",
            "manifest_json": _manifest(SHARED_WORKER, "Teammate Shared Worker"),
            "bundle_path": f"workers/{SHARED_WORKER}",
            "created_at": now_iso,
        }
    )
    return client


def test_list_for_agent_rows_carry_owner_id():
    client = _client_same_ws_shared()
    with active_workspace(CALLER_WS, "member"):
        rows = SupabaseWorkerRepository(client=client).list_for_agent(user_id=CALLER_USER)
    assert rows, "expected at least the caller's own worker"
    for row in rows:
        assert "owner_id" in row, f"agent row missing owner_id: {row}"
    by_id = {r["id"]: r for r in rows}
    assert by_id[OWN_WORKER]["owner_id"] == CALLER_USER
    # The teammate's SHARED worker is visible AND correctly attributed to them.
    assert by_id[SHARED_WORKER]["owner_id"] == TEAMMATE_USER


def test_cloud_emily_count_equals_grid_count_same_workspace():
    # Grid (dashboard) = list(); Emily = list_for_agent(). For one workspace the
    # id sets must be identical — no worker Emily lists that the grid hides.
    client_a = _client_same_ws_shared()
    with active_workspace(CALLER_WS, "member"):
        grid_ids = {
            r["id"]
            for r in SupabaseWorkerRepository(client=client_a).list(
                user_id=CALLER_USER, role="member"
            )
        }
    client_b = _client_same_ws_shared()
    with active_workspace(CALLER_WS, "member"):
        emily_ids = {
            r["id"]
            for r in SupabaseWorkerRepository(client=client_b).list_for_agent(
                user_id=CALLER_USER
            )
        }
    assert emily_ids == grid_ids
    assert len(emily_ids) == len(grid_ids)
    # Both surfaces see the caller's own worker and the teammate's shared one.
    assert OWN_WORKER in emily_ids
    assert SHARED_WORKER in emily_ids
