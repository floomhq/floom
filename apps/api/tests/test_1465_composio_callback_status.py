from __future__ import annotations

from routers.connections import _callback_persisted_status


def test_callback_query_status_cannot_promote_pending_connection_to_active():
    assert _callback_persisted_status("pending", "pending") == "pending"


def test_callback_query_status_cannot_promote_when_remote_status_is_unavailable():
    assert _callback_persisted_status("initiated", "") == "initiated"
    assert _callback_persisted_status("pending", "not_found") == "pending"


def test_callback_uses_remote_active_when_composio_reports_active():
    assert _callback_persisted_status("pending", "active") == "active"
