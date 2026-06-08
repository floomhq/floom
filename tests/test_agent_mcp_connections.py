import asyncio
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import (  # noqa: E402
    WorkerConfig,
    WorkerRuntime,
    WorkerTrigger,
    declared_composio_connection_scopes,
    declared_composio_connections,
    parse_worker_manifest,
    read_only_preset_for_app,
    worker_contract_to_worker_config,
)
from runner_sandbox import agent_capabilities as cap  # noqa: E402
from runner_sandbox.agent_driver import AgentDriver, _MCPConnectionError  # noqa: E402


def _config(connections):
    return WorkerConfig(
        id="mcp-test",
        name="MCP Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="skill", entrypoint="SKILL.md", runner="e2b", mode="agent"),
        connections=connections,
        outputs=[],
    )


def test_mcp_connection_schema_preserves_legacy_composio_strings():
    raw = {
        "schema_version": "0.3",
        "name": "mcp-test",
        "title": "MCP Test",
        "description": "Test MCP connection schema.",
        "version": "0.1.0",
        "exec": {"entry": "SKILL.md", "runtime": "skill"},
        "connections": [
            "gmail",
            {
                "app": "google_search_console",
                "allowed_tools": ["GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY"],
            },
            {
                "mcp": {
                    "label": "github",
                    "url": "https://api.githubcopilot.com/mcp/",
                    "auth": "bearer:GITHUB_PAT",
                    "allowed_tools": ["list_pull_requests", "get_repo"],
                    "require_approval": "never",
                }
            },
            {
                "mcp": {
                    "label": "filesystem",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
                    "env": {"GITHUB_TOKEN": "secret:GITHUB_PAT"},
                }
            },
        ],
    }

    with pytest.warns(DeprecationWarning, match="Legacy Composio connection strings are deprecated"):
        contract = parse_worker_manifest(raw)
    config = worker_contract_to_worker_config(contract, "mcp-test")

    assert config.connections[0] == "gmail"
    assert config.connections[1].composio.app == "google_search_console"
    assert config.connections[1].composio.allowed_tools == ["GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY"]
    assert config.connections[2].mcp.label == "github"
    assert config.connections[2].mcp.allowed_tools == ["list_pull_requests", "get_repo"]
    assert config.connections[3].mcp.label == "filesystem"
    assert config.connections[3].mcp.transport == "stdio"
    assert config.connections[3].mcp.command == "npx"
    assert declared_composio_connections(config) == {
        "gmail": sorted(read_only_preset_for_app("gmail")),
        "google_search_console": ["GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY"],
    }
    assert declared_composio_connection_scopes(config) == {
        "gmail": ["read_only"],
        "google_search_console": ["full"],
    }
    allowed, _, _ = cap.composio_tool_permitted(
        config,
        cap.WORKER_POLICY,
        "gmail",
        "GMAIL_FETCH_EMAILS",
    )
    assert allowed is True
    blocked, _, blocked_code = cap.composio_tool_permitted(
        config,
        cap.WORKER_POLICY,
        "gmail",
        "GMAIL_SEND_EMAIL",
    )
    assert blocked is False
    assert blocked_code == "tool_outside_connection_scope"
    driver = AgentDriver()
    assert driver._composio_connection_names(config) == ["gmail", "google_search_console"]
    assert [connection.label for connection in driver._mcp_connections(config)] == ["github", "filesystem"]


def test_mcp_server_compilation_uses_bearer_secret_and_tool_filter():
    config = _config([
        {
            "mcp": {
                "label": "github",
                "url": "https://api.githubcopilot.com/mcp/",
                "auth": "bearer:GITHUB_PAT",
                "allowed_tools": ["list_pull_requests"],
            }
        }
    ])

    server = AgentDriver()._make_mcp_server(config.connections[0].mcp, {"GITHUB_PAT": "token-123"})

    assert server.name == "github"
    assert server.params["url"] == "https://api.githubcopilot.com/mcp/"
    assert server.params["headers"] == {"Authorization": "Bearer token-123"}
    assert server.tool_filter == {"allowed_tool_names": ["list_pull_requests"]}
    assert server.cache_tools_list is True


def test_mcp_server_missing_secret_is_a_connect_failure():
    config = _config([
        {
            "mcp": {
                "label": "github",
                "url": "https://api.githubcopilot.com/mcp/",
                "auth": "bearer:GITHUB_PAT",
            }
        }
    ])

    with pytest.raises(_MCPConnectionError, match="missing secret GITHUB_PAT"):
        AgentDriver()._make_mcp_server(config.connections[0].mcp, {})


def test_stdio_mcp_server_compilation_uses_secret_env():
    config = _config([
        {
            "mcp": {
                "label": "filesystem",
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
                "env": {"GITHUB_TOKEN": "secret:GITHUB_PAT", "MODE": "readonly"},
                "cwd": "/workspace",
                "allowed_tools": ["read_file"],
            }
        }
    ])

    server = AgentDriver()._make_mcp_server(config.connections[0].mcp, {"GITHUB_PAT": "token-123"})

    assert server.name == "filesystem"
    assert server.params.command == "npx"
    assert server.params.args == ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    assert server.params.env == {"GITHUB_TOKEN": "token-123", "MODE": "readonly"}
    assert server.params.cwd == "/workspace"
    assert server.tool_filter == {"allowed_tool_names": ["read_file"]}


def test_mcp_connect_and_cleanup_lifecycle():
    config = _config([
        {"mcp": {"label": "github", "url": "https://api.githubcopilot.com/mcp/"}},
        {"mcp": {"label": "perplexity", "url": "https://mcp.perplexity.ai/"}},
    ])
    events = []

    class FakeServer:
        def __init__(self, name):
            self.name = name

        async def connect(self):
            events.append(("connect", self.name))

        async def cleanup(self):
            events.append(("cleanup", self.name))

    class Driver(AgentDriver):
        def _make_mcp_server(self, connection, secrets):
            return FakeServer(connection.label)

    driver = Driver()
    logs = []
    servers = asyncio.run(driver._connect_mcp_servers(config, {}, lambda msg, level="info": logs.append((level, msg))))
    asyncio.run(driver._cleanup_mcp_servers(servers, lambda msg, level="info": logs.append((level, msg))))

    assert events == [
        ("connect", "github"),
        ("connect", "perplexity"),
        ("cleanup", "perplexity"),
        ("cleanup", "github"),
    ]


def test_stock_workers_use_structured_composio_allowlists():
    for path in sorted((ROOT / "workers").glob("*/worker.yml")):
        raw = yaml.safe_load(path.read_text())
        if not isinstance(raw, dict):
            continue
        connections = raw.get("connections") or []
        assert all(not isinstance(connection, str) for connection in connections), path
