import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import (  # noqa: E402
    WorkerConfig,
    WorkerRuntime,
    WorkerTrigger,
    parse_worker_manifest,
    worker_contract_to_worker_config,
)
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
                "mcp": {
                    "label": "github",
                    "url": "https://api.githubcopilot.com/mcp/",
                    "auth": "bearer:GITHUB_PAT",
                    "allowed_tools": ["list_pull_requests", "get_repo"],
                    "require_approval": "never",
                }
            },
        ],
    }

    contract = parse_worker_manifest(raw)
    config = worker_contract_to_worker_config(contract, "mcp-test")

    assert config.connections[0] == "gmail"
    assert config.connections[1].mcp.label == "github"
    assert config.connections[1].mcp.allowed_tools == ["list_pull_requests", "get_repo"]
    driver = AgentDriver()
    assert driver._composio_connection_names(config) == ["gmail"]
    assert [connection.label for connection in driver._mcp_connections(config)] == ["github"]


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
