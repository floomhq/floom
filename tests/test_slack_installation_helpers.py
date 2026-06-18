from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from apps.api.db import slack_installations as slack_db
from auth import AuthContext


class _UpdateTable:
    def __init__(self):
        self.updates: list[dict] = []

    def update(self, payload: dict):
        self.updates.append(payload)
        return self

    def eq(self, *_args):
        return self

    def execute(self):
        return SimpleNamespace(data=[])


class _UpdateClient:
    def __init__(self):
        self.table_obj = _UpdateTable()

    def table(self, _name: str):
        return self.table_obj


def test_slack_claim_token_hash_is_deterministic_and_non_reversible():
    raw = "sic_test-token"
    digest = slack_db.token_hash(raw)
    assert digest == slack_db.token_hash(raw)
    assert raw not in digest
    assert len(digest) == 64


def test_slack_workspace_name_is_sanitized_and_bounded():
    assert slack_db.sanitize_workspace_name("  Acme   GTM 🚀  ") == "Acme GTM"
    long_name = "A" * 120
    assert slack_db.sanitize_workspace_name(long_name) == "A" * 80
    assert slack_db.sanitize_workspace_name("🚀") == "Slack workspace"


def test_slack_installs_enabled_defaults_true_and_honors_kill_switch(monkeypatch):
    monkeypatch.delenv("SLACK_INSTALLS_ENABLED", raising=False)
    assert slack_db.install_enabled() is True
    monkeypatch.setenv("SLACK_INSTALLS_ENABLED", "false")
    assert slack_db.install_enabled() is False
    monkeypatch.setenv("SLACK_INSTALLS_ENABLED", "1")
    assert slack_db.install_enabled() is True


def test_slack_blocked_team_ids_parse_commas_and_whitespace(monkeypatch):
    monkeypatch.setenv("SLACK_BLOCKED_TEAM_IDS", "T1,T2 T3\nT4")
    assert slack_db.blocked_team_ids() == {"T1", "T2", "T3", "T4"}


def test_team_bot_token_lookup_does_not_fall_back_to_env(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-global")
    monkeypatch.setattr(slack_db, "get_installation", lambda _team_id: None)

    assert slack_db.bot_token_for_team("T_MISSING") == ""
    assert slack_db.bot_token_for_team(None) == "xoxb-global"


def test_team_bot_token_missing_vault_id_is_fail_closed(monkeypatch):
    invalid: list[dict[str, str]] = []
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-global")
    monkeypatch.setattr(slack_db, "get_installation", lambda _team_id: {"team_id": "T1"})
    monkeypatch.setattr(slack_db, "mark_token_invalid", lambda **kwargs: invalid.append(kwargs))

    assert slack_db.bot_token_for_team("T1") == ""
    assert invalid == [{"team_id": "T1", "error": "vault_secret_missing"}]


def test_claim_workspace_requires_claimant_slack_user_id(monkeypatch):
    monkeypatch.setattr(slack_db.workspace_repo, "ensure_user_row", lambda **_kwargs: None)
    monkeypatch.setattr(
        slack_db,
        "validate_claim_token",
        lambda _token: (
            {"team_id": "T1", "installation_id": "00000000-0000-0000-0000-000000000001"},
            {
                "team_id": "T1",
                "installation_id": "00000000-0000-0000-0000-000000000001",
                "workspace_id": "ws_1",
                "installer_slack_user_id": "U_INSTALLER",
            },
        ),
    )

    with pytest.raises(Exception) as exc:
        slack_db.claim_workspace(
            token="sic_token",
            claimant_user_id="00000000-0000-0000-0000-000000000002",
            claimant_email="user@example.com",
            verification_code="",
            claimant_slack_user_id="",
        )

    assert getattr(exc.value, "status_code", None) == 400


def test_start_claim_verification_binds_code_to_claimant_slack_identity(monkeypatch):
    client = _UpdateClient()
    sent: list[dict[str, str]] = []
    install = {"team_id": "T1", "installer_slack_user_id": "U_INSTALLER"}
    monkeypatch.setattr(slack_db, "get_supabase_service_client", lambda: client)
    monkeypatch.setattr(slack_db, "can_claim_install", lambda **_kwargs: True)
    monkeypatch.setattr(slack_db, "_send_claim_verification_dm", lambda **kwargs: sent.append(kwargs))

    slack_db.start_claim_verification(token="sic_token", install=install, claimant_slack_user_id="U_ADMIN")

    assert client.table_obj.updates[0]["verification_slack_user_id"] == "U_ADMIN"
    assert sent[0]["slack_user_id"] == "U_ADMIN"


def test_verify_claim_code_rejects_different_slack_identity():
    claim = {
        "verification_slack_user_id": "U_INSTALLER",
        "verification_attempts": 0,
        "verification_expires_at": "2999-01-01T00:00:00+00:00",
        "verification_code_hash": slack_db.token_hash("123456"),
    }

    with pytest.raises(Exception) as exc:
        slack_db.verify_claim_code(
            token="sic_token",
            claim=claim,
            code="123456",
            claimant_slack_user_id="U_ATTACKER",
        )

    assert getattr(exc.value, "status_code", None) == 403


def test_slack_install_ip_uses_cloudflare_header_not_x_forwarded_for():
    from apps.api.routes import slack_oauth

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/slack/install/start",
            "headers": [
                (b"cf-connecting-ip", b"203.0.113.10"),
                (b"x-forwarded-for", b"198.51.100.20"),
            ],
            "client": ("10.0.0.1", 12345),
        }
    )

    assert slack_oauth._client_ip(request) == "203.0.113.10"

    missing_cf = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/slack/install/start",
            "headers": [(b"x-forwarded-for", b"198.51.100.20")],
            "client": ("10.0.0.1", 12345),
        }
    )
    assert slack_oauth._client_ip(missing_cf) is None


def test_slack_install_start_binds_state_to_authenticated_user(monkeypatch):
    from apps.api.routes import slack_oauth

    state_calls: list[dict] = []
    audit_calls: list[dict] = []
    monkeypatch.setattr(slack_db, "install_enabled", lambda: True)
    monkeypatch.setattr(slack_db, "enforce_global_rate_limit", lambda: None)
    monkeypatch.setattr(slack_db, "enforce_ip_rate_limit", lambda **_kwargs: None)
    monkeypatch.setattr(slack_db, "audit", lambda **kwargs: audit_calls.append(kwargs))
    monkeypatch.setattr(
        slack_oauth.engine_main,
        "_issue_slack_oauth_state",
        lambda **kwargs: state_calls.append(kwargs) or ("state-123", "2999-01-01T00:00:00Z"),
    )
    monkeypatch.setattr(
        slack_oauth.engine_main,
        "_slack_install_url",
        lambda *, state: f"https://slack.example/install?state={state}",
    )
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/slack/install/start",
            "headers": [
                (b"cf-connecting-ip", b"203.0.113.10"),
                (b"user-agent", b"pytest"),
            ],
            "client": ("10.0.0.1", 12345),
        }
    )

    response = asyncio.run(
        slack_oauth.slack_install_start(
            request,
            AuthContext(user_id="user-1", email="u@example.com", scopes=()),
        )
    )

    assert response.status_code == 302
    assert response.headers["location"] == "https://slack.example/install?state=state-123"
    assert state_calls == [{"user_id": "user-1", "return_to": "/slack/installed"}]
    assert audit_calls[0]["actor_user_id"] == "user-1"


def test_slack_return_to_is_limited_to_install_destinations():
    from apps.api.routes import slack_oauth

    assert slack_oauth._safe_return_path("/settings?sel=channels#slack") == "/settings?sel=channels#slack"
    assert slack_oauth._safe_return_path("/assistant?from_install=slack") == "/assistant?from_install=slack"
    assert slack_oauth._safe_return_path("/admin/billing") == "/slack/installed"
    assert slack_oauth._safe_return_path("https://evil.example/phish") == "/slack/installed"
    assert slack_oauth._safe_return_path("//evil.example/phish") == "/slack/installed"


def test_slack_oauth_success_params_preserve_existing_query():
    from apps.api.routes import slack_oauth

    assert (
        slack_oauth._append_success_params(
            "/assistant?from_install=slack#done",
            team_id="T123",
            claim="claim-abc",
        )
        == "/assistant?from_install=slack&slack_connected=1&team_id=T123&claim=claim-abc#done"
    )
