"""#1732: a single shared builder for the operator-facing approval/review URL.

`core.approval_signing.try_approval_review_url` is the one place that turns an
approval (id/run_id/owner_id) into the tokenised `/approvals/review?id=..&token=..`
deep link. The chat tool (Emily), the run-detail serializer (`approval_trail.link`),
and the CLI `runs show` all consume it, so they can never drift.

Contract:
  (a) No signer secret        -> None (DEGRADE; callers omit the link).
  (b) Signer secret configured -> full URL with a real HMAC token (never "None").
  (c) Missing id/run_id/owner_id -> None (incomplete approval, no forgeable link).
  (d) Host honours WORKEROS_PUBLIC_URL, then WORKERS_FRONTEND_URL.

Run: cd apps/api && python -m pytest tests/test_approval_review_url_1732.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from core.approval_signing import (  # noqa: E402
    try_approval_public_token,
    try_approval_review_url,
)

_APPROVAL = {"id": "apr_1", "run_id": "run_1", "owner_id": "user_1"}


def _clear_signer(monkeypatch):
    monkeypatch.delenv("WORKEROS_APPROVAL_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)


def _clear_host(monkeypatch):
    monkeypatch.delenv("WORKEROS_PUBLIC_URL", raising=False)
    monkeypatch.delenv("WORKERS_FRONTEND_URL", raising=False)


def test_returns_none_without_signer(monkeypatch):
    _clear_signer(monkeypatch)
    assert try_approval_review_url(dict(_APPROVAL)) is None


def test_builds_signed_url_with_secret(monkeypatch):
    _clear_signer(monkeypatch)
    _clear_host(monkeypatch)
    monkeypatch.setenv("WORKEROS_APPROVAL_SIGNING_SECRET", "cloud-secret")
    monkeypatch.setenv("WORKEROS_PUBLIC_URL", "https://app.example.com")
    url = try_approval_review_url(dict(_APPROVAL))
    assert url is not None
    assert url.startswith("https://app.example.com/approvals/review?id=apr_1&token=")
    assert "token=None" not in url
    # The token is exactly the shared HMAC, so every surface matches.
    expected = try_approval_public_token(dict(_APPROVAL))
    assert url.endswith(f"token={expected}")


def test_returns_none_for_incomplete_approval(monkeypatch):
    _clear_signer(monkeypatch)
    monkeypatch.setenv("FLOOM_SECRET", "oss-secret")
    assert try_approval_review_url({"id": "apr_1", "run_id": "run_1"}) is None
    assert try_approval_review_url({"id": "apr_1", "owner_id": "user_1"}) is None
    assert try_approval_review_url({}) is None


def test_host_precedence_and_trailing_slash(monkeypatch):
    _clear_signer(monkeypatch)
    _clear_host(monkeypatch)
    monkeypatch.setenv("FLOOM_SECRET", "oss-secret")
    # Falls back to WORKERS_FRONTEND_URL when WORKEROS_PUBLIC_URL is unset, and
    # strips a trailing slash so the path is never doubled.
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://host.example.com/")
    url = try_approval_review_url(dict(_APPROVAL))
    assert url is not None
    assert url.startswith("https://host.example.com/approvals/review?id=apr_1&token=")
    # WORKEROS_PUBLIC_URL wins when both are set.
    monkeypatch.setenv("WORKEROS_PUBLIC_URL", "https://primary.example.com")
    url2 = try_approval_review_url(dict(_APPROVAL))
    assert url2 is not None
    assert url2.startswith("https://primary.example.com/approvals/review")
