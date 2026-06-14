"""Regression test for #271 — failed runs recorded as status=completed.

A runner error was persisted with terminal status="completed", a non-null
error, AND smoke-test output in output_json — so failures masqueraded as
successes. The cloud persistence boundary now enforces the invariant: an
errored run is "failed", never "completed", and carries no leaked output.
"""

from __future__ import annotations

from types import SimpleNamespace

import apps.api.db.supabase_repos as sr
from apps.api.db.supabase_repos import SupabaseRunRepository


class _RunsClient:
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


def _repo(monkeypatch):
    monkeypatch.setattr(sr, "get_active_workspace_id", lambda: None)
    client = _RunsClient()
    repo = SupabaseRunRepository(client=client)
    monkeypatch.setattr(repo, "get", lambda **k: {"id": "r1", "started_at": None})
    return repo, client


def test_update_status_coerces_completed_with_error_to_failed(monkeypatch):
    repo, client = _repo(monkeypatch)
    repo.update_status(
        user_id="u1", run_id="r1", status="completed",
        error="Worker directory not found", output_json={"result": "HELLO WORLD"},
    )
    assert client.payload["status"] == "failed"          # not "completed"
    assert client.payload["output_json"] == {}           # smoke/leaked output dropped
    assert client.payload["error"] == "Worker directory not found"


def test_update_status_leaves_real_completion_untouched(monkeypatch):
    repo, client = _repo(monkeypatch)
    repo.update_status(user_id="u1", run_id="r1", status="completed", output_json={"result": "OK"})
    assert client.payload["status"] == "completed"
    assert client.payload["output_json"] == {"result": "OK"}


def test_update_status_failed_passes_through(monkeypatch):
    repo, client = _repo(monkeypatch)
    repo.update_status(user_id="u1", run_id="r1", status="failed", error="boom")
    assert client.payload["status"] == "failed"
    assert client.payload["error"] == "boom"


def test_update_method_enforces_same_invariant(monkeypatch):
    repo, client = _repo(monkeypatch)
    repo.update(
        user_id="u1", run_id="r1", status="completed",
        error="Server disconnected", output_json={"result": "leaked smoke"},
    )
    assert client.payload["status"] == "failed"
    assert client.payload["output_json"] == {}


def test_update_method_real_completion_untouched(monkeypatch):
    repo, client = _repo(monkeypatch)
    repo.update(user_id="u1", run_id="r1", status="completed", output_json={"result": "real"})
    assert client.payload["status"] == "completed"
    assert client.payload["output_json"] == {"result": "real"}
