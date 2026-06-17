from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from routers import approvals


class _RunsRepo:
    def list_artifacts(self, *, user_id: str, run_id: str):
        return []


def _repos():
    return SimpleNamespace(runs=_RunsRepo())


def _approval():
    return {
        "id": "apr_1",
        "run_id": "run_1",
        "owner_id": "user_1",
        "status": "pending",
    }


def test_owner_approval_response_omits_public_link_without_signing_secret(monkeypatch):
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    response = approvals._approval_response(_approval(), _repos())

    assert response["public_link"] is None
    assert response["id"] == "apr_1"
    assert response["artifacts"] == []


def test_public_approval_token_still_fails_closed_without_signing_secret(monkeypatch):
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    with pytest.raises(HTTPException) as exc:
        approvals._approval_public_token(_approval())

    assert exc.value.status_code == 503


def test_owner_approval_response_includes_public_link_with_signing_secret(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    response = approvals._approval_response(_approval(), _repos())

    assert response["public_link"].startswith("http://localhost:3000/approvals/review")
    assert "id=apr_1" in response["public_link"]
    assert "token=" in response["public_link"]
