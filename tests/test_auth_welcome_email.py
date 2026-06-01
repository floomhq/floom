from __future__ import annotations

from types import SimpleNamespace

from apps.api.routes import auth


class _Table:
    def __init__(self, *, insert_raises: bool = False) -> None:
        self.insert_raises = insert_raises
        self.inserts: list[dict] = []
        self.updates: list[dict] = []
        self.filters: list[tuple[str, str]] = []

    def insert(self, payload: dict):
        if self.insert_raises:
            raise RuntimeError("duplicate key")
        self.inserts.append(payload)
        return self

    def update(self, payload: dict):
        self.updates.append(payload)
        return self

    def eq(self, column: str, value: str):
        self.filters.append((column, value))
        return self

    def execute(self):
        return SimpleNamespace(data=[])


class _Client:
    def __init__(self, table: _Table) -> None:
        self.table_obj = table

    def table(self, name: str):
        assert name == "email_events"
        return self.table_obj


def test_welcome_email_is_skipped_when_provider_not_configured(monkeypatch):
    sent: list[object] = []
    monkeypatch.setattr(auth.email_service, "email_readiness", lambda: {"enabled": False})
    monkeypatch.setattr(auth.email_service, "send_transactional_email", sent.append)

    auth._maybe_send_welcome_email(
        SimpleNamespace(id="11111111-1111-1111-1111-111111111111", email="user@example.com")
    )

    assert sent == []


def test_welcome_email_records_dedupe_and_updates_sent(monkeypatch):
    table = _Table()
    monkeypatch.setattr(
        auth.email_service,
        "email_readiness",
        lambda: {"enabled": True, "has_api_key": True, "has_from": True},
    )
    monkeypatch.setattr(auth, "new_supabase_service_client", lambda: _Client(table))
    monkeypatch.setattr(
        auth,
        "get_cloud_settings",
        lambda: SimpleNamespace(dashboard_origin="https://workeros.floom.dev"),
    )
    monkeypatch.setattr(
        auth.email_service,
        "send_transactional_email",
        lambda message: auth.email_service.EmailSendResult(
            status="sent",
            provider="resend",
            message_id="email_123",
        ),
    )

    auth._maybe_send_welcome_email(
        SimpleNamespace(id="11111111-1111-1111-1111-111111111111", email="User@Example.com")
    )

    assert table.inserts == [
        {
            "dedupe_key": "welcome:11111111-1111-1111-1111-111111111111",
            "user_id": "11111111-1111-1111-1111-111111111111",
            "kind": "welcome",
            "recipient_email": "user@example.com",
            "status": "pending",
        }
    ]
    assert table.updates[-1]["status"] == "sent"
    assert table.updates[-1]["provider"] == "resend"
    assert table.updates[-1]["provider_message_id"] == "email_123"


def test_welcome_email_duplicate_event_does_not_send(monkeypatch):
    table = _Table(insert_raises=True)
    sent: list[object] = []
    monkeypatch.setattr(
        auth.email_service,
        "email_readiness",
        lambda: {"enabled": True, "has_api_key": True, "has_from": True},
    )
    monkeypatch.setattr(auth, "new_supabase_service_client", lambda: _Client(table))
    monkeypatch.setattr(auth.email_service, "send_transactional_email", sent.append)

    auth._maybe_send_welcome_email(
        SimpleNamespace(id="11111111-1111-1111-1111-111111111111", email="user@example.com")
    )

    assert sent == []
