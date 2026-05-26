"""Tests for PR B: connections backend, scopes, account_label, test endpoint, daily sweep.

Run from repo root:
    cd apps/api && python3 -m pytest ../../tests/test_connections_backend.py -x -q
"""

import importlib
import json
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    """Bootstrap the FastAPI app with an isolated temp DB and mocked scheduler."""
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    # Dev mode: empty FLOOM_SECRET = no auth gate. Set before import so
    # load_dotenv(override=False) in main.py does not overwrite it.
    monkeypatch.setenv("FLOOM_SECRET", "")

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    return main


def _seed_connection(client: TestClient, app_name: str = "gmail") -> dict:
    """Insert a connection via the initiate endpoint (mocked Composio)."""
    fake_conn_id = f"composio_{uuid.uuid4().hex[:8]}"
    fake_redirect = "https://auth.composio.dev/oauth/redirect"

    with patch("composio_client.initiate_connection") as mock_init:
        mock_init.return_value = {
            "composio_connection_id": fake_conn_id,
            "redirect_url": fake_redirect,
        }
        resp = client.post(
            "/connections",
            json={"app_name": app_name},
            headers={},
        )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# #10 - FastAPI account-info endpoint
# ---------------------------------------------------------------------------

class TestAccountInfoEndpoint:
    def test_account_info_returns_email_and_scopes(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client)
        local_id = conn["id"]

        with patch("main._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "user@example.com",
                "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
                "user_id": "federico",
                "auth_config_id": "ac_abc123",
                "status": "active",
            }
            resp = client.get(
                f"/connections/{local_id}/account-info",
                headers={},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["email"] == "user@example.com"
        assert "https://www.googleapis.com/auth/gmail.readonly" in body["scopes"]
        assert body["auth_config_id"] == "ac_abc123"

    def test_account_info_404_for_unknown_connection(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        resp = client.get(
            "/connections/nonexistent-id/account-info",
            headers={},
        )
        assert resp.status_code == 404

    def test_account_info_caches_to_db(self, monkeypatch, tmp_path):
        """After fetching account-info, list endpoint returns scopes + account_label."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="linkedin")
        local_id = conn["id"]

        with patch("main._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "fede@example.com",
                "scopes": ["r_liteprofile"],
                "user_id": "federico",
                "auth_config_id": None,
                "status": "active",
            }
            client.get(
                f"/connections/{local_id}/account-info",
                headers={},
            )

        # Now list should have the cached values
        list_resp = client.get("/connections", headers={"x-floom-secret": ""})
        assert list_resp.status_code == 200
        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert item["account_label"] == "fede@example.com"
        assert "r_liteprofile" in item["scopes"]


# ---------------------------------------------------------------------------
# #8 + #9 - GET /connections projects scopes + account_label
# ---------------------------------------------------------------------------

class TestConnectionsListProjection:
    def test_list_returns_scopes_and_account_label_fields(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        _seed_connection(client)
        resp = client.get("/connections", headers={"x-floom-secret": ""})
        assert resp.status_code == 200
        items = resp.json()
        assert len(items) >= 1
        item = items[0]
        # Fields must be present (may be empty/null before hydration)
        assert "scopes" in item
        assert isinstance(item["scopes"], list)
        assert "account_label" in item
        assert "last_checked_at" in item
        assert "last_check_status" in item

    def test_list_with_cached_scopes(self, monkeypatch, tmp_path):
        """Scopes cached via account-info appear in list without a Composio call."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="slack")
        local_id = conn["id"]

        with patch("main._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "team@example.com",
                "scopes": ["channels:read", "chat:write"],
                "user_id": None,
                "auth_config_id": None,
                "status": "active",
            }
            client.get(
                f"/connections/{local_id}/account-info",
                headers={},
            )

        with patch("main._fetch_composio_account_info") as mock_no_call:
            list_resp = client.get("/connections", headers={"x-floom-secret": ""})
            # List should NOT call Composio (scopes cached)
            mock_no_call.assert_not_called()

        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert set(item["scopes"]) == {"channels:read", "chat:write"}


# ---------------------------------------------------------------------------
# #11 - POST /connections/{id}/test
# ---------------------------------------------------------------------------

class TestConnectionTestEndpoint:
    def test_test_returns_valid_when_active(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client)
        local_id = conn["id"]

        with patch("composio_client.check_status", return_value="active"):
            resp = client.post(
                f"/connections/{local_id}/test",
                headers={},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "valid"
        assert "tested_at" in body
        assert body["reason"]

    def test_test_returns_expired_when_expired(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client)
        local_id = conn["id"]

        with patch("composio_client.check_status", return_value="expired"):
            resp = client.post(
                f"/connections/{local_id}/test",
                headers={},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "expired"

    def test_test_returns_failed_on_exception(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client)
        local_id = conn["id"]

        with patch("composio_client.check_status", side_effect=RuntimeError("network error")):
            resp = client.post(
                f"/connections/{local_id}/test",
                headers={},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "failed"

    def test_test_updates_last_checked_at(self, monkeypatch, tmp_path):
        """After a test, list shows last_checked_at + last_check_status."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client)
        local_id = conn["id"]

        with patch("composio_client.check_status", return_value="active"):
            client.post(
                f"/connections/{local_id}/test",
                headers={},
            )

        list_resp = client.get("/connections", headers={"x-floom-secret": ""})
        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert item["last_checked_at"] is not None
        assert item["last_check_status"] == "valid"

    def test_test_404_for_unknown_connection(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        resp = client.post(
            "/connections/no-such-id/test",
            headers={},
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# #12 - DB migration 18 adds columns idempotently
# ---------------------------------------------------------------------------

class TestMigration18:
    def test_migration_adds_columns_to_connections(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import db as db_module
        with db_module.get_db() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(composio_connections)")}
        assert "last_checked_at" in cols
        assert "last_check_status" in cols
        assert "last_check_error" in cols
        assert "scopes_json" in cols
        assert "account_label" in cols

    def test_migration_adds_columns_to_secrets(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import db as db_module
        with db_module.get_db() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(secrets)")}
        assert "last_checked_at" in cols
        assert "last_check_status" in cols
        assert "last_check_error" in cols

    def test_migration_idempotent(self, monkeypatch, tmp_path):
        """Running apply_migrations twice does not raise."""
        main = _load_api(monkeypatch, tmp_path)
        import db as db_module
        # Should not raise
        db_module.apply_migrations()
        db_module.apply_migrations()
