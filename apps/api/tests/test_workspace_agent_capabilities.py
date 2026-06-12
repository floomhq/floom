"""The interactive workspace agent gets brain + read-only connections at runtime.

Closes the promise-vs-reality gap: the /assistant UI claims it "shares your
Brain and Connections", but ``chat_service.stream_chat`` previously gave the
workspace agent only workspace tools + WebSearch + finish. These tests prove the
shared capability builder (``runner_sandbox.agent_capabilities``) now backs BOTH
the autonomous worker driver and the interactive assistant, with the assistant
gated to read-only connections by ``WORKSPACE_AGENT_POLICY``.

Covered:
- read-only Composio tools are exposed; mutating ones are NOT advertised/executed,
- registered MCP connections become approval-gated dialled servers,
- brain packs are staged read-only and exposed via brain__read,
- owner-scope (a tenant only sees ITS packs/connections),
- SSRF guard on MCP URLs carries over,
- a clean workspace (no connections, no brain) still works.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def env(monkeypatch, tmp_path):
    contexts_dir = tmp_path / "contexts"
    artifacts_dir = tmp_path / "artifacts"
    workers_dir = tmp_path / "workers"
    for path in (contexts_dir, artifacts_dir, workers_dir):
        path.mkdir()

    # Owner-scoped brain packs: alice has one, bob has a same-named different one.
    alice_pack = contexts_dir / "alice" / "playbook"
    alice_pack.mkdir(parents=True)
    (alice_pack / "intro.md").write_text("# Alice playbook\nclose deals.\n", encoding="utf-8")
    bob_pack = contexts_dir / "bob" / "playbook"
    bob_pack.mkdir(parents=True)
    (bob_pack / "intro.md").write_text("BOB SECRET\n", encoding="utf-8")

    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)

    import contexts as contexts_mod
    import runner_utils as runner_utils_mod
    importlib.reload(contexts_mod)
    importlib.reload(runner_utils_mod)
    from runner_sandbox import agent_capabilities as cap_mod
    importlib.reload(cap_mod)

    yield {
        "cap": cap_mod,
        "contexts_dir": contexts_dir,
        "artifacts_dir": artifacts_dir,
        "tmp_path": tmp_path,
    }

    importlib.reload(contexts_mod)
    importlib.reload(runner_utils_mod)
    importlib.reload(cap_mod)


def _log(_msg, _level="info"):
    return None


def _config_with(connections=None, contexts=None):
    from models import (
        WorkerConfig,
        WorkerOutput,
        WorkerRuntime,
        WorkerTrigger,
    )

    return WorkerConfig(
        id="workspace-agent",
        name="workspace-agent",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="agent", entrypoint="SKILL.md", runner="e2b", mode="agent"),
        connections=connections or [],
        contexts=contexts or [],
        outputs=[WorkerOutput(name="reply", label="Reply", type="markdown", required=True)],
    )


def _composio_conn(app, scope=None):
    from models import WorkerComposioConnection, WorkerConnection

    return WorkerConnection(composio=WorkerComposioConnection(app=app, scope=scope))


# ---------------------------------------------------------------------------
# Composio read-only gating
# ---------------------------------------------------------------------------

def test_readonly_policy_exposes_composio_tool_but_blocks_mutations(env):
    cap = env["cap"]
    config = _config_with(connections=[_composio_conn("gmail")])

    # The execute tool IS exposed (assistant CAN read the connection).
    schemas = cap.composio_tool_schemas(config, cap.WORKSPACE_AGENT_POLICY)
    names = {s["function"]["name"] for s in schemas}
    assert "composio__gmail__execute" in names
    # Description signals read-only.
    desc = next(s["function"]["description"] for s in schemas if s["function"]["name"] == "composio__gmail__execute")
    assert "Read-only" in desc

    # Read tool permitted; mutating tool refused under read-only policy.
    ok, _, _ = cap.composio_tool_permitted(config, cap.WORKSPACE_AGENT_POLICY, "gmail", "GMAIL_FETCH_EMAILS")
    assert ok is True
    blocked, msg, code = cap.composio_tool_permitted(
        config, cap.WORKSPACE_AGENT_POLICY, "gmail", "GMAIL_SEND_EMAIL"
    )
    assert blocked is False
    assert code in {"tool_blocked_by_read_only_policy", "tool_requires_approval"}


def test_worker_policy_allows_mutation_full_scope(env):
    """Autonomous workers under WORKER_POLICY keep full (declared) scope —
    the read-only gate is assistant-only, not a regression for workers."""
    cap = env["cap"]
    config = _config_with(connections=[_composio_conn("gmail")])  # default full scope
    ok, _, _ = cap.composio_tool_permitted(config, cap.WORKER_POLICY, "gmail", "GMAIL_SEND_EMAIL")
    assert ok is True


def test_execute_refuses_mutation_before_any_http(env, monkeypatch):
    """A mutating Composio call is refused by policy BEFORE any network/secret
    resolution — the interactive assistant can never silently mutate."""
    cap = env["cap"]
    config = _config_with(connections=[_composio_conn("gmail")])

    import requests

    def _boom(*_a, **_k):  # pragma: no cover - must never be reached
        raise AssertionError("Composio HTTP must not be called for a blocked tool")

    monkeypatch.setattr(requests, "post", _boom)
    monkeypatch.setenv("COMPOSIO_API_KEY", "x")

    result = cap.composio_execute(
        name="composio__gmail__execute",
        args={"tool": "GMAIL_SEND_EMAIL", "arguments": {}},
        config=config,
        policy=cap.WORKSPACE_AGENT_POLICY,
        connection_ids={"gmail": "conn_1"},
        user_id="alice",
        log_fn=_log,
    )
    assert result["ok"] is False
    assert result["error_code"] in {"tool_blocked_by_read_only_policy", "tool_requires_approval"}


# ---------------------------------------------------------------------------
# MCP wiring (SSRF + approval gate)
# ---------------------------------------------------------------------------

def test_mcp_server_approval_forced_for_workspace_agent(env, monkeypatch):
    cap = env["cap"]
    from models import WorkerMCPConnection

    captured = {}

    class _FakeServer:
        def __init__(self, *, params, name, cache_tools_list, tool_filter, require_approval):
            captured["require_approval"] = require_approval
            captured["url"] = params.get("url")
            captured["headers"] = params.get("headers")

    import agents.mcp as mcp_mod
    monkeypatch.setattr(mcp_mod, "MCPServerStreamableHttp", _FakeServer)

    conn = WorkerMCPConnection(
        label="mymcp", url="https://example.com/mcp", auth="bearer:MCP_TOKEN"
    )
    cap.make_mcp_server(conn, {"MCP_TOKEN": "secret-value"}, cap.WORKSPACE_AGENT_POLICY)
    assert captured["require_approval"] == "always"
    # Bearer secret is injected as a header, never inlined into args.
    assert captured["headers"]["Authorization"] == "Bearer secret-value"


def test_mcp_ssrf_guard_blocks_internal_url(env, monkeypatch):
    cap = env["cap"]
    from models import WorkerMCPConnection

    conn = WorkerMCPConnection(label="evil", url="http://169.254.169.254/latest")
    with pytest.raises(cap.MCPConnectionError):
        cap.make_mcp_server(conn, {}, cap.WORKSPACE_AGENT_POLICY)


def test_mcp_missing_secret_raises(env):
    cap = env["cap"]
    from models import WorkerMCPConnection

    conn = WorkerMCPConnection(label="m", url="https://example.com/mcp", auth="bearer:MISSING")
    with pytest.raises(cap.MCPConnectionError):
        cap.make_mcp_server(conn, {}, cap.WORKSPACE_AGENT_POLICY)


# ---------------------------------------------------------------------------
# Brain staging (owner-scoped, read-only)
# ---------------------------------------------------------------------------

def test_brain_staged_owner_scoped(env):
    cap = env["cap"]
    artifacts_dir = env["artifacts_dir"]
    config = _config_with(contexts=[{"name": "playbook", "source": "local"}])

    root_alice = artifacts_dir / "alice" / "context"
    root_alice.mkdir(parents=True)
    staged = cap.stage_context_packs(
        config=config, context_root=root_alice, user_id="alice", log_fn=_log
    )
    assert staged == ["playbook"]
    assert (root_alice / "playbook" / "intro.md").read_text() == "# Alice playbook\nclose deals.\n"

    # Bob staging the same-named pack gets BOB's content, never alice's.
    root_bob = artifacts_dir / "bob" / "context"
    root_bob.mkdir(parents=True)
    cap.stage_context_packs(
        config=config, context_root=root_bob, user_id="bob", log_fn=_log
    )
    assert (root_bob / "playbook" / "intro.md").read_text() == "BOB SECRET\n"


def test_clean_workspace_no_capabilities(env):
    """A clean workspace (no connections, no brain) still works: empty tool
    sets, no MCP, no crash."""
    cap = env["cap"]
    config = _config_with()
    assert cap.composio_tool_schemas(config, cap.WORKSPACE_AGENT_POLICY) == []
    assert cap.mcp_connections(config) == []
    assert cap.stage_context_packs(
        config=config, context_root=env["artifacts_dir"], user_id="alice", log_fn=_log
    ) == []


# ---------------------------------------------------------------------------
# chat_service integration: synthetic config from DB-registered connections
# ---------------------------------------------------------------------------

@pytest.fixture()
def chat_env(monkeypatch, tmp_path):
    contexts_dir = tmp_path / "contexts"
    workers_dir = tmp_path / "workers"
    artifacts_dir = tmp_path / "artifacts"
    for path in (contexts_dir, workers_dir, artifacts_dir):
        path.mkdir()
    # Single-tenant (no header scope): packs live directly under CONTEXTS_DIR.
    pack = contexts_dir / "playbook"
    pack.mkdir()
    (pack / "intro.md").write_text("# Playbook\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.delenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", raising=False)

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "contexts", "chat_service",
        "runner_sandbox.agent_capabilities",
    ]:
        sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith("routers")]:
            sys.modules.pop(_rn, None)

    import contexts as contexts_mod  # noqa: F401
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    chat = importlib.import_module("chat_service")

    yield {"db": db, "chat": chat}

    db.get_repositories.cache_clear()


def test_build_config_maps_db_connections(chat_env):
    db = chat_env["db"]
    chat = chat_env["chat"]
    repos = db.get_repositories()

    # Active Composio app + active registered MCP + an INACTIVE composio (excluded).
    repos.connections.upsert(
        user_id="federico", id="c1", app_name="gmail",
        composio_connection_id="ca_x", status="active",
    )
    repos.connections.upsert(
        user_id="federico", id="m1", app_name="notionmcp", kind="mcp",
        composio_connection_id="m1", status="active",
        mcp_label="notion", mcp_url="https://mcp.example.com/sse",
        mcp_transport="sse",
    )
    repos.connections.upsert(
        user_id="federico", id="c2", app_name="slack",
        composio_connection_id="ca_y", status="revoked",
    )

    config = chat.build_workspace_agent_config("federico")

    from models import declared_composio_connections
    from runner_sandbox import agent_capabilities as cap

    # Composio: gmail present (read-only scope), slack absent (inactive).
    declared = declared_composio_connections(config)
    assert "gmail" in declared
    assert "slack" not in declared

    # MCP: notion dialled spec present.
    mcps = cap.mcp_connections(config)
    assert [m.label for m in mcps] == ["notion"]
    assert mcps[0].transport == "sse"

    # Brain pack attached.
    assert [getattr(c, "name", None) for c in config.contexts] == ["playbook"]

    # Read-only enforced on the synthetic config: gmail send blocked.
    ok, _, _ = cap.composio_tool_permitted(config, cap.WORKSPACE_AGENT_POLICY, "gmail", "GMAIL_SEND_EMAIL")
    assert ok is False


def test_build_config_respects_connection_permission_flags(chat_env):
    db = chat_env["db"]
    chat = chat_env["chat"]
    repos = db.get_repositories()
    repos.connections.upsert(
        user_id="federico", id="c1", app_name="gmail",
        composio_connection_id="ca_x", status="active",
    )

    disabled = chat.build_workspace_agent_config(
        "federico",
        {
            "brain_read": True,
            "brain_write": False,
            "connections_read": False,
            "connections_use": False,
            "connections_add": False,
        },
    )
    from models import declared_composio_connections
    assert declared_composio_connections(disabled) == {}

    writable = chat.build_workspace_agent_config(
        "federico",
        {
            "brain_read": True,
            "brain_write": False,
            "connections_read": True,
            "connections_use": True,
            "connections_add": False,
        },
    )
    from runner_sandbox import agent_capabilities as cap
    ok, _, _ = cap.composio_tool_permitted(
        writable,
        chat._workspace_agent_policy({"connections_use": True}),
        "gmail",
        "GMAIL_SEND_EMAIL",
    )
    assert ok is True


def test_tool_metadata_includes_brain_and_composio(chat_env):
    db = chat_env["db"]
    chat = chat_env["chat"]
    repos = db.get_repositories()
    repos.connections.upsert(
        user_id="federico", id="c1", app_name="gmail",
        composio_connection_id="ca_x", status="active",
    )

    meta = chat.workspace_agent_tool_metadata("federico")
    names = {m["name"] for m in meta}
    # Management tools + brain read tools + composio read tool all advertised.
    assert "workers__list_all" in names
    assert "brain__list" in names
    assert "brain__read" in names
    assert "composio__gmail__execute" in names
