#!/usr/bin/env python3
"""Live MCP parity checks for Workeros Remote MCP.

Defaults to production. Override with:
  MCP_BASE_URL=http://127.0.0.1:8011/api/mcp
  MCP_API_KEY=...
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8000/api/mcp")
API_KEY = (
    os.environ.get("MCP_API_KEY")
    or os.environ.get("WORKSPACE_AGENT_MCP_TOKEN")
    or os.environ.get("LANGDOCK_WORKEROS_MCP_TOKEN")
)
TIMEOUT_SECONDS = int(os.environ.get("MCP_TEST_TIMEOUT_SECONDS", "90"))
EXPECTED_TOOL = "ask_workspace_agent"
EXPECTED_TOOLS = {
    EXPECTED_TOOL,
    "workers.list",
    "workers.create",
    "workers.update",
    "workers.run",
    "runs.list",
    "runs.watch",
    "secrets.list",
    "secrets.set",
    "connections.add_mcp",
    "contexts.read",
    "contexts.write",
}


def request_json(method: str = "GET", body: dict | None = None, api_key: str | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    req = urllib.request.Request(BASE_URL, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise AssertionError(f"{method} {BASE_URL} HTTP {exc.code}: {detail}") from exc


def rpc(method: str, params: dict | None = None, rpc_id: int | str = 1) -> dict:
    if not API_KEY:
        raise AssertionError("Set MCP_API_KEY or WORKSPACE_AGENT_MCP_TOKEN for authenticated MCP checks")
    payload = {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": method,
        "params": params or {},
    }
    response = request_json(method="POST", body=payload, api_key=API_KEY)
    if response.get("error"):
        raise AssertionError(f"{method} JSON-RPC error: {response['error']}")
    return response["result"]


def assert_discovery() -> None:
    payload = request_json()
    assert payload["name"] == "workeros", payload
    assert payload["protocol"] == "2024-11-05", payload
    assert payload["transport"] == "streamable-http", payload
    missing = EXPECTED_TOOLS - set(payload["tools"])
    assert not missing, f"discovery missing tools {sorted(missing)}: {payload}"
    print(f"PASS discovery: {payload['endpoint']} exposes {len(payload['tools'])} Workeros tools")


def assert_initialize() -> None:
    result = rpc("initialize", rpc_id=10)
    assert result["serverInfo"]["name"] == "workeros", result
    assert "tools" in result["capabilities"], result
    print("PASS initialize: server info and tools capability returned")


def assert_tools_list() -> None:
    result = rpc("tools/list", rpc_id=20)
    tools = result.get("tools", [])
    names = {item.get("name") for item in tools}
    missing = EXPECTED_TOOLS - names
    assert not missing, f"tools/list missing tools {sorted(missing)}: {tools}"
    tool = next((item for item in tools if item.get("name") == EXPECTED_TOOL), None)
    assert tool, f"{EXPECTED_TOOL} missing from tools/list: {tools}"
    schema = tool.get("inputSchema", {})
    assert schema.get("required") == ["message"], schema
    assert "conversation_id" in schema.get("properties", {}), schema
    print("PASS tools/list: remote Workeros control-plane tools returned")


def assert_direct_read_tool() -> None:
    result = rpc(
        "tools/call",
        {"name": "workers.list", "arguments": {}},
        rpc_id=25,
    )
    if result.get("isError"):
        raise AssertionError(f"workers.list returned isError: {result}")
    assert "structuredContent" in result, result
    assert "content" in result, result
    print("PASS workers.list: direct remote MCP read tool returned structured content")


def assert_tool_call() -> None:
    result = rpc(
        "tools/call",
        {
            "name": EXPECTED_TOOL,
            "arguments": {
                "message": "Integration smoke test. Reply exactly: WORKEROS_MCP_OK",
                "conversation_id": "parity-smoke",
            },
        },
        rpc_id=30,
    )
    if result.get("isError"):
        raise AssertionError(f"tools/call returned isError: {result}")
    text_blocks = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    if not text_blocks:
        raise AssertionError(f"tools/call returned no text content: {result}")
    assert "WORKEROS_MCP_OK" in text_blocks[0], f"unexpected workspace-agent reply: {text_blocks[0]!r}"
    assert result.get("structuredContent", {}).get("conversation_id") == "langdock:parity-smoke", result
    print("PASS tools/call: workspace agent returned expected smoke-test text")


def main() -> int:
    print(f"Testing Workeros MCP endpoint: {BASE_URL}")
    assert_discovery()
    assert_initialize()
    assert_tools_list()
    assert_direct_read_tool()
    assert_tool_call()
    print("PASS all Workeros MCP parity checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
