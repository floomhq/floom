"""Tests for PR Q: full-page marketplace, category filters, multi-account, scope UX.

Run from repo root:
    cd apps/api && python3 -m pytest ../../tests/test_pr_q_connections_ux.py -x -q
"""

import importlib
import json
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import patch

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
        resp = client.post("/connections", json={"app_name": app_name}, headers={})
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# #35 - Comma-separated category filter OR semantics
# ---------------------------------------------------------------------------

class TestCategoryFilterOrSemantics:
    """catalog endpoint accepts comma-separated categories and returns union."""

    def _make_catalog_response(self, categories: list[str]) -> dict:
        return {
            "items": [
                {"slug": "testapp", "name": "TestApp", "logo_url": "https://example.com/logo.png",
                 "description": "A test app", "categories": categories, "tools_count": 5,
                 "triggers_count": 2},
            ],
            "page": 1,
            "limit": 30,
            "total_items": 1,
            "total_pages": 1,
            "next_page": None,
            "categories": categories,
        }

    def test_comma_separated_category_returns_union(self, monkeypatch, tmp_path):
        """Requesting category=team-chat,team-collaboration returns apps from both."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        team_chat_items = [
            {"slug": "slack", "name": "Slack", "logo_url": "https://example.com/slack.png",
             "description": "", "categories": ["team-chat"], "tools_count": 10, "triggers_count": 3}
        ]
        team_collab_items = [
            {"slug": "notion", "name": "Notion", "logo_url": "https://example.com/notion.png",
             "description": "", "categories": ["team-collaboration"], "tools_count": 8, "triggers_count": 1}
        ]

        def mock_list_catalog(*, page, limit, search, category):
            if category == "team-chat":
                return {
                    "items": team_chat_items, "page": 1, "limit": limit, "total_items": 1,
                    "total_pages": 1, "next_page": None, "categories": ["team-chat"],
                }
            if category == "team-collaboration":
                return {
                    "items": team_collab_items, "page": 1, "limit": limit, "total_items": 1,
                    "total_pages": 1, "next_page": None, "categories": ["team-collaboration"],
                }
            return {
                "items": [], "page": 1, "limit": limit, "total_items": 0,
                "total_pages": 1, "next_page": None, "categories": [],
            }

        with patch("composio_client.list_catalog_apps", side_effect=mock_list_catalog):
            resp = client.get(
                "/integrations/catalog",
                params={"category": "team-chat,team-collaboration", "limit": 30},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        slugs = {item["slug"] for item in body["items"]}
        assert "slack" in slugs, f"Expected slack in results, got: {slugs}"
        assert "notion" in slugs, f"Expected notion in results, got: {slugs}"

    def test_single_category_still_works(self, monkeypatch, tmp_path):
        """Single-category requests still work as before."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        def mock_list_catalog(*, page, limit, search, category):
            return {
                "items": [
                    {"slug": "gmail", "name": "Gmail", "logo_url": "https://example.com/gmail.png",
                     "description": "", "categories": ["email"], "tools_count": 5, "triggers_count": 2}
                ],
                "page": 1, "limit": limit, "total_items": 1, "total_pages": 1,
                "next_page": None, "categories": ["email"],
            }

        with patch("composio_client.list_catalog_apps", side_effect=mock_list_catalog):
            resp = client.get(
                "/integrations/catalog",
                params={"category": "email", "limit": 30},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert any(item["slug"] == "gmail" for item in body["items"])

    def test_no_category_returns_all(self, monkeypatch, tmp_path):
        """Empty category returns all apps (no filter applied)."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        def mock_list_catalog(*, page, limit, search, category):
            return {
                "items": [
                    {"slug": "gmail", "name": "Gmail", "logo_url": "x", "description": "",
                     "categories": ["email"], "tools_count": 5, "triggers_count": 2},
                    {"slug": "slack", "name": "Slack", "logo_url": "x", "description": "",
                     "categories": ["team-chat"], "tools_count": 10, "triggers_count": 3},
                ],
                "page": 1, "limit": limit, "total_items": 2, "total_pages": 1,
                "next_page": None, "categories": ["email", "team-chat"],
            }

        with patch("composio_client.list_catalog_apps", side_effect=mock_list_catalog):
            resp = client.get("/integrations/catalog", params={"limit": 30})

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["items"]) == 2


# ---------------------------------------------------------------------------
# #36 - Multiple connections per app
# ---------------------------------------------------------------------------

class TestMultipleConnectionsPerApp:
    """Multiple rows for the same app_name must not raise unique-constraint errors."""

    def test_two_gmail_connections_allowed(self, monkeypatch, tmp_path):
        """Creating two connections for gmail does not raise unique-constraint error."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        conn1 = _seed_connection(client, app_name="gmail")
        conn2 = _seed_connection(client, app_name="gmail")

        # Both rows must have distinct IDs
        assert conn1["id"] != conn2["id"]
        assert conn1["composio_connection_id"] != conn2["composio_connection_id"]

        # List returns both
        list_resp = client.get("/connections", headers={})
        assert list_resp.status_code == 200
        items = list_resp.json()
        gmail_ids = [c["id"] for c in items if c["app_name"] == "gmail"]
        assert len(gmail_ids) == 2, f"Expected 2 gmail connections, got: {gmail_ids}"

    def test_three_connections_different_apps(self, monkeypatch, tmp_path):
        """Sanity check: different apps still work normally alongside duplicates."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        _seed_connection(client, app_name="gmail")
        _seed_connection(client, app_name="gmail")
        _seed_connection(client, app_name="slack")

        list_resp = client.get("/connections", headers={})
        assert list_resp.status_code == 200
        items = list_resp.json()
        assert sum(1 for c in items if c["app_name"] == "gmail") == 2
        assert sum(1 for c in items if c["app_name"] == "slack") == 1

    def test_delete_one_gmail_leaves_other(self, monkeypatch, tmp_path):
        """Deleting one Gmail connection does not remove the other."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        conn1 = _seed_connection(client, app_name="gmail")
        conn2 = _seed_connection(client, app_name="gmail")

        with patch("composio_client.revoke_connection"):
            del_resp = client.delete(f"/connections/{conn1['id']}")
        assert del_resp.status_code == 200

        list_resp = client.get("/connections", headers={})
        items = list_resp.json()
        remaining_ids = [c["id"] for c in items if c["app_name"] == "gmail"]
        assert conn2["id"] in remaining_ids, "second Gmail connection was incorrectly removed"
        assert conn1["id"] not in remaining_ids, "deleted Gmail connection is still present"


# ---------------------------------------------------------------------------
# #37 - Scopes UX: auth_config scopes populated, fallback neutral wording
# ---------------------------------------------------------------------------

class TestScopesUX:
    """When auth_config has scopes they must appear in the connection's scopes list."""

    def test_auth_config_scopes_returned_by_account_info(self, monkeypatch, tmp_path):
        """account-info endpoint returns scopes when Composio provides them."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="gmail")
        local_id = conn["id"]

        with patch("routers.connections._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "user@example.com",
                "scopes": [
                    "https://www.googleapis.com/auth/gmail.readonly",
                    "https://www.googleapis.com/auth/gmail.send",
                ],
                "user_id": "local-user",
                "auth_config_id": "ac_gmail_123",
                "status": "active",
            }
            resp = client.get(f"/connections/{local_id}/account-info", headers={})

        assert resp.status_code == 200
        body = resp.json()
        assert "https://www.googleapis.com/auth/gmail.readonly" in body["scopes"]
        assert "https://www.googleapis.com/auth/gmail.send" in body["scopes"]
        assert "auth_config_id" not in body
        assert "user_id" not in body

    def test_auth_config_endpoint_is_internal_only(self, monkeypatch, tmp_path):
        """GET /connections/auth-configs/{id} is not publicly exposed."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        resp = client.get("/connections/auth-configs/ac_gmail_123", headers={})

        assert resp.status_code == 404

    def test_scopes_cached_after_account_info_fetch(self, monkeypatch, tmp_path):
        """After fetching account-info with scopes, the list endpoint shows them."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="slack")
        local_id = conn["id"]

        with patch("routers.connections._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "team@example.com",
                "scopes": ["channels:read", "chat:write"],
                "user_id": None,
                "auth_config_id": None,
                "status": "active",
            }
            client.get(f"/connections/{local_id}/account-info", headers={})

        list_resp = client.get("/connections", headers={})
        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert "channels:read" in item["scopes"]
        assert "chat:write" in item["scopes"]


# ---------------------------------------------------------------------------
# #19 - DB migration: unique constraint dropped
# ---------------------------------------------------------------------------

class TestMigration19:
    def test_app_name_no_longer_unique(self, monkeypatch, tmp_path):
        """Migration 19 removes the UNIQUE index on composio_connections.app_name."""
        _load_api(monkeypatch, tmp_path)
        import db as db_module

        with db_module.get_db() as conn:
            # Verify no unique index on app_name by inserting two rows with same app_name
            now = "2026-01-01T00:00:00+00:00"
            conn.execute(
                "INSERT INTO composio_connections (id, app_name, composio_connection_id, status, created_at, updated_at) "
                "VALUES (?, ?, ?, 'initiated', ?, ?)",
                (str(uuid.uuid4()), "gmail", "ca_test_1", now, now),
            )
            conn.execute(
                "INSERT INTO composio_connections (id, app_name, composio_connection_id, status, created_at, updated_at) "
                "VALUES (?, ?, ?, 'initiated', ?, ?)",
                (str(uuid.uuid4()), "gmail", "ca_test_2", now, now),
            )
            rows = conn.execute(
                "SELECT COUNT(*) as cnt FROM composio_connections WHERE app_name = 'gmail'"
            ).fetchone()
        assert rows["cnt"] == 2, f"Expected 2 gmail rows after migration 19, got {rows['cnt']}"

    def test_migration_idempotent(self, monkeypatch, tmp_path):
        """Running apply_migrations twice after migration 19 does not raise."""
        _load_api(monkeypatch, tmp_path)
        import db as db_module
        db_module.apply_migrations()
        db_module.apply_migrations()
