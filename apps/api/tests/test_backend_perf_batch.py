from __future__ import annotations

import hashlib
import importlib
import base64
import os
import types


def test_public_api_base_prefers_api_base_and_uses_prod_default(monkeypatch):
    monkeypatch.delenv("WORKEROS_PUBLIC_API_URL", raising=False)
    monkeypatch.delenv("WORKEROS_API_URL", raising=False)
    monkeypatch.delenv("WORKERS_API_URL", raising=False)
    monkeypatch.setenv("WORKEROS_API_BASE", "https://api.example.test/")

    from core.urls import _public_api_base_url
    import channels.slack as slack

    assert _public_api_base_url() == "https://api.example.test"
    assert slack._slack_oauth_callback_url() == "https://api.example.test/slack/oauth/callback"

    monkeypatch.delenv("WORKEROS_API_BASE", raising=False)
    assert _public_api_base_url() == "https://workeros-api.floom.dev"


def test_session_ids_are_hashed_and_legacy_plaintext_migrates(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    import db
    import db.sqlite as sqlite

    db = importlib.reload(db)
    sqlite = importlib.reload(sqlite)
    db.init_db()
    repos = db.get_repositories()
    repos.users.create(
        user_id="u1",
        username="alice",
        display_name=None,
        password_hash="hash",
        role="admin",
    )

    raw_session = "raw-session-token"
    repos.sessions.create(session_id=raw_session, user_id="u1", expires_at="2999-01-01T00:00:00+00:00")
    expected_hash = hashlib.sha256(raw_session.encode()).hexdigest()
    with sqlite.get_db() as conn:
        row = conn.execute("SELECT id FROM user_sessions").fetchone()
    assert row["id"] == expected_hash
    assert repos.sessions.get(session_id=raw_session)["user_id"] == "u1"

    legacy_session = "legacy-plaintext-token"
    with sqlite.get_db() as conn:
        conn.execute(
            "INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (legacy_session, "u1", "2999-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
        )
    assert repos.sessions.get(session_id=legacy_session)["user_id"] == "u1"
    legacy_hash = hashlib.sha256(legacy_session.encode()).hexdigest()
    with sqlite.get_db() as conn:
        migrated = conn.execute("SELECT id FROM user_sessions WHERE id = ?", (legacy_hash,)).fetchone()
    assert migrated is not None


def test_local_secret_values_are_encrypted_on_disk_and_decrypted_on_read(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "secrets.env"))
    monkeypatch.setenv("WORKEROS_SECRETS_KEY", base64.b64encode(os.urandom(32)).decode("ascii"))

    import db
    import db.sqlite as sqlite

    db = importlib.reload(db)
    sqlite = importlib.reload(sqlite)
    db.init_db()
    repos = db.get_repositories()

    item = repos.secrets.set(user_id="user-1", name="API_KEY", value="plain-secret-value")
    assert item["value"] == "plain-secret-value"
    assert repos.secrets.read_value(user_id="user-1", name="API_KEY") == "plain-secret-value"
    assert repos.secrets.resolve(user_id="user-1", names=["API_KEY"]) == {"API_KEY": "plain-secret-value"}
    assert repos.secrets.list(user_id="user-1")[0]["value"] == "plain-secret-value"

    env_text = (tmp_path / "secrets.env").read_text()
    assert "plain-secret-value" not in env_text
    assert "enc:v1:" in env_text


def test_e2b_network_policy_and_sandbox_create_kwargs(monkeypatch):
    from runner_sandbox import e2b_driver
    from models import (
        WorkerConfig,
        WorkerContractCapabilities,
        WorkerContractNetworkCapabilities,
        WorkerRuntime,
        WorkerTrigger,
    )

    config = WorkerConfig(
        id="net-worker",
        name="Net Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", entrypoint="run.py"),
        capabilities=WorkerContractCapabilities(
            network=WorkerContractNetworkCapabilities(
                egress=True,
                allow_out=["api.partner.test"],
            )
        ),
    )
    policy = e2b_driver._e2b_network_policy(config, api_url="https://workeros-api.example.test")
    assert policy["allow_public_traffic"] is True
    assert "workeros-api.example.test" in policy["allow_out"]
    assert "api.partner.test" in policy["allow_out"]
    assert "169.254.0.0/16" in policy["deny_out"]

    captured = {}

    class FakeSandbox:
        @classmethod
        def create(cls, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace()

    e2b_driver._create_sandbox_with_key_fallback(
        FakeSandbox,
        api_keys=["key"],
        timeout=180,
        envs={"WORKEROS_API_URL": "https://workeros-api.example.test"},
        network=policy,
        log_fn=lambda *_: None,
    )
    assert captured["network"] == policy
