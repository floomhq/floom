"""Regression test: cloud FAILED runs must persist a non-null error_code.

Root cause: the Supabase RunRepository only wrote ``error_code`` when it was
non-None, so every cloud run that reached FAILED without an explicit code landed
with ``error_code = null``. The downstream failure taxonomy keys off
``error_code``; a null forced it into best-effort string-matching on the free
text. The repo now mirrors the engine's ``_normalize_failed_error_fields`` and
falls back to the ``unknown_error`` sentinel on every FAILED write path.
"""

from __future__ import annotations

from types import SimpleNamespace

import apps.api.db.supabase_repos as sr
from apps.api.db.supabase_repos import (
    _UNKNOWN_RUN_ERROR_CODE,
    SupabaseRunRepository,
)


class _RunsClient:
    """Captures the last update payload sent to the Supabase ``runs`` table."""

    def __init__(self):
        self.payload = None

    def table(self, _n):
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def eq(self, *a, **k):
        return self

    def execute(self):
        return SimpleNamespace(data=[{"id": "r1"}])


def _repo(monkeypatch, existing_run=None):
    monkeypatch.setattr(sr, "get_active_workspace_id", lambda: None)
    client = _RunsClient()
    repo = SupabaseRunRepository(client=client)
    row = existing_run if existing_run is not None else {"id": "r1", "started_at": None}
    monkeypatch.setattr(repo, "get", lambda **k: row)
    return repo, client


def test_update_status_failed_without_code_gets_sentinel(monkeypatch):
    """status=failed + error_code=None => persisted error_code is non-null."""
    repo, client = _repo(monkeypatch)
    repo.update_status(user_id="u1", run_id="r1", status="failed", error="boom")
    assert client.payload["status"] == "failed"
    assert client.payload["error"] == "boom"
    assert client.payload["error_code"] == _UNKNOWN_RUN_ERROR_CODE
    assert client.payload["error_code"]  # never null/empty


def test_update_status_failed_without_error_or_code_gets_both_fallbacks(monkeypatch):
    """A bare FAILED (no error text, no code) still persists structured fields."""
    repo, client = _repo(monkeypatch)
    repo.update_status(user_id="u1", run_id="r1", status="failed")
    assert client.payload["status"] == "failed"
    assert client.payload["error_code"] == _UNKNOWN_RUN_ERROR_CODE
    assert client.payload["error"]  # human fallback message, non-empty


def test_update_status_failed_preserves_explicit_code(monkeypatch):
    """An explicit structured code is never overwritten by the sentinel."""
    repo, client = _repo(monkeypatch)
    repo.update_status(
        user_id="u1", run_id="r1", status="failed",
        error="missing secret X", error_code="missing_secret",
    )
    assert client.payload["error_code"] == "missing_secret"


def test_update_status_failed_falls_back_to_existing_row_code(monkeypatch):
    """A later FAILED write with no code inherits the code already on the row."""
    repo, client = _repo(
        monkeypatch,
        existing_run={"id": "r1", "started_at": None,
                      "error": "earlier", "error_code": "worker_error"},
    )
    repo.update_status(user_id="u1", run_id="r1", status="failed")
    assert client.payload["error_code"] == "worker_error"


def test_completed_with_error_coerced_to_failed_gets_code(monkeypatch):
    """completed+error => failed, and the coerced-failed row still gets a code."""
    repo, client = _repo(monkeypatch)
    repo.update_status(
        user_id="u1", run_id="r1", status="completed",
        error="Worker directory not found", output_json={"result": "LEAK"},
    )
    assert client.payload["status"] == "failed"
    assert client.payload["output_json"] == {}
    assert client.payload["error_code"] == _UNKNOWN_RUN_ERROR_CODE


def test_update_method_failed_gets_code(monkeypatch):
    """The generic update() path also normalizes a FAILED transition's code."""
    repo, client = _repo(monkeypatch)
    repo.update(user_id="u1", run_id="r1", status="failed", error="boom")
    assert client.payload["status"] == "failed"
    assert client.payload["error_code"] == _UNKNOWN_RUN_ERROR_CODE


def test_update_method_completed_no_error_leaves_code_unset(monkeypatch):
    """A genuine completion must NOT acquire an error_code."""
    repo, client = _repo(monkeypatch)
    repo.update(user_id="u1", run_id="r1", status="completed", output_json={"result": "ok"})
    assert client.payload["status"] == "completed"
    assert "error_code" not in client.payload or not client.payload.get("error_code")
