from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency",
        "auth.factory", "auth.interface", "auth.local", "contexts",
        "chat_service",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _seed_connection(repos, owner: str, app_name: str):
    repos.connections.upsert(
        user_id=owner,
        id=f"{app_name}-local",
        app_name=app_name,
        composio_connection_id=f"ca_{app_name}",
        status="active",
        account_label=f"{app_name} account",
        created_at="2026-06-05T00:00:00Z",
        updated_at="2026-06-05T00:00:00Z",
    )


def test_assistant_channel_status_reports_connections_and_binding(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()
    _seed_connection(repos, owner, "slack")

    with TestClient(main.app, headers={"x-floom-secret": "test-secret"}) as client:
        initial = client.get("/assistant/channels/status")
        assert initial.status_code == 200, initial.text
        slack = next(item for item in initial.json()["channels"] if item["provider"] == "slack")
        assert slack["oauth_connected"] is True
        assert slack["binding"] is None

        saved = client.put(
            "/assistant/channels/slack/binding",
            json={
                "target_id": "C123",
                "target_label": "#ops",
                "metadata": {"team_id": "T123", "is_private": "0"},
            },
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["target_label"] == "#ops"

        after = client.get("/assistant/channels/status").json()
        slack = next(item for item in after["channels"] if item["provider"] == "slack")
        assert slack["binding"]["target_id"] == "C123"
        assert slack["binding"]["metadata"]["team_id"] == "T123"


def test_assistant_channel_options_use_live_composio_connection(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()
    _seed_connection(repos, owner, "slack")
    _seed_connection(repos, owner, "whatsapp")

    calls = []

    def fake_execute(*, tool_slug, connected_account_id, user_id, arguments):
        calls.append((tool_slug, connected_account_id, user_id, arguments))
        if tool_slug == "SLACK_LIST_ALL_CHANNELS":
            return {
                "data": {
                    "response_data": {
                        "channels": [
                            {"id": "C2", "name": "engineering", "is_private": False},
                            {"id": "C1", "name": "ops", "is_private": True, "context_team_id": "T1"},
                        ]
                    }
                }
            }
        return {
            "data": {
                "response_data": {
                    "phone_numbers": [
                        {
                            "id": "pn_1",
                            "display_phone_number": "+49 170 000000",
                            "verified_name": "Workeros",
                            "quality_rating": "GREEN",
                        }
                    ]
                }
            }
        }

    monkeypatch.setattr(main, "_composio_tool_execute", fake_execute)

    with TestClient(main.app, headers={"x-floom-secret": "test-secret"}) as client:
        slack = client.get("/assistant/channels/slack/options")
        assert slack.status_code == 200, slack.text
        assert [option["label"] for option in slack.json()["options"]] == ["#engineering", "#ops"]

        whatsapp = client.get("/assistant/channels/whatsapp/options")
        assert whatsapp.status_code == 200, whatsapp.text
        assert whatsapp.json()["options"][0]["label"] == "+49 170 000000"
        assert calls[0][0] == "SLACK_LIST_ALL_CHANNELS"
        assert calls[1][0] == "WHATSAPP_GET_PHONE_NUMBERS"


def test_assistant_channel_binding_requires_oauth_connection(monkeypatch, tmp_path):
    _db, main = _load_app(monkeypatch, tmp_path)

    with TestClient(main.app, headers={"x-floom-secret": "test-secret"}) as client:
        resp = client.put(
            "/assistant/channels/whatsapp/binding",
            json={"target_id": "pn_1", "target_label": "+49 170 000000"},
        )
        assert resp.status_code == 409
