"""#892 — safe worker-name resolution; #891 — approval decision tools.

#892: "run the node smoke test worker" must resolve to `node-smoke-test` (or
ask), and must NEVER silently fire a different worker (the live proof run
fuzzy-matched it to `approval-smoke-e2e` and ran it). _resolve_runnable_worker
only returns a worker on a HIGH-CONFIDENCE, UNAMBIGUOUS match; on ambiguity it
returns candidate ids for the model to confirm — it never auto-picks.

#891: the chat agent can approve/reject its OWN pending runs via the new
approvals__approve / approvals__reject tools (owner-scoped — an actor can never
decide another user's run).

Run: cd apps/api && python -m pytest tests/test_891_892_chat_exec_gaps.py -q
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
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "owner")
    # deploy='cloud' makes _worker_can_view strict (no dev filesystem fallback),
    # which is the multi-tenant mode where the #892 misroute actually occurred.
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
    # #237: the run-resolver (_resolve_runnable_worker -> _list_viewable_workers
    # / _worker_can_view) now routes through get_repositories() (the same
    # workspace-scoped repo path as the #1027 list/get tools) instead of a raw
    # get_db() read. The engine standalone test env cannot register the cloud
    # Supabase repo, so register the built-in SQLite repos under the 'cloud'
    # deploy key too. This keeps the test's only reason for deploy='cloud'
    # (strict _worker_can_view: no dev filesystem fallback, driven by the env
    # flag) while letting the repo-routed resolver resolve the seeded workers.
    if deploy != "local":
        import db.factory as _factory
        # Use monkeypatch.setitem so the registration auto-reverts at teardown
        # (test_db_factory.py asserts deploy='cloud' raises when unregistered).
        monkeypatch.setitem(
            _factory._repositories_factories, deploy, _factory._local_repositories
        )
        _factory.get_repositories.cache_clear()
    return main


def _seed_worker(conn, now, *, worker_id: str, name: str, owner_id: str = "owner") -> None:
    import json
    manifest = json.dumps({
        "id": worker_id,
        "name": name,
        "trigger": {"type": "manual"},
        "runtime": {"type": "e2b", "runner": "e2b"},
        "exec": {"runner": "e2b", "mode": "agent"},
    })
    sv_id = f"sv_{worker_id}"
    conn.execute(
        "INSERT OR IGNORE INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at) "
        "VALUES (?, ?, '0.1.0', ?, NULL, ?)",
        (sv_id, worker_id, manifest, now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO workers (id, skill_version_id, name, trigger_type, enabled, owner_id, "
        "workspace_id, visibility, created_at) "
        "VALUES (?, ?, ?, 'manual', 1, ?, 'local-default', 'private', ?)",
        (worker_id, sv_id, name, owner_id, now),
    )


def _seed_pending_approval(
    conn, now, *, approval_id: str, run_id: str, owner_id: str, worker_id: str,
    kind: str | None = None, label: str = "Approve action",
) -> None:
    import json
    conn.execute(
        "INSERT OR IGNORE INTO runs (id, worker_id, status, trigger_source, runner, input_json, "
        "output_json, approval_status, created_at) "
        "VALUES (?, ?, 'pending_approval', 'workspace-agent', 'e2b', '{}', '{}', 'required', ?)",
        (run_id, worker_id, now),
    )
    decision_input = json.dumps({"kind": kind}) if kind else "{}"
    conn.execute(
        "INSERT INTO approvals (id, run_id, worker_id, owner_id, status, label, created_at, "
        "decision_input_json) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
        (approval_id, run_id, worker_id, owner_id, label, now, decision_input),
    )


# ---------------------------------------------------------------------------
# #892 — safe worker resolution
# ---------------------------------------------------------------------------

def test_892_node_smoke_test_resolves_not_approval_smoke(monkeypatch, tmp_path):
    """The exact bug: 'node smoke test' must resolve to node-smoke-test, never
    silently to approval-smoke-e2e. Verified in cloud (strict) mode, the
    multi-tenant deploy where the live proof-run misroute occurred."""
    main = _load_api(monkeypatch, tmp_path, deploy="cloud")
    import chat_service as cs

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="node-smoke-test", name="Node Smoke Test")
        _seed_worker(conn, now, worker_id="approval-smoke-e2e", name="Approval Smoke E2E")

    with main.get_db() as conn:
        # Natural-language name.
        res = cs._resolve_runnable_worker(conn, "node smoke test", "owner")
        assert res["ok"] is True
        assert res["worker_id"] == "node-smoke-test"

        # Even the verbose "the node smoke test worker" phrasing — the trailing
        # filler "worker" is normalized away; still resolves to node-smoke-test.
        res2 = cs._resolve_runnable_worker(conn, "node smoke test worker", "owner")
        assert res2["ok"] is True
        assert res2["worker_id"] == "node-smoke-test"

        # Exact id still works.
        res3 = cs._resolve_runnable_worker(conn, "node-smoke-test", "owner")
        assert res3["ok"] is True and res3["worker_id"] == "node-smoke-test"


def test_892_run_tool_never_silently_runs_wrong_worker(monkeypatch, tmp_path):
    """_tool_workers_run must NOT fire approval-smoke-e2e for 'node smoke test'."""
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs
    import run_service as rs

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="node-smoke-test", name="Node Smoke Test")
        _seed_worker(conn, now, worker_id="approval-smoke-e2e", name="Approval Smoke E2E")

    fired: list[str] = []
    monkeypatch.setattr(rs, "get_worker_config_for_run", lambda wid: None)
    monkeypatch.setattr(rs, "create_run", lambda wid, *a, **kw: fired.append(wid) or "run-x")
    monkeypatch.setattr(rs, "start_run", lambda *a, **kw: None)

    res = cs._tool_workers_run({"id": "node smoke test", "inputs_json": "{}"}, "owner")
    assert res["ok"] is True
    assert fired == ["node-smoke-test"], "must run node-smoke-test, never approval-smoke-e2e"


def test_892_ambiguous_prefix_returns_candidates_not_a_run(monkeypatch, tmp_path):
    """An ambiguous reference returns candidates and does NOT run anything."""
    main = _load_api(monkeypatch, tmp_path, deploy="cloud")
    import chat_service as cs
    import run_service as rs

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="smoke-test-one", name="Smoke Test One")
        _seed_worker(conn, now, worker_id="smoke-test-two", name="Smoke Test Two")

    fired: list[str] = []
    monkeypatch.setattr(rs, "create_run", lambda wid, *a, **kw: fired.append(wid) or "run-x")
    monkeypatch.setattr(rs, "start_run", lambda *a, **kw: None)
    monkeypatch.setattr(rs, "get_worker_config_for_run", lambda wid: None)

    res = cs._tool_workers_run({"id": "smoke test", "inputs_json": "{}"}, "owner")
    assert res["ok"] is False
    assert res.get("ambiguous") is True
    ids = {c["id"] for c in res.get("candidates", [])}
    assert {"smoke-test-one", "smoke-test-two"} <= ids
    assert fired == [], "ambiguous reference must not run any worker"


def test_892_unknown_worker_is_not_found(monkeypatch, tmp_path):
    """A reference with no token overlap reads as a clean not-found (no run)."""
    main = _load_api(monkeypatch, tmp_path, deploy="cloud")
    import chat_service as cs

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="weekly-update", name="Weekly Update")

    with main.get_db() as conn:
        res = cs._resolve_runnable_worker(conn, "zxqv-nonexistent", "owner")
    assert res["ok"] is False
    assert "not found" in res["error"].lower()
    assert "run_id" not in res and "status" not in res


# ---------------------------------------------------------------------------
# #891 — chat approval decision tools (owner-scoped)
# ---------------------------------------------------------------------------

def test_891_agent_can_approve_own_run_level_approval(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs

    # Don't spawn a real e2b follow-up run; capture that approve_run drove the
    # canonical follow-up path with the owner-scoped actor. approve_run resolves
    # create_run/start_run from main's namespace (imported at module load).
    monkeypatch.setattr(main, "create_run", lambda *a, **kw: "run-followup-own")
    monkeypatch.setattr(main, "start_run", lambda *a, **kw: None)

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-appr", name="Approver")
        _seed_pending_approval(
            conn, now, approval_id="apr_own111111", run_id="run-own-1",
            owner_id="owner", worker_id="w-appr",
        )

    res = cs._tool_approvals_approve({"run_id": "run-own-1"}, "owner")
    assert res["ok"] is True
    assert res["status"] == "approved"
    # The tool reports the run that was approved (the original pending run).
    assert res["run_id"] == "run-own-1"


def test_891_agent_can_reject_own_run_by_approval_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-rej", name="Rejecter")
        _seed_pending_approval(
            conn, now, approval_id="apr_rej2222222", run_id="run-rej-1",
            owner_id="owner", worker_id="w-rej",
        )

    res = cs._tool_approvals_reject({"approval_id": "apr_rej2222222"}, "owner")
    assert res["ok"] is True
    assert res["status"] == "rejected"
    assert res["run_id"] == "run-rej-1"


def test_891_agent_cannot_approve_another_users_run(monkeypatch, tmp_path):
    """OWNER-SCOPED: a different actor cannot approve someone else's approval."""
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs

    decided: list = []
    # If owner-scoping is broken, this would be called — assert it never is.
    monkeypatch.setattr(main, "approve_run", lambda *a, **kw: decided.append(a))

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-other", name="Other", owner_id="owner")
        _seed_pending_approval(
            conn, now, approval_id="apr_other33333", run_id="run-other-1",
            owner_id="owner", worker_id="w-other",
        )

    # A DIFFERENT actor tries to approve by approval_id and by run_id.
    by_id = cs._tool_approvals_approve({"approval_id": "apr_other33333"}, "intruder")
    by_run = cs._tool_approvals_approve({"run_id": "run-other-1"}, "intruder")

    assert by_id["ok"] is False
    assert by_run["ok"] is False
    assert decided == [], "owner-scope breach: another user's approve_run was called"


def test_891_agent_can_approve_own_agent_tool_approval(monkeypatch, tmp_path):
    """kind=agent_tool approvals route to the in-place resume path, not approve_run."""
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs

    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-at", name="AgentTool")
        _seed_pending_approval(
            conn, now, approval_id="apr_at444444444", run_id="run-at-1",
            owner_id="owner", worker_id="w-at", kind="agent_tool",
        )

    res = cs._tool_approvals_approve({"approval_id": "apr_at444444444"}, "owner")
    assert res["ok"] is True
    assert res["status"] == "approved"
    assert res["run_id"] == "run-at-1"

    # The approval row is now decided — a second approve is a clean no-op error.
    res2 = cs._tool_approvals_approve({"approval_id": "apr_at444444444"}, "owner")
    assert res2["ok"] is False


def test_891_approve_requires_approval_or_run_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs
    res = cs._tool_approvals_approve({}, "owner")
    assert res["ok"] is False
    assert "approval_id or run_id" in res["error"]


def test_891_approve_nonexistent_is_clean_error(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    import chat_service as cs
    res = cs._tool_approvals_approve({"approval_id": "apr_doesnotexist"}, "owner")
    assert res["ok"] is False
    assert "run_id" not in res or not res.get("run_id")
