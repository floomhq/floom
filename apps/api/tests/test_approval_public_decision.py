"""X3: per-ID unlisted signed approval links.

Covers the security + routing contract for the no-auth, token-gated public
approval surface that the standalone /approvals/review page calls:

  - GET  /approvals/public/{id}?token=...         -> returns ONE approval
  - POST /approvals/public/{id}/approve?token=... -> approves anonymously
  - POST /approvals/public/{id}/reject?token=...  -> rejects anonymously

Hard invariants:
  1. Anonymous (no session cookie / no x-floom-secret) requests succeed when the
     signed token is valid — the link is the credential.
  2. The token is per-approval (HMAC over id.run_id.owner_id). A token minted for
     approval A cannot view OR act on approval B.
  3. A missing/garbage token is rejected with 401 before any decision runs.
  4. The public GET returns exactly the requested approval and never leaks
     owner_id or the owner-only share link.

The approve/reject decision bodies themselves (follow-up run spawning, status
transitions, SSE) are owned + tested by the /runs/{id}/approve|reject path. Here
we monkeypatch those module functions so the test isolates the public-endpoint
routing and token gate: we assert the decision function is reached with the
APPROVAL OWNER's auth context, and that a bad/cross token never reaches it.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-public-test-"))
os.environ["WORKEROS_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["FLOOM_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")
# Deterministic secret so the HMAC token is stable across the test.
os.environ["FLOOM_SECRET"] = "test-secret-x3"

import main  # noqa: E402


# Two distinct approvals owned by two distinct owners. The token gate must keep
# them fully isolated: A's token only unlocks A.
_APPROVAL_A = {
    "id": "apr_A",
    "run_id": "run_A",
    "owner_id": "user_A",
    "worker_id": "worker_A",
    "worker_name": "Worker A",
    "status": "pending",
    "label": "Review A",
    "preview": "proposed output A",
    "decision_input_json": "{}",
    "created_at": "2026-06-03T10:00:00Z",
}
_APPROVAL_B = {
    "id": "apr_B",
    "run_id": "run_B",
    "owner_id": "user_B",
    "worker_id": "worker_B",
    "worker_name": "Worker B",
    "status": "pending",
    "label": "Review B",
    "preview": "proposed output B",
    "decision_input_json": "{}",
    "created_at": "2026-06-03T10:05:00Z",
}
# #769: a destructive-delete approval — the public approve path routes these to
# approve_destructive_action, which previously DROPPED the reviewer's reason.
_APPROVAL_C = {
    "id": "apr_C",
    "run_id": "run_C",
    "owner_id": "user_C",
    "worker_id": "worker_C",
    "worker_name": "Worker C",
    "status": "pending",
    "label": "Delete file",
    "preview": "rm data/old.csv",
    "decision_input_json": '{"kind": "destructive_delete", "path": "data/old.csv"}',
    "created_at": "2026-06-03T10:10:00Z",
}
_BY_ID = {"apr_A": _APPROVAL_A, "apr_B": _APPROVAL_B, "apr_C": _APPROVAL_C}


class _ApprovalsRepo:
    def get_public(self, *, approval_id: str):
        row = _BY_ID.get(approval_id)
        return dict(row) if row else None


class _RunsRepo:
    def list_artifacts(self, *, user_id: str, run_id: str):
        return []


class _Repos:
    approvals = _ApprovalsRepo()
    runs = _RunsRepo()


def _token_for(approval) -> str:
    return main._approval_public_token(dict(approval))


def _client_and_calls(monkeypatch):
    """TestClient wired to fake repos, with approve_run/reject_run captured.

    Returns (client, calls) where calls records (kind, run_id, owner_id) for
    every decision the public endpoint forwards to. If the token gate rejects a
    request, nothing is appended.
    """
    calls: list[dict] = []

    def _fake_approve_run(run_id, body, auth, repos):
        calls.append({"kind": "approve", "run_id": run_id, "owner_id": auth.user_id})
        return main.ActionResponse(status="approved", run_id="run_followup")

    def _fake_reject_run(run_id, body, auth, repos):
        calls.append(
            {
                "kind": "reject",
                "run_id": run_id,
                "owner_id": auth.user_id,
                "reason": body.reason,
            }
        )
        return main.ActionResponse(status="rejected", run_id=run_id)

    def _fake_approve_destructive(approval_id, auth, repos, annotations=None, reason=None, **kw):
        calls.append(
            {
                "kind": "approve_destructive",
                "approval_id": approval_id,
                "owner_id": auth.user_id,
                "reason": reason,
            }
        )
        return {"status": "approved", "executed": "data/old.csv"}

    # The public-approval route handlers live in routers.approvals and call
    # approve_run / reject_run / approve_destructive_action by bare name (resolved
    # in that module), so patch there — not on main's re-export.
    import routers.approvals as _appr
    monkeypatch.setattr(_appr, "approve_run", _fake_approve_run)
    monkeypatch.setattr(_appr, "reject_run", _fake_reject_run)
    monkeypatch.setattr(_appr, "approve_destructive_action", _fake_approve_destructive)
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    return TestClient(main.app), calls


# ---------------------------------------------------------------------------
# 1. Per-ID GET: one approval, anonymous, no owner leak.
# ---------------------------------------------------------------------------


def test_public_get_returns_single_approval_anonymously():
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    token = _token_for(_APPROVAL_A)
    try:
        client = TestClient(main.app)
        # No session cookie, no x-floom-secret header — anonymous.
        response = client.get(f"/approvals/public/apr_A?token={token}")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "apr_A"
    assert body["run_id"] == "run_A"
    assert body["label"] == "Review A"
    # The single-approval contract: only this approval, never the whole queue.
    assert isinstance(body, dict)
    # Owner identity + owner-only share link must never reach the external viewer.
    assert "owner_id" not in body
    assert "public_link" not in body


def test_public_get_with_token_for_other_approval_is_rejected():
    """Token minted for A cannot VIEW B (HMAC binds id.run_id.owner_id)."""
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    token_a = _token_for(_APPROVAL_A)
    try:
        client = TestClient(main.app)
        response = client.get(f"/approvals/public/apr_B?token={token_a}")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 401


def test_public_get_with_missing_token_is_rejected():
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    try:
        client = TestClient(main.app)
        # min_length=16 query validation -> 422; empty/garbage -> 401.
        garbage = client.get("/approvals/public/apr_A?token=" + ("0" * 16))
    finally:
        main.app.dependency_overrides.clear()
    assert garbage.status_code == 401


# ---------------------------------------------------------------------------
# 2. Anonymous approve / reject via a valid signed token.
# ---------------------------------------------------------------------------


def test_public_approve_anonymous_with_valid_token(monkeypatch):
    client, calls = _client_and_calls(monkeypatch)
    token = _token_for(_APPROVAL_A)
    try:
        response = client.post(f"/approvals/public/apr_A/approve?token={token}")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert len(calls) == 1
    # The decision runs under the APPROVAL OWNER's identity, derived from the
    # signed row — not from any client-supplied auth.
    assert calls[0] == {"kind": "approve", "run_id": "run_A", "owner_id": "user_A"}


def test_public_approve_destructive_forwards_reason(monkeypatch):
    # #769: the public destructive-delete approve path must forward the
    # reviewer's plain-text reason (was silently dropped before the fix).
    client, calls = _client_and_calls(monkeypatch)
    token = _token_for(_APPROVAL_C)
    try:
        response = client.post(
            f"/approvals/public/apr_C/approve?token={token}",
            json={"reason": "approved for cleanup"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    assert len(calls) == 1
    assert calls[0]["kind"] == "approve_destructive"
    assert calls[0]["owner_id"] == "user_C"
    assert calls[0]["reason"] == "approved for cleanup"


def test_public_reject_anonymous_with_valid_token_and_reason(monkeypatch):
    client, calls = _client_and_calls(monkeypatch)
    token = _token_for(_APPROVAL_A)
    try:
        response = client.post(
            f"/approvals/public/apr_A/reject?token={token}",
            json={"reason": "needs another pass"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0]["kind"] == "reject"
    assert calls[0]["run_id"] == "run_A"
    assert calls[0]["owner_id"] == "user_A"
    assert calls[0]["reason"] == "needs another pass"


# ---------------------------------------------------------------------------
# 3. Token for A cannot ACT on B — the core unlisted-link isolation guarantee.
# ---------------------------------------------------------------------------


def test_token_for_a_cannot_approve_b(monkeypatch):
    client, calls = _client_and_calls(monkeypatch)
    token_a = _token_for(_APPROVAL_A)
    try:
        response = client.post(f"/approvals/public/apr_B/approve?token={token_a}")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 401
    # The gate rejected it BEFORE any decision logic ran.
    assert calls == []


def test_token_for_a_cannot_reject_b(monkeypatch):
    client, calls = _client_and_calls(monkeypatch)
    token_a = _token_for(_APPROVAL_A)
    try:
        response = client.post(
            f"/approvals/public/apr_B/reject?token={token_a}",
            json={"reason": "malicious cross-link"},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 401
    assert calls == []


# ---------------------------------------------------------------------------
# 4. F3 — existence oracle: a NOT-FOUND approval and a PRESENT-but-bad-token
#    approval must return the IDENTICAL response, so an attacker can't enumerate
#    which approval ids exist by diffing 404-vs-401.
# ---------------------------------------------------------------------------


def test_not_found_and_bad_token_return_identical_response():
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    bad_token = "0" * 32
    try:
        client = TestClient(main.app)
        # apr_A EXISTS but the token is wrong.
        present_bad = client.get(f"/approvals/public/apr_A?token={bad_token}")
        # apr_NOPE does NOT exist at all.
        missing = client.get(f"/approvals/public/apr_NOPE?token={bad_token}")
    finally:
        main.app.dependency_overrides.clear()

    # Same status code...
    assert present_bad.status_code == missing.status_code == 401
    # ...and the SAME body — no field distinguishes existence.
    assert present_bad.json() == missing.json()


def test_approve_not_found_and_bad_token_identical(monkeypatch):
    client, calls = _client_and_calls(monkeypatch)
    bad_token = "0" * 32
    try:
        present_bad = client.post(f"/approvals/public/apr_A/approve?token={bad_token}")
        missing = client.post(f"/approvals/public/apr_NOPE/approve?token={bad_token}")
    finally:
        main.app.dependency_overrides.clear()

    assert present_bad.status_code == missing.status_code == 401
    assert present_bad.json() == missing.json()
    # Neither reached the decision logic.
    assert calls == []
