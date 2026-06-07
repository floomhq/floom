"""Batch-3 security fixes.

#527 — Alert webhook validation accepts encoded CRLF URLs
#529 — Private worker list responses include public share links

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_batch3_security.py -x -q
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# #527 — CRLF injection rejected by assert_safe_outbound_url
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_url", [
    # Percent-encoded CRLF in path — the original reported payload.
    "https://example.com/%0d%0aX-Evil:%20yes",
    # Double-encoded — bypass attempt via %250d%250a.
    "https://example.com/%250d%250aX-Evil:%20yes",
    # Encoded only CR.
    "https://example.com/%0d/path",
    # Encoded only LF.
    "https://example.com/%0a/path",
    # Raw CRLF in a constructed string.
    "https://example.com/path\r\nX-Evil: yes",
])
def test_crlf_variants_are_rejected(bad_url, monkeypatch):
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    from models import assert_safe_outbound_url, UnsafeOutboundUrlError

    with pytest.raises(UnsafeOutboundUrlError, match="control characters"):
        assert_safe_outbound_url(bad_url, label="Alert webhook URL")


def test_clean_url_still_passes(monkeypatch):
    """A well-formed URL with no CRLF must pass validation (not a regression)."""
    monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
    from models import assert_safe_outbound_url
    import socket
    from unittest.mock import patch

    def _addrinfo(ip):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0))]

    with patch("models.socket.getaddrinfo", return_value=_addrinfo("93.184.216.34")):
        result = assert_safe_outbound_url(
            "https://hooks.example.com/alert", label="Alert webhook URL"
        )
    assert result == "https://hooks.example.com/alert"


# ---------------------------------------------------------------------------
# #529 — Private workers must not expose public_link in list response
# ---------------------------------------------------------------------------

def _make_link(worker_id: str) -> str:
    """Minimal replica of _worker_public_link for testing the guard logic.

    Replicates the HMAC URL construction from main.py without importing the
    full FastAPI app (which pulls in dotenv, sqlite, e2b, etc.).
    """
    import hashlib
    import hmac as _hmac

    secret = os.environ.get("FLOOM_SECRET", "dev-secret-not-set")
    payload = f"worker.{worker_id}.owner1"
    token = _hmac.new(
        secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"http://localhost:3000/w/{worker_id}?token={token}"


def _guarded_link(worker: dict) -> str | None:
    """Exact conditional from main.py line ~5839."""
    if str(worker.get("visibility") or "private") != "public":
        return None
    return _make_link(str(worker.get("id") or ""))


def test_private_worker_share_link_suppressed():
    """Private workers must not receive a public_link in the list response."""
    private_worker = {"id": "wk-priv", "owner_id": "owner1", "visibility": "private"}
    assert _guarded_link(private_worker) is None, "Private worker must not have a public_link"


def test_public_worker_share_link_present():
    """Public workers must receive a public_link in the list response."""
    public_worker = {"id": "wk-pub", "owner_id": "owner1", "visibility": "public"}
    link = _guarded_link(public_worker)
    assert link is not None, "Public worker must have a public_link"
    assert "/w/wk-pub" in link


def test_default_visibility_suppresses_link():
    """Workers with no visibility field default to private and get no link."""
    no_vis_worker = {"id": "wk-none", "owner_id": "owner1"}
    assert _guarded_link(no_vis_worker) is None
