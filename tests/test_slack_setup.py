import importlib
import sys
import types
import urllib.parse
from pathlib import Path

from fastapi.testclient import TestClient


AUTH_HEADERS = {"x-floom-secret": "test-api-secret"}


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    env_file = tmp_path / "api.env"

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(env_file))
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADERS["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_USER_ID", "slack-setup-user")
    monkeypatch.setenv("WORKEROS_PUBLIC_API_URL", "https://workers-api.example.test")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.example.test")
    for name in [
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_BOT_TOKEN",
        "SLACK_ALLOWED_TEAM_IDS",
        "SLACK_BOT_TOKEN_T123",
    ]:
        monkeypatch.delenv(name, raising=False)

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    for name in [
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_BOT_TOKEN",
        "SLACK_ALLOWED_TEAM_IDS",
        "SLACK_BOT_TOKEN_T123",
    ]:
        monkeypatch.delenv(name, raising=False)
    return main, env_file


def test_slack_setup_config_writes_allowlisted_env_and_redacts_values(monkeypatch, tmp_path):
    main, env_file = _load_api(monkeypatch, tmp_path)

    with TestClient(main.app, headers=AUTH_HEADERS) as client:
        response = client.post(
            "/slack/setup/config",
            json={
                "client_id": "123.abc",
                "client_secret": "client-secret",
                "signing_secret": "signing-secret",
                "events_enabled": True,
            },
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["updated"] == [
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_EVENTS_ENABLED",
        "SLACK_SIGNING_SECRET",
    ]
    assert payload["setup"]["configured"] is True
    assert payload["setup"]["client_secret_set"] is True
    assert payload["setup"]["signing_secret_set"] is True
    assert "client-secret" not in response.text
    assert "signing-secret" not in response.text
    assert "https://slack.com/oauth/v2/authorize" in payload["setup"]["install_url"]
    env_text = env_file.read_text()
    assert "SLACK_CLIENT_ID=123.abc" in env_text
    assert "SLACK_CLIENT_SECRET=client-secret" in env_text
    assert "SLACK_SIGNING_SECRET=signing-secret" in env_text


def test_slack_oauth_callback_persists_team_install_without_leaking_token(monkeypatch, tmp_path):
    main, env_file = _load_api(monkeypatch, tmp_path)
    monkeypatch.setenv("SLACK_CLIENT_ID", "123.abc")
    monkeypatch.setenv("SLACK_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "signing-secret")

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload
            self.ok = True
            self.status_code = 200

        def json(self):
            return self._payload

    def fake_post(url, data=None, **kwargs):
        assert url == "https://slack.com/api/oauth.v2.access"
        assert data["client_id"] == "123.abc"
        assert data["client_secret"] == "client-secret"
        assert data["code"] == "oauth-code"
        assert data["redirect_uri"] == "https://workers-api.example.test/slack/oauth/callback"
        return FakeResponse({
            "ok": True,
            "access_token": "xoxb-installed-token",
            "app_id": "A123",
            "bot_user_id": "U999",
            "scope": "app_mentions:read,chat:write,commands",
            "team": {"id": "T123", "name": "test-games"},
            "enterprise": None,
            "authed_user": {"id": "U111"},
        })

    def fake_get(url, headers=None, **kwargs):
        assert url == "https://slack.com/api/auth.test"
        assert headers["Authorization"] == "Bearer xoxb-installed-token"
        return FakeResponse({
            "ok": True,
            "team_id": "T123",
            "team": "test-games",
            "user_id": "U999",
        })

    monkeypatch.setattr(main.requests, "post", fake_post)
    monkeypatch.setattr(main.requests, "get", fake_get)

    with TestClient(main.app, headers=AUTH_HEADERS, follow_redirects=False) as client:
        install_response = client.post("/slack/oauth/install", json={"return_to": "/connections/slack"})
        state = urllib.parse.parse_qs(
            urllib.parse.urlparse(install_response.json()["install_url"]).query
        )["state"][0]
        callback = client.get("/slack/oauth/callback", params={"code": "oauth-code", "state": state})
        status = client.get("/slack/setup/status")

    assert install_response.status_code == 200, install_response.text
    assert callback.status_code in {302, 307}
    assert callback.headers["location"] == "https://workers.example.test/connections/slack?slack_connected=1&team_id=T123"
    assert "xoxb-installed-token" not in callback.text
    assert main.os.environ["SLACK_BOT_TOKEN_T123"] == "xoxb-installed-token"
    assert main.os.environ["SLACK_BOT_TOKEN"] == "xoxb-installed-token"
    assert main.os.environ["SLACK_ALLOWED_TEAM_IDS"] == "T123"
    env_text = env_file.read_text()
    assert "SLACK_BOT_TOKEN_T123=xoxb-installed-token" in env_text
    assert status.json()["installed_teams"][0]["team_id"] == "T123"
    assert status.json()["installed_teams"][0]["bot_token_set"] is True
    assert "bot_token_env_key" not in status.text
    assert "xoxb-installed-token" not in status.text
