from __future__ import annotations

import importlib
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "http://localhost:3000")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "composio_client",
        "main",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    connections = importlib.import_module("routers.connections")
    return db, main, connections


def test_authorize_link_is_short_opaque_single_use_and_expires(monkeypatch, tmp_path):
    db, main, connections = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()

    token = connections._issue_authorize_token(
        redirect_url="https://connect.composio.dev/link/lk_2084",
        user_id="user-2084",
        repos=repos,
    )

    assert len(token) < 80
    assert "." not in token

    client = TestClient(main.app)
    first = client.get(f"/connections/authorize/{token}", follow_redirects=False)
    assert first.status_code in {302, 307}
    assert first.headers["location"] == "https://connect.composio.dev/link/lk_2084"

    replay = client.get(f"/connections/authorize/{token}", follow_redirects=False)
    assert replay.status_code == 400
    assert replay.json()["detail"] == "Authorization link expired"

    expired = connections._issue_authorize_token(
        redirect_url="https://connect.composio.dev/link/lk_expired",
        user_id="user-2084",
        repos=repos,
        ttl_seconds=-1,
    )
    expired_resp = client.get(f"/connections/authorize/{expired}", follow_redirects=False)
    assert expired_resp.status_code == 400
    assert expired_resp.json()["detail"] == "Authorization link expired"

    db.get_repositories.cache_clear()


def test_callback_redirect_selects_connected_detail(monkeypatch, tmp_path):
    db, main, connections = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    repos.connections.upsert(
        user_id="user-2084",
        id="conn-2084",
        app_name="gmail",
        composio_connection_id="ca_2084",
        status="initiated",
        created_at="2026-07-03T00:00:00+00:00",
        updated_at="2026-07-03T00:00:00+00:00",
    )

    monkeypatch.setattr(connections, "_verify_oauth_callback_state", lambda **_kwargs: None)
    monkeypatch.setattr("composio_client.check_status", lambda _connection_id: "active")
    monkeypatch.setattr(
        connections,
        "_fetch_composio_account_info",
        lambda _connection_id, *, user_id: {
            "email": "team@floom.dev",
            "scopes": ["gmail.readonly", "gmail.send"],
        },
    )

    client = TestClient(main.app)
    resp = client.get(
        "/connections/callback?connection_id=ca_2084&state=test-state",
        follow_redirects=False,
    )

    assert resp.status_code in {302, 307}
    location = resp.headers["location"]
    parsed = urlparse(location)
    query = parse_qs(parsed.query)
    assert parsed.path == "/connections"
    assert query["connected"] == ["1"]
    assert query["connection_id"] == ["conn-2084"]
    assert query["sel"] == ["conn-2084"]
    assert query["app"] == ["gmail"]

    row = repos.connections.get(user_id="user-2084", composio_id="conn-2084")
    assert row is not None
    assert row["account_label"] == "team@floom.dev"
    assert "gmail.readonly" in row["scopes_json"]

    db.get_repositories.cache_clear()
