"""R8: the approvals list/detail serializer must DEGRADE, never 503, when no
public-link signing secret is configured.

Root cause this guards against: `_approval_response()` mints a public-share HMAC
(`public_link`) for EVERY approval row. The mint historically read FLOOM_SECRET
only and fail-closed (503) when empty (#998). The multi-tenant cloud deliberately
strips FLOOM_SECRET at startup, so EVERY row's mint 503'd and `GET /api/approvals`
returned 503 whenever any approval existed — the Approvals page showed
"Could not load approvals" and the approve/reject controls never rendered.

Contract now:
  (a) No signer secret  -> serializer returns the approval with public_link=None.
  (b) WORKEROS_APPROVAL_SIGNING_SECRET set -> public_link present + signed.
  (c) OSS fallback: FLOOM_SECRET alone -> public_link present + signed.
  (d) The explicit MINT path (`approval_public_token`, used by the public-link
      verify endpoints) still fail-closes (503) with no signer — never an
      unsigned/forgeable link.

Run: cd apps/api && python -m pytest tests/test_approval_list_signer_degrade.py -q
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-degrade-test-"))
os.environ["WORKEROS_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["FLOOM_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")

from routers import approvals as approvals_mod  # noqa: E402

_APPROVAL = {
    "id": "apr_X",
    "run_id": "run_X",
    "owner_id": "user_X",
    "worker_id": "worker_X",
    "worker_name": "Worker X",
    "status": "pending",
    "label": "Review X",
    "preview": "proposed output X",
    "decision_input_json": "{}",
    "created_at": "2026-06-16T10:00:00Z",
}


class _RunsRepo:
    def list_artifacts(self, *, user_id: str, run_id: str):
        return []


class _Repos:
    runs = _RunsRepo()


def _clear_signer(monkeypatch):
    monkeypatch.delenv("WORKEROS_APPROVAL_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)


def test_serializer_omits_link_when_no_signer(monkeypatch):
    """(a) No secret at all -> 200-equivalent dict with public_link=None."""
    _clear_signer(monkeypatch)
    out = approvals_mod._approval_response(dict(_APPROVAL), _Repos())
    assert out["public_link"] is None
    # The approval itself is still fully serialized for the owner.
    assert out["id"] == "apr_X"
    assert out["status"] == "pending"
    assert "artifacts" in out


def test_serializer_includes_link_with_dedicated_secret(monkeypatch):
    """(b) WORKEROS_APPROVAL_SIGNING_SECRET set -> signed public_link present."""
    _clear_signer(monkeypatch)
    monkeypatch.setenv("WORKEROS_APPROVAL_SIGNING_SECRET", "cloud-approval-secret")
    out = approvals_mod._approval_response(dict(_APPROVAL), _Repos())
    assert out["public_link"] is not None
    assert "/approvals/review?id=apr_X&token=" in out["public_link"]
    # token must be the real HMAC over id.run_id.owner_id, not "None".
    assert "token=None" not in out["public_link"]


def test_serializer_falls_back_to_floom_secret(monkeypatch):
    """(c) OSS single-tenant: FLOOM_SECRET alone still signs the link."""
    _clear_signer(monkeypatch)
    monkeypatch.setenv("FLOOM_SECRET", "oss-secret")
    out = approvals_mod._approval_response(dict(_APPROVAL), _Repos())
    assert out["public_link"] is not None
    assert "token=None" not in out["public_link"]


def test_dedicated_secret_takes_precedence_over_floom_secret(monkeypatch):
    """Dedicated var wins over FLOOM_SECRET so the two paths produce the same
    token the cloud's verify path will accept."""
    _clear_signer(monkeypatch)
    monkeypatch.setenv("FLOOM_SECRET", "oss-secret")
    monkeypatch.setenv("WORKEROS_APPROVAL_SIGNING_SECRET", "cloud-approval-secret")
    from core.approval_signing import approval_public_token
    monkeypatch.setenv("WORKEROS_APPROVAL_SIGNING_SECRET", "cloud-approval-secret")
    tok_dedicated = approval_public_token(dict(_APPROVAL))
    monkeypatch.delenv("WORKEROS_APPROVAL_SIGNING_SECRET", raising=False)
    tok_floom = approval_public_token(dict(_APPROVAL))
    assert tok_dedicated != tok_floom  # different secret -> different token


def test_mint_path_still_fails_closed_without_signer(monkeypatch):
    """(d) The explicit mint path must NEVER emit an unsigned link — 503."""
    _clear_signer(monkeypatch)
    from fastapi import HTTPException

    from core.approval_signing import approval_public_token
    with pytest.raises(HTTPException) as exc:
        approval_public_token(dict(_APPROVAL))
    assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# Full HTTP-level regression: GET /api/approvals must return 200 (not 503) when
# a pending approval exists and no signer is configured (the exact prod bug).
# ---------------------------------------------------------------------------
def test_get_approvals_route_returns_200_without_signer(monkeypatch):
    _clear_signer(monkeypatch)
    from fastapi.testclient import TestClient

    import main  # noqa: PLC0415

    class _ApprovalsRepo:
        def list_pending(self, *, owner_id: str):
            return [dict(_APPROVAL, owner_id=owner_id)]

    class _ReposHttp:
        approvals = _ApprovalsRepo()
        runs = _RunsRepo()

    main.app.dependency_overrides[main.get_repos] = lambda: _ReposHttp()
    main.app.dependency_overrides[main.get_auth_context] = lambda: main.AuthContext(
        user_id="user_X", email=None, scopes=("admin",)
    )
    try:
        client = TestClient(main.app)
        resp = client.get("/approvals")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert isinstance(body, list) and len(body) == 1
        assert body[0]["id"] == "apr_X"
        assert body[0]["public_link"] is None
    finally:
        main.app.dependency_overrides.pop(main.get_repos, None)
        main.app.dependency_overrides.pop(main.get_auth_context, None)
