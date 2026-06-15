"""#1180 — SSRF via POST /connections/{id}/test.

The stored mcp_url must be re-validated with assert_safe_outbound_mcp_url()
immediately before each outbound probe, preventing DNS rebinding or
admin-side URL mutation from causing SSRF.
"""
from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_connection_test_revalidates_url_before_dial():
    """test_connection handler must call assert_safe_outbound_mcp_url before httpx.post."""
    import ast
    import inspect
    import importlib

    for m in list(sys.modules):
        if m in ("routers.connections",) or m.startswith("routers.connections"):
            sys.modules.pop(m, None)

    import routers.connections as conn_mod

    src = inspect.getsource(conn_mod.test_connection)

    # assert_safe_outbound_mcp_url must be called inside test_connection
    assert "assert_safe_outbound_mcp_url" in src, (
        "#1180 regression: assert_safe_outbound_mcp_url not called in test_connection. "
        "MCP URL is not re-validated before dial (SSRF)."
    )
    # It must appear BEFORE httpx.post
    ssrf_pos = src.find("assert_safe_outbound_mcp_url")
    dial_pos = src.find("_httpx.post(probe_url")
    assert ssrf_pos < dial_pos, (
        "#1180: assert_safe_outbound_mcp_url must appear before httpx.post in test_connection."
    )
