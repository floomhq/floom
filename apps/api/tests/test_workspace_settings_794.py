"""#794/#797 — workspace settings KV: round-trip + member write-guard (#804 model)."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "ws-settings-794"


@pytest.fixture
def app_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler",
                 "auth", "auth.context", "auth.dependency", "main"]:
        sys.modules.pop(name, None)
        for _rn in [n for n in list(sys.modules) if n.startswith(("routers", "services", "core"))]:
            sys.modules.pop(_rn, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    yield main
    main.app.dependency_overrides.clear()
    db.get_repositories.cache_clear()


@pytest.fixture
def client(app_main):
    from fastapi.testclient import TestClient
    with TestClient(app_main.app, headers={"x-floom-secret": _SECRET}) as c:
        yield c


def _as_role(main, **ctx):
    from auth import AuthContext, get_auth_context
    main.app.dependency_overrides[get_auth_context] = lambda: AuthContext(**ctx)


def _settings_without_readonly(payload: dict) -> dict:
    # #797 added a read-only `current_month_spend_usd` mirror to the settings
    # map; this #794 round-trip only asserts the stored key/value pairs.
    return {k: v for k, v in payload.items() if k != "current_month_spend_usd"}


def test_admin_round_trip(app_main, client):
    _as_role(app_main, user_id="alice", role="admin")
    assert _settings_without_readonly(client.get("/workspace/settings").json()) == {}

    assert client.put("/workspace/settings/approval_default", json={"value": "required"}).status_code == 204
    assert client.put("/workspace/settings/auto_pause", json={"value": "true"}).status_code == 204
    assert _settings_without_readonly(client.get("/workspace/settings").json()) == {
        "approval_default": "required",
        "auto_pause": "true",
    }
    # Upsert overwrites.
    assert client.put("/workspace/settings/auto_pause", json={"value": "false"}).status_code == 204
    assert client.get("/workspace/settings").json()["auto_pause"] == "false"


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("auto_pause_enabled", "1"),
        ("failure_email_enabled", "false"),
        ("failure_email_to", "ops@example.com,alerts@example.com"),
        ("monthly_spend_cap_usd", "25.50"),
        ("default_model", "anthropic.claude-3-5-sonnet"),
        ("fallback_model", "gpt-5.1-mini"),
        ("default_timeout_seconds", "300"),
        ("max_output_tokens", "8192"),
        ("region", "us-west-2"),
        ("timezone", "America/Phoenix"),
        ("company_domain", "example.com"),
    ],
)
def test_admin_validated_setting_values_persist(app_main, client, key, value):
    _as_role(app_main, user_id="alice", role="admin")
    resp = client.put(f"/workspace/settings/{key}", json={"value": value})
    assert resp.status_code == 204, resp.text
    assert client.get("/workspace/settings").json()[key] == value


def test_unknown_workspace_setting_key_rejected(app_main, client):
    _as_role(app_main, user_id="alice", role="admin")
    resp = client.put("/workspace/settings/pwn_key", json={"value": "x"})
    assert resp.status_code == 422
    assert "unknown workspace setting" in resp.json()["detail"]


def test_current_month_spend_setting_is_read_only(app_main, client):
    _as_role(app_main, user_id="alice", role="admin")
    resp = client.put("/workspace/settings/current_month_spend_usd", json={"value": "0"})
    assert resp.status_code == 422
    assert "read-only" in resp.json()["detail"]


@pytest.mark.parametrize("key", ["default_model", "fallback_model"])
@pytest.mark.parametrize("value", ["../etc/passwd", "file:///tmp/model", "openai/gpt-4"])
def test_model_settings_reject_path_or_scheme_values(app_main, client, key, value):
    _as_role(app_main, user_id="alice", role="admin")
    resp = client.put(f"/workspace/settings/{key}", json={"value": value})
    assert resp.status_code == 422
    assert "safe model id" in resp.json()["detail"]


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("auto_pause_enabled", "sometimes"),
        ("failure_email_to", "not-an-email"),
        ("monthly_spend_cap_usd", "-1"),
        ("default_timeout_seconds", "0"),
        ("max_output_tokens", "1000001"),
        ("timezone", "Mars/Olympus"),
        ("company_domain", "not a domain"),
    ],
)
def test_invalid_workspace_setting_values_rejected(app_main, client, key, value):
    _as_role(app_main, user_id="alice", role="admin")
    resp = client.put(f"/workspace/settings/{key}", json={"value": value})
    assert resp.status_code == 422


def test_member_cannot_write(app_main, client):
    _as_role(app_main, user_id="bob", role="member", auth_method="session")
    resp = client.put("/workspace/settings/approval_default", json={"value": "off"})
    assert resp.status_code == 403, resp.text
