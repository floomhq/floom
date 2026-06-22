"""
Tests for GET /integrations/triggers?app=<slug> filtering.

Verifies:
  - Without ?app: returns all triggers (existing behaviour).
  - With ?app=gmail: returns only Gmail triggers.
  - With ?app=unknown: returns empty list.
  - Filtering is done on the cached full catalog (only one Composio call).
"""

import importlib
import sys
import types
from pathlib import Path


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "test-signing-key")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_URL", "https://example.test/composio-events")
    # Ensure auth middleware does not block test requests (empty = dev mode / no auth)
    monkeypatch.setenv("FLOOM_SECRET", "")
    monkeypatch.setenv("WORKEROS_DEV", "1")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    composio_client = importlib.import_module("composio_client")
    return main, composio_client


# Fake trigger catalog with triggers from two apps
FAKE_TRIGGERS = [
    {
        "slug": "GMAIL_NEW_EMAIL",
        "name": "GMAIL_NEW_EMAIL",
        "display_name": "New Email",
        "toolkit": {"slug": "gmail"},
    },
    {
        "slug": "GMAIL_NEW_LABEL",
        "name": "GMAIL_NEW_LABEL",
        "display_name": "New Label Applied",
        "toolkit": {"slug": "gmail"},
    },
    {
        "slug": "SLACK_MESSAGE_POSTED",
        "name": "SLACK_MESSAGE_POSTED",
        "display_name": "Message Posted",
        "toolkit": {"slug": "slack"},
    },
    {
        "slug": "HUBSPOT_DEAL_CREATED",
        "name": "HUBSPOT_DEAL_CREATED",
        "display_name": "Deal Created",
        "app": {"slug": "hubspot"},
    },
]


def test_triggers_no_filter_returns_all(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    call_count = [0]

    def fake_list_triggers():
        call_count[0] += 1
        return FAKE_TRIGGERS

    monkeypatch.setattr(composio_client, "list_triggers", fake_list_triggers)
    # Reset cache
    main._trigger_catalog_cache["items"] = None
    main._trigger_catalog_cache["expires_at"] = 0.0

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        res = client.get("/integrations/triggers")

    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 4
    slugs = {item["slug"] for item in items}
    assert "GMAIL_NEW_EMAIL" in slugs
    assert "SLACK_MESSAGE_POSTED" in slugs
    assert call_count[0] == 1


def test_triggers_app_filter_gmail_returns_only_gmail(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)
    call_count = [0]

    def fake_list_triggers():
        call_count[0] += 1
        return FAKE_TRIGGERS

    monkeypatch.setattr(composio_client, "list_triggers", fake_list_triggers)
    main._trigger_catalog_cache["items"] = None
    main._trigger_catalog_cache["expires_at"] = 0.0

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        res = client.get("/integrations/triggers?app=gmail")

    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 2
    for item in items:
        assert item["toolkit"]["slug"] == "gmail"
    slugs = {item["slug"] for item in items}
    assert "GMAIL_NEW_EMAIL" in slugs
    assert "GMAIL_NEW_LABEL" in slugs
    assert "SLACK_MESSAGE_POSTED" not in slugs


def test_triggers_app_filter_unknown_returns_empty(monkeypatch, tmp_path):
    main, composio_client = _load_api(monkeypatch, tmp_path)

    def fake_list_triggers():
        return FAKE_TRIGGERS

    monkeypatch.setattr(composio_client, "list_triggers", fake_list_triggers)
    main._trigger_catalog_cache["items"] = None
    main._trigger_catalog_cache["expires_at"] = 0.0

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        res = client.get("/integrations/triggers?app=nonexistent_app")

    assert res.status_code == 200
    assert res.json()["items"] == []


def test_triggers_app_filter_uses_cache_avoids_extra_composio_call(monkeypatch, tmp_path):
    """Filtering by ?app should not trigger a second Composio API call."""
    main, composio_client = _load_api(monkeypatch, tmp_path)
    call_count = [0]

    def fake_list_triggers():
        call_count[0] += 1
        return FAKE_TRIGGERS

    monkeypatch.setattr(composio_client, "list_triggers", fake_list_triggers)
    main._trigger_catalog_cache["items"] = None
    main._trigger_catalog_cache["expires_at"] = 0.0

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        # First call: populates cache
        r1 = client.get("/integrations/triggers")
        # Second call: filtered, should hit cache
        r2 = client.get("/integrations/triggers?app=slack")
        # Third call: different filter, still cache
        r3 = client.get("/integrations/triggers?app=gmail")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 200
    # Only one Composio call despite three requests
    assert call_count[0] == 1
    assert len(r2.json()["items"]) == 1
    assert r2.json()["items"][0]["slug"] == "SLACK_MESSAGE_POSTED"
    assert len(r3.json()["items"]) == 2


def test_triggers_app_filter_hubspot_uses_app_field(monkeypatch, tmp_path):
    """Triggers using 'app' field instead of 'toolkit' should also be filtered correctly."""
    main, composio_client = _load_api(monkeypatch, tmp_path)

    monkeypatch.setattr(composio_client, "list_triggers", lambda: FAKE_TRIGGERS)
    main._trigger_catalog_cache["items"] = None
    main._trigger_catalog_cache["expires_at"] = 0.0

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        res = client.get("/integrations/triggers?app=hubspot")

    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["slug"] == "HUBSPOT_DEAL_CREATED"
