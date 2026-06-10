"""SupabaseFeedbackRepository — hermetic tests with a stateful fake client.

Covers the cloud feedback repo that fixes the 503 ("feedback not available")
the engine's worker-feedback feature (SPEC §12) hit in cloud because
repos.feedback was None. Mirrors the fake-client style of test_supabase_repos.py
(no live Supabase needed). Live end-to-end additionally requires migration
0033_worker_feedback.sql to be applied to the Supabase project.
"""
from __future__ import annotations

import pytest

from apps.api.auth.workspace_context import active_workspace
from apps.api.db.supabase_repos import SupabaseFeedbackRepository


class _FakeResp:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, store, name):
        self.store = store
        self.name = name
        self.filters: list[tuple[str, object]] = []
        self._op = "select"
        self._row = None
        self._limit = None

    def insert(self, row):
        self._op = "insert"
        self._row = row
        return self

    def select(self, *_a, **_k):
        if self._op != "delete":
            self._op = "select"
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        tbl = self.store.setdefault(self.name, [])
        if self._op == "insert":
            tbl.append(dict(self._row))
            return _FakeResp([dict(self._row)])
        rows = [r for r in tbl if all(r.get(k) == v for k, v in self.filters)]
        if self._op == "delete":
            for r in rows:
                tbl.remove(r)
            return _FakeResp(rows)
        if self._limit is not None:
            rows = rows[: self._limit]
        return _FakeResp(rows)


class _FakeClient:
    def __init__(self):
        self.store: dict[str, list] = {}

    def table(self, name):
        return _FakeTable(self.store, name)


def _repo(client=None):
    return SupabaseFeedbackRepository(client=client or _FakeClient())


def test_add_returns_row_scoped_to_active_workspace():
    with active_workspace("ws_a"):
        r = _repo()
        row = r.add(
            feedback_id="fdbk_1", worker_id="w1", author_id="u1",
            author_name="Alice", content="nice worker", created_at="2026-01-01T00:00:00Z",
        )
    assert row["id"] == "fdbk_1"
    assert row["workspace_id"] == "ws_a"
    assert row["worker_id"] == "w1"
    assert row["author_id"] == "u1"
    assert row["author_name"] == "Alice"
    assert row["content"] == "nice worker"


def test_add_requires_active_workspace():
    r = _repo()
    with pytest.raises(RuntimeError):
        r.add(feedback_id="f", worker_id="w", author_id="u",
              author_name=None, content="c", created_at="t")


def test_get_and_list_are_workspace_isolated():
    client = _FakeClient()
    with active_workspace("ws_a"):
        ra = SupabaseFeedbackRepository(client=client)
        ra.add(feedback_id="f1", worker_id="w1", author_id="u1", author_name=None, content="a", created_at="t1")
        ra.add(feedback_id="f2", worker_id="w2", author_id="u1", author_name=None, content="b", created_at="t2")
        assert [x["id"] for x in ra.list(worker_id="w1")] == ["f1"]
        assert ra.get(feedback_id="f1")["content"] == "a"
    with active_workspace("ws_b"):
        rb = SupabaseFeedbackRepository(client=client)
        # A different tenant cannot see ws_a's feedback.
        assert rb.list(worker_id="w1") == []
        assert rb.get(feedback_id="f1") is None


def test_delete_returns_bool_and_removes():
    with active_workspace("ws_a"):
        r = _repo()
        r.add(feedback_id="f1", worker_id="w1", author_id="u1", author_name=None, content="x", created_at="t")
        assert r.delete(feedback_id="f1", worker_id="w1") is True
        assert r.get(feedback_id="f1") is None
        assert r.delete(feedback_id="missing", worker_id="w1") is False


def test_cloud_repositories_wires_feedback_not_none():
    """Regression for the 503: repos.feedback must be wired in cloud."""
    from apps.api import startup
    repos = startup._cloud_repositories()
    assert repos.feedback is not None
    assert isinstance(repos.feedback, SupabaseFeedbackRepository)
