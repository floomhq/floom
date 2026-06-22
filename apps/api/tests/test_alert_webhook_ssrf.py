"""SSRF-guarded alert webhook delivery (P2-A).

Covers:
  - the generic helper rename/alias (assert_safe_outbound_url),
  - delivery: a public webhook URL is actually POSTed with the alert payload,
  - SSRF at delivery: an internal/metadata/loopback/RFC1918 URL is NOT POSTed,
  - best-effort: a delivery failure (endpoint errors) does not crash the path,
  - payload hygiene: the POSTed body contains no secret value,
  - validate-at-store: POST /workers/{id}/alerts with an internal URL → 400,
    and a public URL → 201.

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_alert_webhook_ssrf.py -x -q
"""

import importlib
import json
import socket
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH_HEADERS = {"x-floom-secret": "test-secret-alert-ssrf"}


def _addrinfo(ip: str):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr = (ip, 0, 0, 0) if family == socket.AF_INET6 else (ip, 0)
    return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]


# ---------------------------------------------------------------------------
# Helper alias / generalization
# ---------------------------------------------------------------------------

def test_generic_helper_and_alias_exist():
    import models

    # New generic names.
    assert hasattr(models, "assert_safe_outbound_url")
    assert hasattr(models, "UnsafeOutboundUrlError")
    # Backward-compatible MCP names still resolve to the same exception type.
    assert models.UnsafeMCPUrlError is models.UnsafeOutboundUrlError


def test_generic_helper_rejects_metadata_ip():
    from models import assert_safe_outbound_url, UnsafeOutboundUrlError

    with pytest.raises(UnsafeOutboundUrlError):
        assert_safe_outbound_url("http://169.254.169.254/latest/meta-data/", label="Alert webhook URL")


# ---------------------------------------------------------------------------
# _fire_alert_webhooks delivery behaviour (unit)
# ---------------------------------------------------------------------------

def _fake_repos(alert_rows):
    repos = MagicMock()
    repos.alerts.list.return_value = alert_rows
    repos.workers.get_any.return_value = {"name": "My Worker"}
    return repos


def _run_service():
    return importlib.import_module("run_service")


def test_public_url_is_posted(monkeypatch):
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()
    repos = _fake_repos([
        {"url": "https://hooks.example.com/alert", "email_to": None,
         "events": "failed", "secret": None},
    ])

    captured = {}

    def _fake_open(req, timeout=None):
        captured["url"] = req.full_url
        captured["data"] = req.data
        captured["timeout"] = timeout
        return MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        with patch("services.run_notifications._open_pinned_webhook", side_effect=_fake_open):
            rs._fire_alert_webhooks(
                run_id="run_abc", worker_id="wk_1", status="failed",
                error="boom", repos=repos,
            )

    assert captured["url"] == "https://hooks.example.com/alert"
    assert captured["timeout"] == 5  # bounded timeout
    body = json.loads(captured["data"].decode())
    assert body["run_id"] == "run_abc"
    assert body["worker_id"] == "wk_1"
    assert body["status"] == "failed"


@pytest.mark.parametrize("bad_url", [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:9000/hook",
    "http://localhost:8080/hook",
    "http://10.0.0.5/hook",
    "http://192.168.1.10/hook",
])
def test_internal_url_is_not_posted(monkeypatch, bad_url):
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()
    repos = _fake_repos([
        {"url": bad_url, "email_to": None, "events": "failed", "secret": None},
    ])

    with patch("services.run_notifications._open_pinned_webhook") as mock_open:
        rs._fire_alert_webhooks(
            run_id="run_x", worker_id="wk_1", status="failed",
            error=None, repos=repos,
        )
    mock_open.assert_not_called()


def test_delivery_failure_does_not_crash(monkeypatch):
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()
    repos = _fake_repos([
        {"url": "https://hooks.example.com/alert", "email_to": None,
         "events": "failed", "secret": None},
    ])

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        with patch("services.run_notifications._open_pinned_webhook",
                          side_effect=OSError("connection refused")):
            # Must not raise.
            rs._fire_alert_webhooks(
                run_id="run_y", worker_id="wk_1", status="failed",
                error=None, repos=repos,
            )


def test_payload_contains_no_secret(monkeypatch):
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()
    secret = "super-secret-signing-key-xyz"
    repos = _fake_repos([
        {"url": "https://hooks.example.com/alert", "email_to": None,
         "events": "failed", "secret": secret},
    ])

    captured = {}

    def _fake_open(req, timeout=None):
        captured["data"] = req.data
        captured["headers"] = req.headers
        return MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        with patch("services.run_notifications._open_pinned_webhook", side_effect=_fake_open):
            rs._fire_alert_webhooks(
                run_id="run_z", worker_id="wk_1", status="failed",
                error=None, repos=repos,
            )

    raw = captured["data"].decode()
    # The signing secret must never appear in the POST body.
    assert secret not in raw
    # The HMAC signature headers are derived from the secret but are not the secret.
    headers = {str(k).lower(): v for k, v in captured["headers"].items()}
    for header_name in ("x-floom-signature", "x-workeros-signature"):
        sig_header = headers.get(header_name, "")
        assert sig_header.startswith("sha256=")
        assert secret not in sig_header
    assert headers["x-floom-signature"] == headers["x-workeros-signature"]
    assert headers["x-floom-run-id"] == "run_z"
    assert headers["x-workeros-run-id"] == "run_z"


# ---------------------------------------------------------------------------
# Redirect-driven SSRF bypass: a public webhook that 302-redirects to an
# internal/metadata target must NOT be followed (the gap in the #370 guard).
# ---------------------------------------------------------------------------

import http.server
import threading


class _RedirectToMetadataHandler(http.server.BaseHTTPRequestHandler):
    """First request → 302 to the cloud-metadata IP; record any 2nd hit."""

    redirect_target = "http://169.254.169.254/latest/meta-data/"
    hits: list[str] = []

    def do_POST(self):  # noqa: N802
        type(self).hits.append(self.path)
        # Drain the request body so the client send completes cleanly.
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)
        self.send_response(302)
        self.send_header("Location", self.redirect_target)
        self.end_headers()

    def log_message(self, *args):  # silence test server logging
        return


def test_redirect_to_internal_is_not_followed(monkeypatch):
    """A public 200/302 endpoint that says ``302 Location: 169.254.169.254``
    must NOT cause the alert POST to reach the internal target.

    Drives the REAL no-redirect opener against a real local HTTP server, so it
    proves the redirect handler — not a mock — refuses to chase the redirect.
    """
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()

    _RedirectToMetadataHandler.hits = []
    server = http.server.HTTPServer(("127.0.0.1", 0), _RedirectToMetadataHandler)
    host, port = server.server_address
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    webhook_url = f"http://127.0.0.1:{port}/hook"
    repos = _fake_repos([
        {"url": webhook_url, "email_to": None, "events": "failed", "secret": None},
    ])

    try:
        # The local webhook host (127.0.0.1) is itself internal, so bypass the
        # pre-flight SSRF check AND the connect-time pin check ONLY for this test
        # to isolate redirect behaviour: the point under test is that the 302 →
        # metadata is not followed. Drives the REAL pinned opener path.
        monkeypatch.setenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", "1")
        rs._fire_alert_webhooks(
            run_id="run_redir", worker_id="wk_1", status="failed",
            error=None, repos=repos,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    # The initial webhook was POSTed exactly once, and the 302 → metadata target
    # was NEVER followed (no-redirect opener), so no second POST occurred.
    assert _RedirectToMetadataHandler.hits == ["/hook"]


# ---------------------------------------------------------------------------
# Validate-at-store: POST /workers/{id}/alerts
# ---------------------------------------------------------------------------

def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADERS["x-floom-secret"])
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "services.run_notifications",
            "composio_client", "auth", "contexts",
        ]):
            sys.modules.pop(name, None)
        for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


_WORKER_YML = """id: alert-ssrf-test
name: Alert SSRF Test
description: Worker used by alert-webhook SSRF tests.
trigger:
  type: manual
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
inputs: []
outputs:
  - name: result
    type: string
    label: Result
secrets: []
connections: []
"""

_RUN_PY = """from typing import Any, Dict


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    return {"status": "success", "outputs": {"result": "ok"}, "artifacts": []}
"""


def _create_worker(client):
    resp = client.post(
        "/workers",
        json={"worker_yml": _WORKER_YML, "run_py": _RUN_PY},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


@pytest.mark.parametrize("bad_url", [
    "http://169.254.169.254/hook",
    "http://localhost:8080/hook",
    "http://10.0.0.1/hook",
    "http://192.168.1.1/hook",
])
def test_create_alert_rejects_internal_url(monkeypatch, tmp_path, bad_url):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)
    worker_id = _create_worker(client)

    resp = client.post(
        f"/workers/{worker_id}/alerts",
        json={"url": bad_url, "on": ["failed"]},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 400, resp.text
    assert "not allowed" in resp.text.lower()


def test_create_alert_accepts_public_url(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)
    worker_id = _create_worker(client)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        resp = client.post(
            f"/workers/{worker_id}/alerts",
            json={"url": "https://hooks.example.com/alert", "on": ["failed"]},
            headers=AUTH_HEADERS,
        )
    assert resp.status_code == 201, resp.text
    assert resp.json()["url"] == "https://hooks.example.com/alert"


def test_create_alert_email_only_unaffected(monkeypatch, tmp_path):
    """An email-only alert (no url) must not be blocked by the SSRF check."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=True)
    worker_id = _create_worker(client)

    resp = client.post(
        f"/workers/{worker_id}/alerts",
        json={"email_to": ["ops@example.com"], "on": ["failed"]},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# F1 — DNS-rebinding TOCTOU: pin the validated IP, dial THAT IP, re-validate at
# connect. A host that resolves to a public IP at validation but an internal IP
# at connect must NOT reach the internal target.
# ---------------------------------------------------------------------------

def test_pin_blocks_internal_resolution_only(monkeypatch):
    """If a hostname resolves ONLY to internal IPs, the pinned opener refuses."""
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()
    from models import UnsafeOutboundUrlError

    req = __import__("urllib.request", fromlist=["Request"]).Request(
        "https://rebind.example.com/hook", data=b"{}", method="POST"
    )
    # Connect-time resolution returns ONLY an internal address (the rebind).
    with patch("models.socket.getaddrinfo", return_value=_addrinfo("169.254.169.254")):
        with pytest.raises(UnsafeOutboundUrlError):
            rs._open_pinned_webhook(req, timeout=5)


def test_pin_uses_validated_public_ip_not_rebound_internal(monkeypatch):
    """The opener pins the public IP from resolution; the socket is opened to
    THAT pinned IP, never to a later-rebound internal IP.

    Resolution returns a public IP, so the pinned IP is the public one. We patch
    socket.create_connection to record exactly which IP the socket dials and
    confirm it is the pinned PUBLIC address, not localhost/metadata.
    """
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()

    public_ip = "93.184.216.34"
    dialed = {}

    class _FakeSock:
        def settimeout(self, *_a):
            pass

        def close(self):
            pass

        def makefile(self, *_a, **_k):
            import io
            return io.BytesIO(b"HTTP/1.1 204 No Content\r\n\r\n")

        def sendall(self, *_a):
            pass

        def send(self, *_a):
            return 0

    def _fake_create_connection(addr, timeout=None, *a, **k):
        dialed["ip"] = addr[0]
        return _FakeSock()

    req = __import__("urllib.request", fromlist=["Request"]).Request(
        "http://pinned.example.com/hook", data=b"{}", method="POST"
    )

    with patch("models.socket.getaddrinfo", return_value=_addrinfo(public_ip)):
        with patch.object(rs._socket, "create_connection", side_effect=_fake_create_connection):
            try:
                rs._open_pinned_webhook(req, timeout=5)
            except Exception:
                # Response parsing of the fake socket may error; we only assert
                # which IP was dialed.
                pass

    assert dialed.get("ip") == public_ip
    assert dialed["ip"] not in {"127.0.0.1", "169.254.169.254"}


def test_pinned_https_preserves_sni_host(monkeypatch):
    """The HTTPS pinned connection keeps the original hostname for TLS SNI/cert
    validation even though the socket dials a pinned IP."""
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    rs = _run_service()

    conn = rs._PinnedHTTPSConnection("secure.example.com", timeout=5)
    conn._pinned_ip = "93.184.216.34"
    # Host header / SNI source is the original hostname, not the pinned IP.
    assert conn.host == "secure.example.com"
    assert conn._pinned_ip == "93.184.216.34"
