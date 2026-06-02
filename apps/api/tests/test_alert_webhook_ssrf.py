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

    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["data"] = req.data
        captured["timeout"] = timeout
        return MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        with patch.object(rs.urllib.request, "urlopen", side_effect=_fake_urlopen):
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

    with patch.object(rs.urllib.request, "urlopen") as mock_open:
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
        with patch.object(rs.urllib.request, "urlopen",
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

    def _fake_urlopen(req, timeout=None):
        captured["data"] = req.data
        captured["headers"] = req.headers
        return MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False)

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        with patch.object(rs.urllib.request, "urlopen", side_effect=_fake_urlopen):
            rs._fire_alert_webhooks(
                run_id="run_z", worker_id="wk_1", status="failed",
                error=None, repos=repos,
            )

    raw = captured["data"].decode()
    # The signing secret must never appear in the POST body.
    assert secret not in raw
    # The HMAC signature header is derived from the secret but is not the secret.
    sig_header = captured["headers"].get("X-workeros-signature", "")
    assert secret not in sig_header


# ---------------------------------------------------------------------------
# Validate-at-store: POST /workers/{id}/alerts
# ---------------------------------------------------------------------------

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
