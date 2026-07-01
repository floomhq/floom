from __future__ import annotations

from types import SimpleNamespace

import pytest
import requests
from fastapi import BackgroundTasks, HTTPException


class _Response:
    status_code = 400

    def json(self):
        return {
            "error": {
                "message": "Provider rejected the OAuth request",
                "code": "invalid_redirect_uri",
            },
            "status": "bad_request",
        }

    def raise_for_status(self):
        raise requests.exceptions.HTTPError(response=self)


def test_composio_client_preserves_safe_upstream_error(monkeypatch):
    import composio_client

    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.setattr(composio_client.requests, "post", lambda *_args, **_kwargs: _Response())

    with pytest.raises(composio_client.ComposioAPIError) as excinfo:
        composio_client._post("/connected_accounts/link", {"auth_config_id": "ac_123"})

    assert excinfo.value.user_message == (
        "Provider rejected the OAuth request (code: invalid_redirect_uri)"
    )
    assert excinfo.value.status_code == 400
    assert excinfo.value.code == "invalid_redirect_uri"


def test_composio_service_surfaces_specific_upstream_detail():
    from composio_client import ComposioAPIError
    from services.composio import _raise_composio_unavailable

    with pytest.raises(HTTPException) as excinfo:
        _raise_composio_unavailable(
            ComposioAPIError(
                "Provider rejected the OAuth request (code: invalid_redirect_uri)",
                status_code=400,
                code="invalid_redirect_uri",
            )
        )

    assert excinfo.value.status_code == 503
    assert excinfo.value.detail == "Provider rejected the OAuth request (code: invalid_redirect_uri)"


def test_post_connections_surfaces_specific_composio_detail(monkeypatch):
    from composio_client import ComposioAPIError
    from routers import connections

    def fail_initiate(*_args, **_kwargs):
        raise ComposioAPIError(
            "Provider rejected the OAuth request (code: invalid_redirect_uri)",
            status_code=400,
            code="invalid_redirect_uri",
        )

    monkeypatch.setattr("composio_client.initiate_connection", fail_initiate)

    with pytest.raises(HTTPException) as excinfo:
        connections.initiate_connection(
            connections.ConnectionInitRequest(app_name="gmail"),
            BackgroundTasks(),
            auth=SimpleNamespace(user_id="user-a"),
            repos=SimpleNamespace(connections=SimpleNamespace()),
        )

    assert excinfo.value.status_code == 503
    assert excinfo.value.detail == "Provider rejected the OAuth request (code: invalid_redirect_uri)"


def test_post_connections_schedules_pending_connection_reconciler(monkeypatch):
    from routers import connections

    captured_upsert: dict[str, object] = {}

    class ConnectionsRepo:
        def upsert(self, **kwargs):
            captured_upsert.update(kwargs)
            return kwargs

    monkeypatch.setattr(
        "composio_client.initiate_connection",
        lambda app_name, redirect_url, *, user_id: {
            "composio_connection_id": "ca_pending",
            "redirect_url": "https://connect.example/link",
        },
    )
    monkeypatch.setattr(connections, "_branded_authorize_url", lambda connection_id: f"short:{connection_id}")
    monkeypatch.setattr(connections, "_invalidate_connections_cache", lambda _user_id: None)

    background_tasks = BackgroundTasks()
    response = connections.initiate_connection(
        connections.ConnectionInitRequest(app_name="gmail"),
        background_tasks,
        auth=SimpleNamespace(user_id="user-a"),
        repos=SimpleNamespace(connections=ConnectionsRepo()),
    )

    assert response.composio_connection_id == "ca_pending"
    assert captured_upsert["status"] == "initiated"
    assert len(background_tasks.tasks) == 1
    task = background_tasks.tasks[0]
    assert task.func is connections._start_pending_connection_reconciler
    assert task.kwargs == {
        "user_id": "user-a",
        "connection_id": response.id,
        "composio_connection_id": "ca_pending",
    }


def test_pending_connection_reconciler_marks_remote_active(monkeypatch):
    from routers import connections

    row = {
        "id": "conn-1",
        "kind": "composio",
        "status": "initiated",
        "composio_connection_id": "ca_123",
    }
    updates: dict[str, object] = {}

    class ConnectionsRepo:
        def get(self, *, user_id, composio_id):
            assert user_id == "user-a"
            assert composio_id == "conn-1"
            return {**row, **updates}

        def update(self, *, user_id, composio_id, **kwargs):
            assert user_id == "user-a"
            assert composio_id == "conn-1"
            updates.update(kwargs)
            return {**row, **updates}

    monkeypatch.setattr("composio_client.check_status", lambda _connection_id: "ACTIVE")
    monkeypatch.setattr(connections, "_invalidate_connections_cache", lambda _user_id: None)
    monkeypatch.setattr(connections, "_cache_connection_account_info", lambda **_kwargs: {})

    status = connections._reconcile_pending_connection_once(
        user_id="user-a",
        connection_id="conn-1",
        composio_connection_id="ca_123",
        repos=SimpleNamespace(connections=ConnectionsRepo()),
        checked_at="2026-07-01T00:00:00+00:00",
    )

    assert status == "active"
    assert updates["status"] == "active"
    assert updates["last_checked_at"] == "2026-07-01T00:00:00+00:00"
    assert updates["last_check_status"] == "active"
    assert updates["last_check_error"] is None
