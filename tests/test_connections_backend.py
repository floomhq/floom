"""Tests for PR B: connections backend, scopes, account_label, test endpoint, daily sweep.

Run from repo root:
    cd apps/api && python3 -m pytest ../../tests/test_connections_backend.py -x -q
"""

import importlib
import sys
import json
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


AUTH_HEADERS = {"x-floom-secret": "test-secret-connections"}


def _httpx_response(status_code: int, body: dict) -> types.SimpleNamespace:
    # .headers and .text are required since the streamable-HTTP probe reads
    # the mcp-session-id response header and may parse SSE-framed bodies.
    response = types.SimpleNamespace(status_code=status_code, headers={}, text=json.dumps(body))
    response.json = lambda: body
    return response


def _load_api(monkeypatch, tmp_path):
    """Bootstrap the FastAPI app with an isolated temp DB and mocked scheduler."""
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADERS["x-floom-secret"])

    sys.path.insert(0, str(api_dir))
    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "worker_registry",
        "run_service", "composio_client", "auth", "auth.context",
        "auth.dependency", "auth.factory", "auth.interface", "auth.local",
        "auth.local_workspaces",
    ]:
        sys.modules.pop(name, None)
    # routers.* must reload in lockstep with main/auth: a cached router pins the
    # previous auth.dependency instance, so dependency_overrides keyed on the
    # fresh main.get_auth_context would miss its routes (/me), and module-level
    # router caches (integrations trigger catalog) would leak across tests.
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
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
            headers=AUTH_HEADERS,
        )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# #10 - FastAPI account-info endpoint
# ---------------------------------------------------------------------------

class TestAccountInfoEndpoint:
    def test_me_returns_auth_context_identity(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)

        from auth import AuthContext

        async def fake_auth_context():
            return AuthContext(
                user_id="user_123",
                email="fed@example.com",
                scopes=("admin", "cloud"),
            )

        main.app.dependency_overrides[main.get_auth_context] = fake_auth_context
        client = TestClient(main.app, raise_server_exceptions=True)
        resp = client.get("/me", headers=AUTH_HEADERS)
        main.app.dependency_overrides.clear()

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["user_id"] == "user_123"
        assert body["email"] == "fed@example.com"
        assert body["display_name"] == "fed@example.com"
        assert body["scopes"] == ["admin", "cloud"]

    def test_account_info_returns_email_and_scopes(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client)
        local_id = conn["id"]

        with patch("routers.connections._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "user@example.com",
                "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
                "user_id": "federico",
                "auth_config_id": "ac_abc123",
                "status": "active",
            }
            resp = client.get(
                f"/connections/{local_id}/account-info",
                headers=AUTH_HEADERS,
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Single-tenant owner view: the owner sees their OWN connected email.
        assert body["email"] == "user@example.com"
        assert "https://www.googleapis.com/auth/gmail.readonly" in body["scopes"]
        # Still must not leak internal Composio plumbing identifiers.
        assert "auth_config_id" not in body
        assert "user_id" not in body
        assert "connected_at" in body

    def test_account_info_404_for_unknown_connection(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        resp = client.get(
            "/connections/nonexistent-id/account-info",
            headers=AUTH_HEADERS,
        )
        assert resp.status_code == 404

    def test_account_info_caches_to_db(self, monkeypatch, tmp_path):
        """After fetching account-info, list endpoint returns scopes + account_label."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="linkedin")
        local_id = conn["id"]

        with patch("routers.connections._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "fede@example.com",
                "scopes": ["r_liteprofile"],
                "user_id": "federico",
                "auth_config_id": None,
                "status": "active",
            }
            client.get(
                f"/connections/{local_id}/account-info",
                headers=AUTH_HEADERS,
            )

        # Single-tenant owner view: the list endpoint returns the owner's OWN
        # real account identity (the connected email), not a "Connected account"
        # placeholder. Redaction is reserved for a future cross-user path.
        list_resp = client.get("/connections", headers=AUTH_HEADERS)
        assert list_resp.status_code == 200
        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert item["account_label"] == "fede@example.com"
        assert item["display_name"] == "fede@example.com"
        assert "r_liteprofile" in item["scopes"]


class TestComposioScopeParsing:
    """_fetch_composio_account_info must parse the real `scope` STRING that
    Composio v3 returns under data/params/state.val (no `scopes` list)."""

    def _info(self, main, account_payload):
        # _fetch_composio_account_info does `import requests as _requests`
        # locally, so patch the module-level requests.get.
        with patch("requests.get") as mock_get:
            mock_get.return_value.ok = True
            mock_get.return_value.json.return_value = account_payload
            return main._fetch_composio_account_info("ca_test", user_id="federico")

    def test_parses_comma_delimited_github_scope_string(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        info = self._info(main, {
            "toolkit": {"slug": "github"},
            "data": {"scope": "codespace,gist,repo,user,workflow"},
        })
        assert info["scopes"] == ["codespace", "gist", "repo", "user", "workflow"]

    def test_parses_space_delimited_google_scope_string(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        info = self._info(main, {
            "toolkit": {"slug": "gmail"},
            "params": {"scope": "https://a/x https://a/y"},
        })
        assert info["scopes"] == ["https://a/x", "https://a/y"]

    def test_reads_scope_from_state_val(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        info = self._info(main, {
            "toolkit": {"slug": "github"},
            "state": {"val": {"scope": "repo,user"}},
        })
        assert info["scopes"] == ["repo", "user"]

    def test_prefers_explicit_scopes_list_when_present(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        info = self._info(main, {
            "toolkit": {"slug": "slack"},
            "scopes": ["channels:read", "chat:write"],
            "data": {"scope": "ignored"},
        })
        assert info["scopes"] == ["channels:read", "chat:write"]

    def test_reads_handle_when_email_is_absent(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        info = self._info(main, {
            "toolkit": {"slug": "github"},
            "data": {"login": "floomhq"},
        })
        assert info["account_label"] == "floomhq"


# ---------------------------------------------------------------------------
# #8 + #9 - GET /connections projects scopes + account_label
# ---------------------------------------------------------------------------

class TestConnectionsListProjection:
    def test_list_returns_scopes_and_account_label_fields(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        _seed_connection(client)
        resp = client.get("/connections", headers=AUTH_HEADERS)
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

        with patch("routers.connections._fetch_composio_account_info") as mock_fetch:
            mock_fetch.return_value = {
                "email": "team@example.com",
                "scopes": ["channels:read", "chat:write"],
                "user_id": None,
                "auth_config_id": None,
                "status": "active",
            }
            client.get(
                f"/connections/{local_id}/account-info",
                headers=AUTH_HEADERS,
            )

        with patch("routers.connections._fetch_composio_account_info") as mock_no_call:
            list_resp = client.get("/connections", headers=AUTH_HEADERS)
            # Cached scopes keep the list endpoint local.
            mock_no_call.assert_not_called()

        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert set(item["scopes"]) == {"channels:read", "chat:write"}

    def test_list_refreshes_stale_initiated_status(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="github")
        local_id = conn["id"]
        composio_id = conn["composio_connection_id"]
        stale_time = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()

        with main.get_db() as db:
            db.execute(
                """
                UPDATE composio_connections
                SET status = 'initiated', updated_at = ?, last_checked_at = NULL, last_check_status = NULL
                WHERE id = ?
                """,
                (stale_time, local_id),
            )

        with patch("composio_client.check_status", return_value="valid") as mock_check:
            resp = client.get("/connections", headers=AUTH_HEADERS)

        assert resp.status_code == 200
        mock_check.assert_called_once_with(composio_id)
        item = next((c for c in resp.json() if c["id"] == local_id), None)
        assert item is not None
        assert item["status"] == "active"
        assert item["last_checked_at"] is not None
        assert item["last_check_status"] == "active"

    def test_status_endpoint_normalizes_valid_to_active(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="github")
        local_id = conn["id"]

        with main.get_db() as db:
            db.execute(
                "UPDATE composio_connections SET status = 'initiated' WHERE id = ?",
                (local_id,),
            )

        with patch("composio_client.check_status", return_value="valid"):
            resp = client.get(f"/connections/{local_id}/status", headers=AUTH_HEADERS)

        assert resp.status_code == 200
        assert resp.json()["status"] == "active"

    def test_list_skips_fresh_initiated_status(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="github")
        local_id = conn["id"]

        with main.get_db() as db:
            db.execute(
                "UPDATE composio_connections SET status = 'initiated', updated_at = ? WHERE id = ?",
                (datetime.now(timezone.utc).isoformat(), local_id),
            )

        with patch("composio_client.check_status") as mock_check:
            resp = client.get("/connections", headers=AUTH_HEADERS)

        assert resp.status_code == 200
        mock_check.assert_not_called()
        item = next((c for c in resp.json() if c["id"] == local_id), None)
        assert item is not None
        assert item["status"] == "initiated"

    def test_list_uses_last_checked_cache_for_pending_status(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="gmail")
        local_id = conn["id"]
        stale_time = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()

        with main.get_db() as db:
            db.execute(
                """
                UPDATE composio_connections
                SET status = 'pending', updated_at = ?, last_checked_at = ?
                WHERE id = ?
                """,
                (stale_time, datetime.now(timezone.utc).isoformat(), local_id),
            )

        with patch("composio_client.check_status") as mock_check:
            resp = client.get("/connections", headers=AUTH_HEADERS)

        assert resp.status_code == 200
        mock_check.assert_not_called()
        item = next((c for c in resp.json() if c["id"] == local_id), None)
        assert item is not None
        assert item["status"] == "pending"


class TestConnectionCallbackAndComposio503:
    def test_callback_accepts_connected_account_id_alias_and_persists_status(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="gmail")

        with patch("composio_client.check_status", return_value="valid"):
            resp = client.get(
                f"/connections/callback?connected_account_id={conn['composio_connection_id']}&status=success",
                follow_redirects=False,
            )

        assert resp.status_code in {302, 307}
        assert resp.headers["location"].startswith("https://workers.floom.dev/connections?connected=1")
        listed = client.get("/connections", headers=AUTH_HEADERS)
        item = next(c for c in listed.json() if c["id"] == conn["id"])
        assert item["status"] == "active"

    def test_callback_success_promotes_transient_initiated_to_active(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="gmail")

        with patch("composio_client.check_status", return_value="initiated"):
            resp = client.get(
                f"/connections/callback?connection_id={conn['composio_connection_id']}&status=success",
                follow_redirects=False,
            )

        assert resp.status_code in {302, 307}
        listed = client.get("/connections", headers=AUTH_HEADERS)
        item = next(c for c in listed.json() if c["id"] == conn["id"])
        assert item["status"] == "active"

    def test_missing_composio_api_key_returns_503_for_connect_and_account_info(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="gmail")
        monkeypatch.setenv("COMPOSIO_API_KEY", "")

        connect = client.post(
            "/connections",
            json={"app_name": "gmail"},
            headers=AUTH_HEADERS,
        )
        assert connect.status_code == 503
        assert "Composio is not configured" in connect.json()["detail"]

        account_info = client.get(f"/connections/{conn['id']}/account-info", headers=AUTH_HEADERS)
        assert account_info.status_code == 503
        assert "Composio" in account_info.json()["detail"]

    def test_connect_upstream_failure_returns_graceful_503(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        with patch("composio_client.initiate_connection") as mock_init:
            mock_init.side_effect = RuntimeError("raw upstream traceback detail")
            resp = client.post(
                "/connections",
                json={"app_name": "unknown-oauth-app"},
                headers=AUTH_HEADERS,
            )

        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert "integration provider" in detail
        assert "raw upstream traceback detail" not in detail
        assert "traceback" not in detail.lower()

    def test_missing_composio_api_key_returns_503_for_catalog_and_triggers(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        monkeypatch.setenv("COMPOSIO_API_KEY", "")

        catalog = client.get("/integrations/catalog", headers=AUTH_HEADERS)
        assert catalog.status_code == 503
        assert "Composio is not configured" in catalog.json()["detail"]

        multi_category_catalog = client.get("/integrations/catalog?category=a,b", headers=AUTH_HEADERS)
        assert multi_category_catalog.status_code == 503
        assert "Composio is not configured" in multi_category_catalog.json()["detail"]

        triggers = client.get("/integrations/triggers", headers=AUTH_HEADERS)
        assert triggers.status_code == 503
        assert "Composio is not configured" in triggers.json()["detail"]


class TestMCPConnections:
    def test_create_list_status_test_and_delete_mcp_connection(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        create_resp = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={
                "label": "github",
                "url": "https://api.githubcopilot.com/mcp/",
                "auth_secret": "GITHUB_PAT",
                "allowed_tools": ["list_pull_requests", "get_repo"],
            },
        )
        assert create_resp.status_code == 200, create_resp.text
        created = create_resp.json()
        assert created["kind"] == "mcp"
        assert created["status"] == "active"
        assert created["mcp_label"] == "github"
        assert created["mcp_url"] == "https://api.githubcopilot.com/mcp/"
        assert created["mcp_auth_secret"] == "GITHUB_PAT"
        assert created["mcp_allowed_tools"] == ["list_pull_requests", "get_repo"]

        with patch("composio_client.check_status") as mock_check:
            list_resp = client.get("/connections", headers=AUTH_HEADERS)
        assert list_resp.status_code == 200
        mock_check.assert_not_called()
        listed = next(item for item in list_resp.json() if item["id"] == created["id"])
        assert listed["kind"] == "mcp"
        assert listed["mcp_allowed_tools"] == ["list_pull_requests", "get_repo"]

        with patch("composio_client.check_status") as mock_check:
            status_resp = client.get(f"/connections/{created['id']}/status", headers=AUTH_HEADERS)
        assert status_resp.status_code == 200
        mock_check.assert_not_called()
        assert status_resp.json()["kind"] == "mcp"

        with patch("httpx.post") as mock_post, patch("httpx.get") as mock_get:
            mock_post.side_effect = [
                _httpx_response(
                    200,
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "github-mcp", "version": "1.0"},
                        },
                    },
                ),
                _httpx_response(
                    200,
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "result": {
                            "tools": [
                                {"name": "list_pull_requests"},
                                {"name": "get_repo"},
                            ]
                        },
                    },
                ),
            ]
            test_resp = client.post(f"/connections/{created['id']}/test", headers=AUTH_HEADERS)
        assert test_resp.status_code == 200
        assert mock_post.call_count == 2
        mock_get.assert_not_called()
        assert test_resp.json()["status"] == "valid"
        assert "2 tools" in test_resp.json()["reason"]

        with patch("composio_client.revoke_connection") as mock_revoke:
            delete_resp = client.delete(f"/connections/{created['id']}", headers=AUTH_HEADERS)
        assert delete_resp.status_code == 200
        mock_revoke.assert_not_called()
        assert delete_resp.json()["status"] == "deleted"

    def test_create_mcp_connection_validates_label_url_and_secret(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        bad_url = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={"label": "github", "url": "ftp://example.com/mcp"},
        )
        assert bad_url.status_code == 400

        bad_secret = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={
                "label": "github",
                "url": "https://example.com/mcp",
                "auth_secret": "bad-secret",
            },
        )
        assert bad_secret.status_code == 400

        bad_stdio = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={"label": "github", "transport": "stdio", "url": "https://example.com/mcp"},
        )
        assert bad_stdio.status_code == 400

        raw_env = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={
                "label": "filesystem",
                "transport": "stdio",
                "command": "npx",
                "env": {"GITHUB_TOKEN": "raw-token-value"},
            },
        )
        assert raw_env.status_code == 400
        assert "secret:SECRET_NAME" in raw_env.text

        bad_env_secret = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={
                "label": "filesystem",
                "transport": "stdio",
                "command": "npx",
                "env": {"GITHUB_TOKEN": "secret:bad-secret"},
            },
        )
        assert bad_env_secret.status_code == 400

    def test_test_mcp_connection_reports_allowed_tool_mismatch(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        create_resp = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={
                "label": "files-mcp",
                "url": "https://example.com/mcp",
                "allowed_tools": ["read_file", "write_file"],
            },
        )
        assert create_resp.status_code == 200, create_resp.text
        created = create_resp.json()

        with patch("httpx.post") as mock_post:
            mock_post.side_effect = [
                _httpx_response(
                    200,
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "filesystem", "version": "1.0"},
                        },
                    },
                ),
                _httpx_response(
                    200,
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "result": {
                            "tools": [{"name": "read_file"}],
                        },
                    },
                ),
            ]
            resp = client.post(f"/connections/{created['id']}/test", headers=AUTH_HEADERS)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "failed"
        assert "Allowed-tool mismatch" in body["reason"]

    def test_create_stdio_mcp_connection(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        create_resp = client.post(
            "/connections/mcp",
            headers=AUTH_HEADERS,
            json={
                "label": "filesystem",
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
                "env": {"GITHUB_TOKEN": "secret:GITHUB_PAT"},
                "cwd": "/workspace",
                "allowed_tools": ["read_file"],
            },
        )

        assert create_resp.status_code == 200, create_resp.text
        created = create_resp.json()
        assert created["kind"] == "mcp"
        assert created["mcp_transport"] == "stdio"
        assert created["mcp_url"] is None
        assert created["mcp_command"] == "npx"
        assert created["mcp_args"] == ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
        assert created["mcp_env"] == {"GITHUB_TOKEN": "secret:GITHUB_PAT"}
        assert created["mcp_cwd"] == "/workspace"
        assert created["mcp_auth_secret"] is None
        assert created["mcp_allowed_tools"] == ["read_file"]

    def test_create_mcp_connection_rejects_duplicate_label(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        payload = {"label": "github", "url": "https://example.com/mcp"}

        first = client.post("/connections/mcp", headers=AUTH_HEADERS, json=payload)
        assert first.status_code == 200

        duplicate = client.post("/connections/mcp", headers=AUTH_HEADERS, json=payload)
        assert duplicate.status_code == 409

    def test_migration_repairs_version_28_without_mcp_columns(self, monkeypatch, tmp_path):
        api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
        db_path = tmp_path / "floom.db"
        monkeypatch.setenv("FLOOM_DB", str(db_path))
        sys.path.insert(0, str(api_dir))
        for name in list(sys.modules):
            if name == "db" or name.startswith("db."):
                sys.modules.pop(name, None)

        import sqlite3

        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            INSERT INTO schema_version (version, applied_at)
                VALUES (28, '2026-05-28T00:00:00+00:00');
            CREATE TABLE composio_connections (
                id TEXT PRIMARY KEY,
                app_name TEXT NOT NULL,
                composio_connection_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'initiated',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_checked_at TEXT,
                last_check_status TEXT,
                last_check_error TEXT,
                scopes_json TEXT,
                account_label TEXT,
                user_id TEXT NOT NULL DEFAULT 'federico'
            );
            CREATE TABLE skill_versions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                bundle_path TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(name, version)
            );
            CREATE TABLE workers (
                id TEXT PRIMARY KEY,
                skill_version_id TEXT NOT NULL,
                name TEXT NOT NULL,
                trigger_type TEXT NOT NULL DEFAULT 'manual',
                cron_expr TEXT,
                cron_timezone TEXT,
                next_run_at TEXT,
                last_scheduled_run_at TEXT,
                webhook_secret_hash TEXT,
                notify_email INTEGER DEFAULT 0 NOT NULL,
                notify_webhook_url TEXT,
                grants_json TEXT,
                input_values_json TEXT,
                enabled INTEGER DEFAULT 1 NOT NULL,
                created_at TEXT NOT NULL,
                owner_id TEXT NOT NULL DEFAULT 'federico',
                composio_trigger_id TEXT,
                composio_event TEXT,
                triggers_json TEXT,
                FOREIGN KEY(skill_version_id) REFERENCES skill_versions(id)
            );
            CREATE TABLE runs (
                id TEXT PRIMARY KEY
            );
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                uploaded_by TEXT,
                uploaded_at TEXT NOT NULL
            );
            """
        )
        conn.close()

        legacy_db = importlib.import_module("db._legacy_sqlite")
        legacy_db.init_db()

        conn = sqlite3.connect(db_path)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(composio_connections)").fetchall()}
        assert {
            "kind",
            "mcp_label",
            "mcp_url",
            "mcp_auth_secret",
            "mcp_allowed_tools_json",
            "display_name",
        } <= columns
        # The repaired DB must be migrated to the latest version. Derive it from
        # the migration registry rather than hardcoding a number that goes stale
        # every time a migration is appended (was 36, now len(MIGRATIONS)).
        expected_version = len(legacy_db.MIGRATIONS)
        assert (
            conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
            == expected_version
        )
        file_owner_tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "file_owners" in file_owner_tables


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
                headers=AUTH_HEADERS,
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
                headers=AUTH_HEADERS,
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
                headers=AUTH_HEADERS,
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
                headers=AUTH_HEADERS,
            )

        list_resp = client.get("/connections", headers=AUTH_HEADERS)
        items = list_resp.json()
        item = next((c for c in items if c["id"] == local_id), None)
        assert item is not None
        assert item["last_checked_at"] is not None
        assert item["last_check_status"] == "valid"

    def test_test_promotes_connection_to_active_and_caches_identity(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        conn = _seed_connection(client, app_name="gmail")
        local_id = conn["id"]

        with patch("composio_client.check_status", return_value="enabled"), patch(
            "routers.connections._fetch_composio_account_info"
        ) as mock_info:
            mock_info.return_value = {
                "email": "user@example.com",
                "scopes": ["gmail.readonly"],
                "status": "enabled",
            }
            resp = client.post(f"/connections/{local_id}/test", headers=AUTH_HEADERS)

        assert resp.status_code == 200
        assert resp.json()["status"] == "valid"
        list_resp = client.get("/connections", headers=AUTH_HEADERS)
        item = next(c for c in list_resp.json() if c["id"] == local_id)
        assert item["status"] == "active"
        assert item["account_label"] == "user@example.com"
        assert item["scopes"] == ["gmail.readonly"]

    def test_test_404_for_unknown_connection(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        resp = client.post(
            "/connections/no-such-id/test",
            headers=AUTH_HEADERS,
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# #12 - DB migration 18 adds columns idempotently
# ---------------------------------------------------------------------------

class TestMigration18:
    def test_migration_adds_columns_to_connections(self, monkeypatch, tmp_path):
        _load_api(monkeypatch, tmp_path)
        import db as db_module
        with db_module.get_db() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(composio_connections)")}
        assert "last_checked_at" in cols
        assert "last_check_status" in cols
        assert "last_check_error" in cols
        assert "scopes_json" in cols
        assert "account_label" in cols

    def test_migration_adds_columns_to_secrets(self, monkeypatch, tmp_path):
        _load_api(monkeypatch, tmp_path)
        import db as db_module
        with db_module.get_db() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(secrets)")}
        assert "last_checked_at" in cols
        assert "last_check_status" in cols
        assert "last_check_error" in cols

    def test_migration_idempotent(self, monkeypatch, tmp_path):
        """Running apply_migrations twice does not raise."""
        _load_api(monkeypatch, tmp_path)
        import db as db_module
        # No exception is expected.
        db_module.apply_migrations()
        db_module.apply_migrations()
