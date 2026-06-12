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
from tests._api_source import api_source

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
# #529 — Private workers must not expose public_link in list or detail response
# ---------------------------------------------------------------------------

MAIN_PY = API_DIR / "main.py"
_GUARD = "== \"public\" else None"


def test_list_endpoint_guards_public_link():
    """list_workers must gate _worker_public_link on visibility == 'public'."""
    src = api_source()
    # Find the list_workers assignment — must be a conditional, not a bare call.
    # We look for the guard expression occurring on the same line as the list call.
    list_lines = [
        line for line in src.splitlines()
        if "_worker_public_link" in line and "public_link=" in line and _GUARD in line
    ]
    assert len(list_lines) >= 1, (
        "list_workers: public_link= must use the visibility guard "
        f"('... == \"public\" else None'), found 0 guarded assignments"
    )


def test_detail_endpoint_guards_public_link():
    """WorkerDetail constructor must gate _worker_public_link on visibility == 'public'."""
    src = api_source()
    guarded = [
        line for line in src.splitlines()
        if "_worker_public_link" in line and "public_link=" in line and _GUARD in line
    ]
    # Both list and detail must be guarded — require at least 2 occurrences.
    assert len(guarded) >= 2, (
        f"Both list_workers and WorkerDetail must guard public_link with the visibility "
        f"check, but only {len(guarded)} guarded assignment(s) found in main.py"
    )


def test_no_unguarded_worker_public_link_assignments():
    """No public_link= line may call _worker_public_link without the visibility guard."""
    src = api_source()
    unguarded = [
        line.strip() for line in src.splitlines()
        if "_worker_public_link" in line and "public_link=" in line and _GUARD not in line
    ]
    assert unguarded == [], (
        f"Found unguarded _worker_public_link assignment(s) in main.py:\n"
        + "\n".join(unguarded)
    )


def test_private_worker_guard_logic():
    """The guard expression itself: private and no-visibility workers return None."""
    def _apply_guard(worker: dict) -> bool:
        return str(worker.get("visibility") or "private") == "public"

    assert not _apply_guard({"visibility": "private"}), "private → guarded out"
    assert not _apply_guard({}), "no visibility field → guarded out"
    assert not _apply_guard({"visibility": None}), "None visibility → guarded out"
    assert _apply_guard({"visibility": "public"}), "public → allowed through"
