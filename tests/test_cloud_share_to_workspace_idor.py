"""Regression tests for cloud_share_worker_to_workspace.

Covers two findings that must be fixed together:

* U-01: the engine call ``_register_worker_from_files`` is keyword-only and
  returns a ``str`` id. The cloud handler used to call it positionally and
  treat the return as a dict, so the whole share flow was a 500 for everyone.

* U-02: cross-tenant IDOR. ``repos.workers.get_any`` is a global, unscoped
  lookup by (guessable) worker id. Without a source-workspace check, a
  workspace admin could clone ANOTHER tenant's worker.yml/run.py into their own
  workspace. The handler must assert the source worker's workspace_id equals
  the caller's active workspace, and must NOT read the source files when it
  doesn't.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace

import pytest


def _load_cloud_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    for name in [
        "apps.api.main",
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


class _FakeWorkers:
    """Minimal workers repo. get_any is global/unscoped, by design."""

    def __init__(self, rows: dict[str, dict]):
        self.rows = rows
        self.registered: list[dict] = []
        self.visibility_set: list[tuple[str, str]] = []

    def get_any(self, *, worker_id: str):
        row = self.rows.get(worker_id)
        return dict(row) if row else None

    def set_visibility(self, *, worker_id: str, visibility: str):
        self.visibility_set.append((worker_id, visibility))


def _wire_common(monkeypatch, main, *, workspace_id, member_role, owner_user_id,
                 worker_workspace_map, repos):
    async def verify(_self, _request):
        return SimpleNamespace(user_id="admin_user", email=None, scopes=())

    monkeypatch.setattr(
        "apps.api.auth.supabase_provider.SupabaseAuthProvider.verify", verify
    )
    monkeypatch.setattr(
        "apps.api.auth.workspace_context.get_active_workspace_id",
        lambda: workspace_id,
    )
    monkeypatch.setattr(
        "apps.api.auth.workspace_context.get_active_member_role",
        lambda: member_role,
    )
    monkeypatch.setattr(
        "apps.api.db.workspaces.get",
        lambda *, workspace_id: {"id": workspace_id, "owner_user_id": owner_user_id},
    )
    monkeypatch.setattr(
        "apps.api.db.workspaces.workspace_id_for_worker",
        lambda *, worker_id: worker_workspace_map.get(worker_id),
    )
    monkeypatch.setattr(main.engine_main, "get_repositories", lambda: repos)
    monkeypatch.setattr(main.engine_main, "DraftFile", SimpleNamespace)
    monkeypatch.setattr(main, "_read_worker_files_from_disk", lambda _wid: {})
    monkeypatch.setattr(main, "_cloud_persist_worker_files", lambda *a, **k: None)


def test_own_tenant_share_works(monkeypatch, tmp_path):
    """U-01 fixed: a worker in the caller's own workspace shares -> 200/id."""
    main = _load_cloud_main(monkeypatch, tmp_path)

    files = {"worker.yml": "id: src\nname: Src\n", "run.py": "print('a')\n"}
    workers = _FakeWorkers(
        {
            "src-worker": {
                "id": "src-worker",
                "owner_id": "admin_user",
                "user_id": "admin_user",
                "skill_version_id": "",
            }
        }
    )
    repos = SimpleNamespace(workers=workers)

    _wire_common(
        monkeypatch,
        main,
        workspace_id="ws_a",
        member_role="admin",
        owner_user_id="admin_user",
        worker_workspace_map={"src-worker": "ws_a"},
        repos=repos,
    )
    # Source files come from disk in this fixture.
    monkeypatch.setattr(main, "_read_worker_files_from_disk", lambda _wid: files)

    register_calls = []

    def fake_register(draft_files, *, user_id, repos=None, dedupe_id=False):
        register_calls.append(
            {"user_id": user_id, "dedupe_id": dedupe_id, "n": len(draft_files)}
        )
        # Make the new id resolvable via get_any so the response can be built.
        workers.rows["src-worker-2"] = {"id": "src-worker-2", "user_id": user_id}
        return "src-worker-2"

    monkeypatch.setattr(main.engine_main, "_register_worker_from_files", fake_register)

    result = asyncio.run(main.cloud_share_worker_to_workspace("src-worker", object()))

    assert result["id"] == "src-worker-2"
    assert result["visibility"] == "shared"
    assert result["workspace_worker"] is True
    # Keyword-only call honored, owned by workspace admin, deduped.
    assert register_calls == [{"user_id": "admin_user", "dedupe_id": True, "n": 2}]
    assert ("src-worker-2", "shared") in workers.visibility_set


def test_cross_tenant_share_blocked(monkeypatch, tmp_path):
    """U-02 fixed: cloning tenant B's worker into tenant A is 404, no read."""
    main = _load_cloud_main(monkeypatch, tmp_path)

    # B's worker exists globally (get_any can see it) but lives in ws_b.
    workers = _FakeWorkers(
        {
            "victim-worker": {
                "id": "victim-worker",
                "owner_id": "victim_user",
                "user_id": "victim_user",
                "skill_version_id": "sv_secret",
            }
        }
    )
    repos = SimpleNamespace(workers=workers)

    _wire_common(
        monkeypatch,
        main,
        workspace_id="ws_a",  # attacker's active workspace
        member_role="admin",
        owner_user_id="admin_user",
        worker_workspace_map={"victim-worker": "ws_b"},  # victim is in ws_b
        repos=repos,
    )

    # If the gate fails, the handler would read B's files. Make any such read blow up
    # so the test proves no file access happened.
    def explode(*_a, **_k):
        raise AssertionError("source files must not be read cross-tenant")

    monkeypatch.setattr(main, "_read_worker_files_from_disk", explode)

    def fake_client():
        raise AssertionError("skill_versions must not be read cross-tenant")

    monkeypatch.setattr("apps.api.config.get_supabase_service_client", fake_client)

    def must_not_register(*_a, **_k):
        raise AssertionError("must not register a clone cross-tenant")

    monkeypatch.setattr(
        main.engine_main, "_register_worker_from_files", must_not_register
    )

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(main.cloud_share_worker_to_workspace("victim-worker", object()))

    assert exc.value.status_code == 404
    assert workers.visibility_set == []
