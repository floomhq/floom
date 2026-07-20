"""#2271 — approvals.approve / approvals.reject on the workspace-agent remote
MCP surface (_call_workeros_remote_mcp_tool).

Surfaces 1 (_MCP_DEFAULT_TOOLS cloud registry) and 3 (apps/mcp/src/server.ts)
already exposed these tools; this file covers the third surface added for #2271
and proves it enforces the SAME owner-scoped decision path as the chat tool and
the POST /runs/{id}/approve REST endpoint:

  - approve a pending run   -> proceeds (decision recorded)
  - reject with a reason    -> rejected, reason recorded
  - another workspace's run  -> denied, canonical approve_run never called
  - nonexistent id           -> clear isError result, never a silent success
  - a rejection reason is passed through (defaults when omitted)

Run: cd apps/api && python -m pytest tests/test_2271_approvals_mcp_remote_surface.py -q
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from pathlib import Path

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
        monkeypatch.setitem(
            _factory._repositories_factories, deploy, _factory._local_repositories
        )
        _factory.get_repositories.cache_clear()
    return main


def _seed_worker(conn, now, *, worker_id: str, name: str, owner_id: str = "owner") -> None:
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


def _set_actor(main, user_id: str) -> None:
    main.set_current_auth_context(
        main.AuthContext(user_id=user_id, email=None, scopes=("admin", "mcp"))
    )


def _call(main, tool_name: str, arguments: dict) -> dict:
    return asyncio.run(main._call_workeros_remote_mcp_tool(tool_name, arguments))


# ---------------------------------------------------------------------------

def test_2271_remote_surface_advertises_and_gates_tools(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    names = {t["name"] for t in main._workeros_remote_mcp_tool_definitions()}
    assert "approvals.approve" in names
    assert "approvals.reject" in names
    # Served on this surface (added to the lean remote definition set).
    assert main._mcp_tool_served("approvals.approve") is True
    assert main._mcp_tool_served("approvals.reject") is True
    # Still admin-gated, exactly like the other MCP surfaces.
    member = main.AuthContext(user_id="m", email=None, scopes=("member",), role="member")
    assert member.is_admin is False
    assert "admin" in (main._mcp_access_error("approvals.approve", member) or "")


def test_2271_remote_approve_owns_run_proceeds(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-a", name="A")
        _seed_pending_approval(
            conn, now, approval_id="apr_ok1111111", run_id="run-ok-1",
            owner_id="owner", worker_id="w-a",
        )
    _set_actor(main, "owner")
    res = _call(main, "approvals.approve", {"run_id": "run-ok-1"})
    assert not res.get("isError"), res
    assert res["structuredContent"]["ok"] is True
    assert res["structuredContent"]["status"] == "approved"
    # Decision recorded end-to-end on the approval row.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status FROM approvals WHERE id = ?", ("apr_ok1111111",)
        ).fetchone()
    assert row["status"] == "approved"


def test_2271_remote_reject_records_reason(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-r", name="R")
        _seed_pending_approval(
            conn, now, approval_id="apr_rj2222222", run_id="run-rj-1",
            owner_id="owner", worker_id="w-r",
        )
    _set_actor(main, "owner")
    res = _call(main, "approvals.reject", {"run_id": "run-rj-1", "reason": "do not send this"})
    assert not res.get("isError"), res
    assert res["structuredContent"]["ok"] is True
    assert res["structuredContent"]["status"] == "rejected"
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT * FROM approvals WHERE id = ?", ("apr_rj2222222",)
        ).fetchone()
    assert row["status"] == "rejected"
    recorded = " ".join(str(row[k]) for k in row.keys() if row[k] is not None)
    assert "do not send this" in recorded, "caller reason was not recorded"


def test_2271_remote_reject_defaults_reason_when_omitted(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-r2", name="R2")
        _seed_pending_approval(
            conn, now, approval_id="apr_rj3333333", run_id="run-rj-2",
            owner_id="owner", worker_id="w-r2",
        )
    _set_actor(main, "owner")
    res = _call(main, "approvals.reject", {"run_id": "run-rj-2"})
    assert not res.get("isError"), res
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT * FROM approvals WHERE id = ?", ("apr_rj3333333",)
        ).fetchone()
    recorded = " ".join(str(row[k]) for k in row.keys() if row[k] is not None)
    assert "Rejected via chat by owner" in recorded


def test_2271_remote_cannot_approve_another_workspaces_run(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, deploy="cloud")
    decided: list = []
    # If owner-scoping were bypassed, the canonical approve_run would fire.
    monkeypatch.setattr(main, "approve_run", lambda *a, **kw: decided.append(a))
    with main.get_db() as conn:
        now = main.now_iso()
        _seed_worker(conn, now, worker_id="w-o", name="Owned", owner_id="owner")
        _seed_pending_approval(
            conn, now, approval_id="apr_other44444", run_id="run-other-1",
            owner_id="owner", worker_id="w-o",
        )
    # A DIFFERENT workspace principal tries to approve the owner's run.
    _set_actor(main, "intruder")
    by_run = _call(main, "approvals.approve", {"run_id": "run-other-1"})
    by_id = _call(main, "approvals.approve", {"approval_id": "apr_other44444"})
    assert by_run.get("isError") is True
    assert by_id.get("isError") is True
    assert decided == [], "owner-scope breach: another workspace's approve_run was called"
    # The approval must still be pending — nothing was decided.
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT status FROM approvals WHERE id = ?", ("apr_other44444",)
        ).fetchone()
    assert row["status"] == "pending"


def test_2271_remote_nonexistent_id_is_clear_error(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    _set_actor(main, "owner")
    res = _call(main, "approvals.approve", {"run_id": "run-does-not-exist"})
    assert res.get("isError") is True
    text = res["content"][0]["text"]
    assert text and "run-does-not-exist" in text
