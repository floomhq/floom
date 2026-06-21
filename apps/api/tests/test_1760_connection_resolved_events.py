"""Regression: the OAuth callback emits connection_added / connection_failed
exactly once per resolution, at the single shared chokepoint, and only when the
provider reports a definitive outcome.

The callback is the one place a pending OAuth connection transitions to its final
status regardless of how it was initiated (MCP / HTTP / chat all land here), so a
single emit here is the no-double-emit guarantee. A missing/unknown remote answer
leaves the connection pending and must emit nothing (no false activation signal).
Analytics must be fail-soft: no key set -> no event, never raises.
"""
from __future__ import annotations

import os
import sys

import pytest

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import composio_client  # noqa: E402
from routers import connections  # noqa: E402
from services import analytics_posthog  # noqa: E402


class _StubClient:
    def __init__(self):
        self.captured = []

    def capture(self, event, *, distinct_id=None, properties=None, groups=None, **_):
        self.captured.append(
            {
                "event": event,
                "properties": properties or {},
                "groups": groups,
                "distinct_id": distinct_id,
            }
        )

    def flush(self):
        pass

    def shutdown(self):
        pass


class _FakeConnections:
    def __init__(self, row):
        self._row = row
        self.updates = []

    def get_by_composio_connection_id(self, *, composio_connection_id):
        return dict(self._row)

    def update(self, **fields):
        self.updates.append(fields)
        return None


class _FakeRepos:
    def __init__(self, row):
        self.connections = _FakeConnections(row)


class _FakeQueryParams:
    def get(self, key, default=""):
        return default


class _FakeRequest:
    query_params = _FakeQueryParams()


_ROW = {
    "id": "floom-conn-1",
    "user_id": "owner-1",
    "app_name": "Gmail",
    "status": "initiated",
}


def _events(stub, name):
    return [c for c in stub.captured if c["event"] == name]


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
    analytics_posthog._reset_for_tests()
    s = _StubClient()
    analytics_posthog._client = s
    analytics_posthog._init_attempted = True

    # Drive the real callback chokepoint, stubbing only the OAuth/session and
    # row-merge plumbing so the analytics branch logic is what's under test.
    monkeypatch.setattr(connections, "_verify_oauth_callback_state", lambda **kw: None)
    monkeypatch.setattr(connections, "get_repositories", lambda: _FakeRepos(_ROW))
    monkeypatch.setattr(connections, "_connection_list_cache_clear", lambda *a, **k: None)
    monkeypatch.setattr(connections, "_invalidate_connections_cache", lambda *a, **k: None)
    monkeypatch.setattr(
        connections,
        "_dedupe_connection_account",
        lambda **kw: (kw["row"]["id"], kw["row"].get("app_name") or ""),
    )
    yield s
    analytics_posthog._reset_for_tests()


def _run_callback(remote_status):
    if remote_status is None:
        def _boom(_conn_id):
            raise RuntimeError("composio unreachable")

        check = _boom
    else:
        check = lambda _conn_id: remote_status
    import unittest.mock as _mock

    with _mock.patch.object(composio_client, "check_status", check):
        connections.connections_callback(
            _FakeRequest(), connection_id="ca_remote_1", state="signed-state"
        )


def test_active_emits_connection_added_once(stub):
    _run_callback("active")
    added = _events(stub, "connection_added")
    assert len(added) == 1
    assert not _events(stub, "connection_failed")
    props = added[0]["properties"]
    assert props["connection_id"] == "floom-conn-1"
    assert props["provider"] == "gmail"  # provider slug normalized, not the row's "Gmail"
    assert "failure_status" not in props  # added never carries a failure field
    assert added[0]["distinct_id"] == "owner-1"
    assert "workspace" in (added[0]["groups"] or {})  # per-workspace funnel grouping


def test_definitive_failure_emits_connection_failed_once(stub):
    _run_callback("expired")
    failed = _events(stub, "connection_failed")
    assert len(failed) == 1
    assert not _events(stub, "connection_added")
    props = failed[0]["properties"]
    assert props["connection_id"] == "floom-conn-1"
    assert props["provider"] == "gmail"
    assert props["failure_status"] == "expired"


def test_unknown_remote_answer_emits_nothing(stub):
    # Composio unreachable -> status stays pending -> no false signal.
    _run_callback(None)
    assert not _events(stub, "connection_added")
    assert not _events(stub, "connection_failed")


def test_not_found_remote_answer_emits_nothing(stub):
    _run_callback("not_found")
    assert not _events(stub, "connection_added")
    assert not _events(stub, "connection_failed")


def test_failsoft_when_analytics_disabled(monkeypatch):
    # No key configured -> is_enabled() False -> emit is a no-op and never raises.
    analytics_posthog._reset_for_tests()
    analytics_posthog._client = None
    analytics_posthog._init_attempted = True

    captured = []

    def _spy(*a, **k):
        captured.append((a, k))

    monkeypatch.setattr(analytics_posthog, "capture_event", _spy)
    monkeypatch.setattr(connections, "_verify_oauth_callback_state", lambda **kw: None)
    monkeypatch.setattr(connections, "get_repositories", lambda: _FakeRepos(_ROW))
    monkeypatch.setattr(connections, "_connection_list_cache_clear", lambda *a, **k: None)
    monkeypatch.setattr(connections, "_invalidate_connections_cache", lambda *a, **k: None)
    monkeypatch.setattr(
        connections,
        "_dedupe_connection_account",
        lambda **kw: (kw["row"]["id"], kw["row"].get("app_name") or ""),
    )
    import unittest.mock as _mock

    with _mock.patch.object(composio_client, "check_status", lambda _c: "active"):
        connections.connections_callback(
            _FakeRequest(), connection_id="ca_remote_1", state="signed-state"
        )
    assert captured == []
    analytics_posthog._reset_for_tests()
