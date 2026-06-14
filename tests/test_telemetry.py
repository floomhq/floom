from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from auth.context import AuthContext

from apps.api import telemetry
from apps.api.routes import telemetry as telemetry_routes


class _InsertTable:
    def __init__(self) -> None:
        self.inserted: list[dict] = []

    def insert(self, rows):
        self.inserted = list(rows)
        return self

    def execute(self):
        return SimpleNamespace(data=self.inserted)


class _Client:
    def __init__(self) -> None:
        self.events = _InsertTable()

    def table(self, name: str):
        assert name == "telemetry_events"
        return self.events


def test_sanitize_properties_redacts_sensitive_values():
    props = telemetry.sanitize_properties(
        {
            "email": "user@example.com",
            "api_token": "floom_abcdefghijklmnopqrstuvwxyz123456",
            "nested": {"Authorization": "Bearer abc", "safe": "hello user@example.com"},
            "long": "x" * 700,
        }
    )

    assert props["email"] == "[redacted-email]"
    assert props["api_token"] == "[redacted]"
    assert props["nested"]["Authorization"] == "[redacted]"
    assert props["nested"]["safe"] == "hello [redacted-email]"
    assert props["long"].endswith("...")
    assert len(props["long"]) == telemetry.MAX_STRING_LENGTH + 3


def test_record_events_hashes_session_and_sanitizes_payload(monkeypatch):
    client = _Client()
    monkeypatch.setattr(telemetry, "telemetry_enabled", lambda workspace_id: True)
    monkeypatch.setattr(telemetry, "get_supabase_service_client", lambda: client)

    stored = telemetry.record_events(
        user_id="00000000-0000-0000-0000-000000000001",
        workspace_id="ws_1",
        events=[
            {
                "event_name": "worker.created",
                "source": "web",
                "session_id": "browser-session-1",
                "properties": {
                    "route": "/workers/new",
                    "secret": "do-not-store",
                    "owner": "user@example.com",
                },
            }
        ],
    )

    assert stored == 1
    row = client.events.inserted[0]
    assert row["workspace_id"] == "ws_1"
    assert row["session_id_hash"] == telemetry.hash_identifier("browser-session-1")
    assert row["properties"] == {
        "route": "/workers/new",
        "secret": "[redacted]",
        "owner": "[redacted-email]",
    }


def test_record_events_respects_workspace_opt_out(monkeypatch):
    monkeypatch.setattr(telemetry, "telemetry_enabled", lambda workspace_id: False)

    stored = telemetry.record_events(
        user_id="00000000-0000-0000-0000-000000000001",
        workspace_id="ws_1",
        events=[{"event_name": "worker.created"}],
    )

    assert stored == 0


def test_ingest_route_requires_active_workspace(monkeypatch):
    monkeypatch.setattr(telemetry_routes, "get_active_workspace_id", lambda: None)
    payload = telemetry_routes.TelemetryIngestRequest(
        events=[telemetry_routes.TelemetryEventIn(event_name="worker.created")]
    )

    try:
        asyncio.run(
            telemetry_routes.ingest_events(
                payload,
                AuthContext(user_id="user-1", email="u@example.com", scopes=()),
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 500
    else:
        raise AssertionError("expected missing active workspace to raise")


def test_telemetry_migration_has_scoped_tables_and_policies():
    text = Path("supabase/migrations/0017_telemetry_events.sql").read_text()

    assert "create table if not exists public.telemetry_events" in text
    assert "workspace_id text not null references public.workspaces" in text
    assert "session_id_hash text" in text
    assert "enable row level security" in text
    assert "Users manage own telemetry events" in text
    assert "raw_ip" not in text.lower()


def test_ingest_events_returns_200_on_connection_drop(monkeypatch):
    """Telemetry is fire-and-forget: a Supabase connection drop must not surface
    as an HTTP 500. The handler fail-softs (stored=0, 200) ONLY for the
    connection-drop family (httpx/httpcore RemoteProtocolError/ConnectError/etc.)."""

    def _explode(**_kwargs):
        raise httpx.RemoteProtocolError(
            "Server disconnected without sending a complete message body"
        )

    monkeypatch.setattr(telemetry_routes, "get_active_workspace_id", lambda: "ws-test")
    monkeypatch.setattr(telemetry, "record_events", _explode)

    payload = telemetry_routes.TelemetryIngestRequest(
        events=[telemetry_routes.TelemetryEventIn(event_name="worker.created")]
    )
    result = asyncio.run(
        telemetry_routes.ingest_events(
            payload,
            AuthContext(user_id="user-1", email="u@example.com", scopes=()),
        )
    )

    assert result.accepted == 1
    assert result.stored == 0
    assert result.telemetry_enabled is True


def test_ingest_events_propagates_unexpected_error(monkeypatch):
    """A genuine bug (TypeError/KeyError/schema mismatch) is NOT a connection drop
    and MUST NOT be masked as a 200. It must propagate so the breakage is visible."""

    def _bug(**_kwargs):
        raise TypeError("record_events() got an unexpected keyword argument 'foo'")

    monkeypatch.setattr(telemetry_routes, "get_active_workspace_id", lambda: "ws-test")
    monkeypatch.setattr(telemetry, "record_events", _bug)

    payload = telemetry_routes.TelemetryIngestRequest(
        events=[telemetry_routes.TelemetryEventIn(event_name="worker.created")]
    )
    with pytest.raises(TypeError):
        asyncio.run(
            telemetry_routes.ingest_events(
                payload,
                AuthContext(user_id="user-1", email="u@example.com", scopes=()),
            )
        )
