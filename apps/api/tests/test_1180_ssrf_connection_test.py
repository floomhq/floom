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


def test_connection_test_pins_url_before_dial():
    """test_connection handler must pin the URL before creating the httpx client."""
    import inspect
    import importlib

    for m in list(sys.modules):
        if m in ("routers.connections",) or m.startswith("routers.connections"):
            sys.modules.pop(m, None)

    import routers.connections as conn_mod

    src = inspect.getsource(conn_mod.test_connection)

    assert "pinned_safe_outbound_httpx_target" in src, (
        "#1180/#1293 regression: MCP URL is not re-validated and DNS-pinned "
        "before dial (SSRF)."
    )
    pin_pos = src.find("pinned_safe_outbound_httpx_target")
    dial_pos = src.find("_httpx.Client")
    assert pin_pos < dial_pos, (
        "#1293: pinned_safe_outbound_httpx_target must run before httpx connects."
    )
