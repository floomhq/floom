"""SSRF deny-list for MCP server URLs (connections.add_mcp).

Covers the helper directly, the registration endpoint (POST /connections/mcp),
and the dial-time re-check in the agent driver.

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_mcp_url_ssrf.py -x -q
"""

import importlib
import socket
import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


AUTH_HEADERS = {"x-floom-secret": "test-secret-ssrf"}


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADERS["x-floom-secret"])
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def _addrinfo(ip: str):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr = (ip, 0, 0, 0) if family == socket.AF_INET6 else (ip, 0)
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]


# ---------------------------------------------------------------------------
# Helper unit tests
# ---------------------------------------------------------------------------

BLOCKED_LITERAL_URLS = [
    "http://169.254.169.254/latest/meta-data/",  # cloud metadata (link-local)
    "http://127.0.0.1:3000",                      # loopback
    "http://10.0.0.1",                            # RFC1918 10/8
    "http://172.16.5.4",                          # RFC1918 172.16/12
    "http://192.168.1.1",                         # RFC1918 192.168/16
    "http://[::1]:8080",                          # IPv6 loopback
    "http://[fe80::1]",                           # IPv6 link-local
    "http://[fc00::1]",                           # IPv6 unique-local
    "http://0.0.0.0:9000",                        # unspecified
]

BLOCKED_SCHEME_URLS = [
    "file:///etc/passwd",
    "gopher://127.0.0.1",
    "ftp://example.com",
]


@pytest.mark.parametrize("url", BLOCKED_LITERAL_URLS)
def test_helper_rejects_internal_literal_ips(url):
    from models import assert_safe_outbound_mcp_url, UnsafeMCPUrlError

    with pytest.raises(UnsafeMCPUrlError):
        assert_safe_outbound_mcp_url(url)


@pytest.mark.parametrize("url", BLOCKED_SCHEME_URLS)
def test_helper_rejects_disallowed_schemes(url):
    from models import assert_safe_outbound_mcp_url, UnsafeMCPUrlError

    with pytest.raises(UnsafeMCPUrlError):
        assert_safe_outbound_mcp_url(url)


def test_helper_rejects_localhost_hostname():
    from models import assert_safe_outbound_mcp_url, UnsafeMCPUrlError

    with pytest.raises(UnsafeMCPUrlError):
        assert_safe_outbound_mcp_url("http://localhost:8011")


def test_helper_rejects_hostname_resolving_to_loopback():
    """A public-looking hostname that resolves to 127.0.0.1 must be rejected."""
    from models import assert_safe_outbound_mcp_url, UnsafeMCPUrlError

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("127.0.0.1")):
        with pytest.raises(UnsafeMCPUrlError):
            assert_safe_outbound_mcp_url("https://evil.example.com")


def test_helper_rejects_hostname_resolving_to_metadata_ip():
    from models import assert_safe_outbound_mcp_url, UnsafeMCPUrlError

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("169.254.169.254")):
        with pytest.raises(UnsafeMCPUrlError):
            assert_safe_outbound_mcp_url("https://rebind.example.com")


def test_helper_allows_public_https():
    from models import assert_safe_outbound_mcp_url

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        assert (
            assert_safe_outbound_mcp_url("https://mcp.example.com")
            == "https://mcp.example.com"
        )


def test_helper_fails_closed_on_resolution_error():
    from models import assert_safe_outbound_mcp_url, UnsafeMCPUrlError

    with patch("models.socket.getaddrinfo", side_effect=socket.gaierror("no such host")):
        with pytest.raises(UnsafeMCPUrlError):
            assert_safe_outbound_mcp_url("https://does-not-resolve.example.com")


def test_helper_escape_hatch_allows_private(monkeypatch):
    from models import assert_safe_outbound_mcp_url

    monkeypatch.setenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", "1")
    # No exception even for loopback when the self-hoster opt-in is set.
    assert assert_safe_outbound_mcp_url("http://localhost:8011") == "http://localhost:8011"


# ---------------------------------------------------------------------------
# Registration endpoint: POST /connections/mcp
# ---------------------------------------------------------------------------

ENDPOINT_BLOCKED = [
    "http://169.254.169.254",
    "http://localhost:8011",
    "http://10.0.0.1",
    "http://192.168.1.1",
]


@pytest.mark.parametrize("url", ENDPOINT_BLOCKED)
def test_create_mcp_connection_rejects_internal_url(monkeypatch, tmp_path, url):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)

    resp = client.post(
        "/connections/mcp",
        json={"label": "evil", "transport": "streamable_http", "url": url},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 400, resp.text
    assert "not allowed" in resp.text.lower()


def test_create_mcp_connection_rejects_bad_scheme(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)

    resp = client.post(
        "/connections/mcp",
        json={"label": "evil", "transport": "streamable_http", "url": "file:///etc/passwd"},
        headers=AUTH_HEADERS,
    )
    # Rejected either by the http(s) prefix check or the SSRF scheme check.
    assert resp.status_code == 400, resp.text


def test_create_mcp_connection_accepts_public_https(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        resp = client.post(
            "/connections/mcp",
            json={
                "label": "good",
                "transport": "streamable_http",
                "url": "https://mcp.example.com",
            },
            headers=AUTH_HEADERS,
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mcp_url"] == "https://mcp.example.com"


def test_create_mcp_connection_stdio_unaffected(monkeypatch, tmp_path):
    """stdio transport has no URL — SSRF check must not break it."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)

    resp = client.post(
        "/connections/mcp",
        json={
            "label": "localcli",
            "transport": "stdio",
            "command": "my-mcp-server",
            "args": ["--flag"],
        },
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Dial-time re-check in the agent driver
# ---------------------------------------------------------------------------

def test_dial_time_rejects_rebound_internal_url():
    """_make_mcp_server must refuse a URL that now resolves to an internal IP,
    even if it passed registration earlier (DNS rebinding defense)."""
    from runner_sandbox.agent_driver import AgentDriver, _MCPConnectionError

    class _Conn:
        label = "rebound"
        transport = "streamable_http"
        url = "https://rebind.example.com"
        allowed_tools = None
        require_approval = "never"
        auth = None
        env = {}

    driver = AgentDriver.__new__(AgentDriver)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("169.254.169.254")):
        with pytest.raises(_MCPConnectionError):
            driver._make_mcp_server(_Conn(), {})
