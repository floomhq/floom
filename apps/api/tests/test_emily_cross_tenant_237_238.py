"""Regression tests for the two Emily cross-tenant breaches (a downstream host).

#237 — Emily ``workers__run`` leaked another tenant's PRIVATE worker ids /
       names / required-input schemas. The run-resolver
       (_resolve_runnable_worker -> _list_viewable_workers / _worker_can_view)
       read the engine SQLite ``workers`` table directly via ``get_db()`` with
       a single-tenant ``WHERE owner_id=? OR visibility IN (...)`` query that,
       in cloud's co-mingled SQLite shadow, returned rows from workspaces the
       caller has zero relationship to. Fix: route the resolver / can-view
       through the workspace-scoped ``WorkerRepository.list_for_agent`` /
       ``get_for_agent`` (the same path #1027 used for list/get).

#238 — Emily ``secrets__set`` let a low-priv member overwrite another user's
       (incl. the owner's) workspace secret, an action the HTTP API blocks via
       ``_require_secret_mutation_allowed`` (#952). Fix: ``_tool_secrets_set``
       now applies the same creator/role guard before calling
       ``repos.secrets.set``.

Cloud-cross-tenant behavior is exercised in two ways:
  * #237 via SQLite in strict (deploy='cloud') mode: a worker in a workspace
    the caller is NOT a member of behaves exactly like a foreign tenant's
    private worker — the membership-scoped repo must hide it from the resolver.
  * #238 via a fake workspace-scoped SecretRepository whose ``get`` returns the
    workspace row with the CREATOR's user_id (mirroring SupabaseSecretRepository
    keyed on (workspace_id, name)), since OSS SQLite secrets are per-user and
    cannot reproduce the cross-user overwrite on their own.
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import Any

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_api(monkeypatch, tmp_path, *, deploy: str = "local"):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-237-238-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "owner")
    monkeypatch.setenv("WORKEROS_DEPLOY", deploy)
    for name in list(sys.modules):
        if name in ("main", "db", "chat_service", "run_service", "models") \
                or name.startswith("db.") or name.startswith("channels"):
            sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    if deploy != "local":
        import db.factory as _factory
        # The engine standalone env cannot register the hosted Supabase repo;
        # register the built-in SQLite repos under the 'cloud' key (auto-reverts
        # via monkeypatch.setitem) so the repo-routed resolver resolves seeded
        # workers while deploy='cloud' keeps _worker_can_view strict.
        monkeypatch.setitem(
            _factory._repositories_factories, deploy, _factory._local_repositories
        )
        _factory.get_repositories.cache_clear()
    return main


def _seed_worker(
    conn,
    now,
    *,
    worker_id: str,
    name: str,
    owner_id: str,
    workspace_id: str,
    visibility: str = "private",
) -> None:
    import json
    manifest = json.dumps({
        "id": worker_id,
        "name": name,
        "trigger": {"type": "manual"},
        "exec": {"runner": "e2b", "mode": "agent"},
        # A required input — the issue's leak surfaced this schema before the
        # ownership check. A correct fix must 404 before we ever reach it.
        "inputs": [{"name": "prospect_name", "label": "Prospect name", "required": True}],
    })
    sv_id = f"sv_{worker_id}"
    conn.execute(
        "INSERT OR IGNORE INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at) "
        "VALUES (?, ?, '0.1.0', ?, NULL, ?)",
        (sv_id, worker_id, manifest, now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO workers (id, skill_version_id, name, trigger_type, enabled, owner_id, "
        "workspace_id, visibility, created_at) VALUES (?, ?, ?, 'manual', 1, ?, ?, ?, ?)",
        (worker_id, sv_id, name, owner_id, workspace_id, visibility, now),
    )


def _add_member(conn, *, workspace_id: str, user_id: str, role: str = "member") -> None:
    now = "2024-01-01T00:00:00"
    conn.execute(
        "INSERT OR REPLACE INTO workspace_members "
        "(workspace_id, user_id, email, role, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 'active', ?, ?)",
        (workspace_id, user_id, f"{user_id}@test.local", role, now, now),
    )


# ===========================================================================
# #237 — Emily workers__run must not leak / run another tenant's private worker
# ===========================================================================

class TestC237WorkerCrossTenant:
    # Real tenant-private worker ids — deliberately NOT in PUBLIC/PROTECTED
    # stock sets (those are world-accessible by design; using them here would
    # test nothing). These mirror the issue's repro: another tenant's PRIVATE
    # workers in a workspace gohigh has zero relationship to.
    FOREIGN = ("acme-outbound-private", "acme-crm-sync", "acme-secret-report")

    def _setup(self, main):
        """gohigh (own empty workspace) vs a foreign tenant's private workers."""
        with main.get_db() as conn:
            now = main.now_iso()
            for wid in self.FOREIGN:
                _seed_worker(conn, now, worker_id=wid, name=wid.replace("-", " ").title(),
                             owner_id="147f8aa9", workspace_id="ws_f862b4a9c2ad40",
                             visibility="private")
            # gohigh is the owner of his OWN empty workspace; he is NOT a member
            # of ws_f862. (Membership in his own ws is implicit / irrelevant.)
            _add_member(conn, workspace_id="ws_5ead198128f847", user_id="gohigh")

    def test_resolver_does_not_enumerate_foreign_private_workers(self, monkeypatch, tmp_path):
        """_list_viewable_workers must not return another tenant's private
        worker ids/names (the disclosure vector in the issue)."""
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        import chat_service as cs
        self._setup(main)

        with main.get_db() as conn:
            viewable = cs._list_viewable_workers(conn, "gohigh")
        ids = {w["id"] for w in viewable}
        for leaked in self.FOREIGN:
            assert leaked not in ids, (
                f"gohigh is not a member of ws_f862; foreign private worker "
                f"{leaked!r} must NOT appear in his run-resolver candidate set"
            )

    def test_run_by_id_does_not_leak_input_schema(self, monkeypatch, tmp_path):
        """workers__run by the exact foreign worker id must 404 BEFORE the
        input-schema validation (the issue leaked 'Missing required inputs')."""
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        import chat_service as cs
        import run_service as rs
        self._setup(main)

        fired: list[str] = []
        monkeypatch.setattr(rs, "create_run", lambda wid, *a, **kw: fired.append(wid) or "run-x")
        monkeypatch.setattr(rs, "start_run", lambda *a, **kw: None)

        res = cs._tool_workers_run(
            {"id": "acme-outbound-private", "inputs_json": "{}"}, "gohigh"
        )
        # The run is refused (either a clean not-found or a candidate-confirm
        # prompt offering gohigh's OWN workers) — never a success.
        assert res["ok"] is False
        # The input-schema leak ('Missing required inputs: prospect_name') must
        # NOT appear — the worker was never resolved/owner-checked far enough to
        # surface its schema.
        assert "missing_inputs" not in res
        assert "prospect_name" not in res["error"].lower()
        # If candidates are offered, the foreign private worker must NOT be one.
        candidate_ids = {c["id"] for c in res.get("candidates", [])}
        assert "acme-outbound-private" not in candidate_ids
        assert fired == [], "foreign private worker must never be queued"

        # Defense-in-depth: even a direct can-view check (the final run guard)
        # must reject the foreign private worker for gohigh.
        with main.get_db() as conn:
            assert cs._worker_can_view(conn, "acme-outbound-private", "gohigh") is False

    def test_resolver_fuzzy_ref_does_not_surface_foreign_candidates(self, monkeypatch, tmp_path):
        """A fuzzy ref must not surface a foreign tenant's PRIVATE worker as a
        candidate (issue: a vague id leaked the foreign worker as a candidate)."""
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        import chat_service as cs
        self._setup(main)

        with main.get_db() as conn:
            res = cs._resolve_runnable_worker(conn, "acme crm", "gohigh")
        assert res["ok"] is False
        candidate_ids = {c["id"] for c in res.get("candidates", [])}
        assert "acme-crm-sync" not in candidate_ids, (
            "foreign tenant's private acme-crm-sync must not be offered as a candidate"
        )

    def test_resolver_routes_through_workspace_scoped_repo_not_raw_sqlite(self, monkeypatch, tmp_path):
        """The fix's core property: the run-resolver now sources its candidate
        set and can-view decision from the workspace-scoped WorkerRepository
        (list_for_agent / get_for_agent) — the SAME backend-scoped path #1027
        used for list/get — instead of a raw, unscoped SQLite query that, in
        cloud's co-mingled shadow table, returned other tenants' rows.

        A tracking repo proves the resolver consults the repo (so cloud's
        SupabaseWorkerRepository workspace scoping is now authoritative) and
        that a worker the repo hides is NOT runnable."""
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        import chat_service as cs
        self._setup(main)

        from db import get_repositories as _real_get_repos
        real = _real_get_repos()
        calls = {"list_for_agent": 0, "get_for_agent": 0}

        class _Tracking:
            def list_for_agent(self, **kw):
                calls["list_for_agent"] += 1
                # Workspace-scoped repo returns ONLY gohigh's own (empty) set.
                return []

            def get_for_agent(self, **kw):
                calls["get_for_agent"] += 1
                # Workspace scoping: the foreign private worker is not viewable.
                return None

        tracking_repos = real._replace(workers=_Tracking())
        monkeypatch.setattr("db.get_repositories", lambda: tracking_repos, raising=False)

        with main.get_db() as conn:
            viewable = cs._list_viewable_workers(conn, "gohigh")
            can_view = cs._worker_can_view(conn, "acme-crm-sync", "gohigh")

        assert calls["list_for_agent"] >= 1, "resolver must source candidates from the repo"
        assert calls["get_for_agent"] >= 1, "can-view must route through the repo"
        # The repo hid every non-stock worker → only stock workers remain (the
        # foreign private workers are gone).
        viewable_ids = {w["id"] for w in viewable}
        for wid in self.FOREIGN:
            assert wid not in viewable_ids
        assert can_view is False

    def test_member_of_foreign_workspace_can_still_run_shared_worker(self, monkeypatch, tmp_path):
        """Positive control: an ACTIVE member of the workspace CAN run a
        workspace-visible worker there (fix must not over-block)."""
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        import chat_service as cs
        import run_service as rs

        with main.get_db() as conn:
            now = main.now_iso()
            _seed_worker(conn, now, worker_id="shared-w", name="Shared W",
                         owner_id="alice", workspace_id="ws_team",
                         visibility="workspace")
            _add_member(conn, workspace_id="ws_team", user_id="bob", role="member")

        fired: list[str] = []
        monkeypatch.setattr(rs, "get_worker_config_for_run", lambda wid: None)
        monkeypatch.setattr(rs, "create_run", lambda wid, *a, **kw: fired.append(wid) or "run-ok")
        monkeypatch.setattr(rs, "start_run", lambda *a, **kw: None)

        res = cs._tool_workers_run({"id": "shared-w", "inputs_json": "{}"}, "bob")
        assert res["ok"] is True
        assert fired == ["shared-w"]


# ===========================================================================
# #238 — Emily secrets__set must not let a member overwrite another's secret
# ===========================================================================

class _FakeWorkspaceSecretRepo:
    """Mimics the hosted SupabaseSecretRepository: keyed on (workspace, name),
    so ``get`` returns the existing workspace row with its CREATOR's user_id,
    regardless of which caller asks."""

    def __init__(self, existing: dict[str, dict[str, Any]] | None = None) -> None:
        # name -> {"user_id": creator, "name": name, ...}
        self.rows: dict[str, dict[str, Any]] = existing or {}
        self.set_calls: list[tuple[str, str, str]] = []  # (caller, name, value)

    def get(self, *, user_id: str, name: str) -> dict[str, Any] | None:
        return self.rows.get(name)

    def set(self, *, user_id: str, name: str, value: str, status: str = "set") -> dict[str, Any]:
        self.set_calls.append((user_id, name, value))
        # Workspace upsert: keeps the original creator if the row exists,
        # otherwise stamps the caller as creator (matches cloud behavior).
        row = self.rows.get(name)
        if row is None:
            row = {"user_id": user_id, "name": name}
            self.rows[name] = row
        row["status"] = status
        return row


def _impls(main):
    import chat_service  # noqa: F401  (ensures engine graph is loaded)
    from services import chat_tool_impls
    return chat_tool_impls


def _patch_repos(monkeypatch, impls, secret_repo) -> None:
    fake_repos = types.SimpleNamespace(secrets=secret_repo)
    monkeypatch.setattr(
        "db.get_repositories", lambda: fake_repos, raising=False
    )


# ===========================================================================
# #1380 - Emily runs__cancel must not cancel another user's run
# ===========================================================================

class TestC1380RunCancelCrossUser:
    def test_member_cannot_cancel_another_users_run(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        impls = _impls(main)
        repos = main.get_repositories()
        with main.get_db() as conn:
            now = main.now_iso()
            _seed_worker(
                conn,
                now,
                worker_id="alice-worker",
                name="Alice Worker",
                owner_id="alice",
                workspace_id="ws_alice",
            )
        run_id = main.create_run(
            "alice-worker",
            {},
            trigger_source="manual",
            user_id="alice",
            repos=repos,
        )

        blocked = impls._tool_runs_cancel({"run_id": run_id}, user_id="bob")

        assert blocked["ok"] is False
        assert "not found" in blocked["error"].lower()
        with main.get_db() as conn:
            row = conn.execute(
                "SELECT cancel_requested FROM runs WHERE id = ?",
                (run_id,),
            ).fetchone()
        assert row["cancel_requested"] == 0

    def test_owner_can_cancel_own_run_from_emily_tool(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        impls = _impls(main)
        repos = main.get_repositories()
        with main.get_db() as conn:
            now = main.now_iso()
            _seed_worker(
                conn,
                now,
                worker_id="owner-cancel-worker",
                name="Owner Cancel Worker",
                owner_id="alice",
                workspace_id="ws_alice",
            )
        run_id = main.create_run(
            "owner-cancel-worker",
            {},
            trigger_source="manual",
            user_id="alice",
            repos=repos,
        )

        allowed = impls._tool_runs_cancel({"run_id": run_id}, user_id="alice")

        assert allowed["ok"] is True
        with main.get_db() as conn:
            row = conn.execute(
                "SELECT cancel_requested, status, error_code, completed_at FROM runs WHERE id = ?",
                (run_id,),
            ).fetchone()
        assert row["cancel_requested"] == 1
        assert row["status"] == "failed"
        assert row["error_code"] == "cancelled_queued"
        assert row["completed_at"]


class TestC238SecretCrossUser:
    def test_member_cannot_overwrite_another_users_secret(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        impls = _impls(main)
        repo = _FakeWorkspaceSecretRepo(
            existing={"OPENAI_API_KEY": {"user_id": "alice-owner", "name": "OPENAI_API_KEY"}}
        )
        _patch_repos(monkeypatch, impls, repo)
        # bob is a non-admin member.
        monkeypatch.setattr(impls, "_caller_is_workspace_admin", lambda uid: False)

        res = impls._tool_secrets_set(
            {"name": "OPENAI_API_KEY", "value": "attacker-key"}, user_id="bob-member"
        )
        assert res["ok"] is False
        assert "admin or the creator" in res["error"].lower()
        assert repo.set_calls == [], "set() must NOT be reached for a blocked overwrite"
        # The owner's secret row is untouched.
        assert repo.rows["OPENAI_API_KEY"]["user_id"] == "alice-owner"

    def test_admin_can_overwrite_any_secret(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        impls = _impls(main)
        repo = _FakeWorkspaceSecretRepo(
            existing={"OPENAI_API_KEY": {"user_id": "alice-owner", "name": "OPENAI_API_KEY"}}
        )
        _patch_repos(monkeypatch, impls, repo)
        monkeypatch.setattr(impls, "_caller_is_workspace_admin", lambda uid: True)

        res = impls._tool_secrets_set(
            {"name": "OPENAI_API_KEY", "value": "rotated-by-admin"}, user_id="carol-admin"
        )
        assert res["ok"] is True
        assert len(repo.set_calls) == 1

    def test_creator_can_overwrite_own_secret(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        impls = _impls(main)
        repo = _FakeWorkspaceSecretRepo(
            existing={"MY_KEY": {"user_id": "bob-member", "name": "MY_KEY"}}
        )
        _patch_repos(monkeypatch, impls, repo)
        monkeypatch.setattr(impls, "_caller_is_workspace_admin", lambda uid: False)

        res = impls._tool_secrets_set(
            {"name": "MY_KEY", "value": "new-value"}, user_id="bob-member"
        )
        assert res["ok"] is True
        assert len(repo.set_calls) == 1

    def test_new_secret_creation_allowed_for_member(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path, deploy="cloud")
        impls = _impls(main)
        repo = _FakeWorkspaceSecretRepo(existing={})  # no existing row
        _patch_repos(monkeypatch, impls, repo)
        monkeypatch.setattr(impls, "_caller_is_workspace_admin", lambda uid: False)

        res = impls._tool_secrets_set(
            {"name": "NEW_KEY", "value": "v"}, user_id="bob-member"
        )
        assert res["ok"] is True
        assert repo.set_calls == [("bob-member", "NEW_KEY", "v")]
