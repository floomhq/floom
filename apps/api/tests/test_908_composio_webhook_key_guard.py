"""#908 — Composio event triggers must not silently fail when
COMPOSIO_WEBHOOK_SIGNING_KEY is missing.

The prod incident: the receiver 503s every delivery without the key, yet
triggers could still be enabled — shipped-but-broken with no signal. Pins:
  - enabling a composio trigger without the key raises with the operator fix
  - startup logs an ERROR naming the count of already-enabled triggers
  - startup logs a WARNING when composio is configured but the key is not

Run: cd apps/api && python -m pytest tests/test_908_composio_webhook_key_guard.py -q
"""
from __future__ import annotations

import importlib
import logging
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-908"


@pytest.fixture
def main_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.delenv("COMPOSIO_WEBHOOK_SIGNING_KEY", raising=False)
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    for name in list(sys.modules):
        if name in ("main", "db", "contexts") or name.startswith("db.") or name == "auth":
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    yield main
    db.get_repositories.cache_clear()


def _config_with_composio_trigger(main):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    return WorkerConfig(
        id="gmail-watcher",
        name="gmail-watcher",
        trigger=WorkerTrigger(
            type="composio",
            composio={"event": "GMAIL_NEW_GMAIL_MESSAGE", "connection_id": "conn_1"},
        ),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        outputs=[],
    )


def test_enable_trigger_without_key_raises_with_operator_fix(main_mod, monkeypatch):
    monkeypatch.delenv("COMPOSIO_WEBHOOK_SIGNING_KEY", raising=False)
    config = _config_with_composio_trigger(main_mod)
    with pytest.raises(RuntimeError) as exc_info:
        main_mod._enable_composio_trigger(config, "gmail-watcher")
    msg = str(exc_info.value)
    assert "COMPOSIO_WEBHOOK_SIGNING_KEY" in msg
    assert "503" in msg
    assert "Composio dashboard" in msg


def test_enable_trigger_with_key_proceeds_past_guard(main_mod, monkeypatch):
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "whsec_test")
    calls = {}

    import composio_client

    def _fake_enable(event, connection_id, webhook_url, config):
        calls["event"] = event
        return "trg_123"

    monkeypatch.setattr(composio_client, "enable_trigger", _fake_enable)
    monkeypatch.setattr(main_mod, "_resolve_composio_connection_id", lambda c: c)
    config = _config_with_composio_trigger(main_mod)
    assert main_mod._enable_composio_trigger(config, "gmail-watcher") == "trg_123"
    assert calls["event"] == "GMAIL_NEW_GMAIL_MESSAGE"


def test_startup_warns_error_when_enabled_triggers_exist(main_mod, monkeypatch, caplog):
    from contextlib import contextmanager

    class _Conn:
        def execute(self, *_a, **_k):
            class _Cur:
                def fetchone(self):
                    return {"cnt": 3}

            return _Cur()

    @contextmanager
    def _fake_get_db():
        yield _Conn()

    monkeypatch.setattr(main_mod, "get_db", _fake_get_db)
    with caplog.at_level(logging.ERROR):
        main_mod._warn_if_composio_webhook_unconfigured()
    assert any(
        "COMPOSIO_WEBHOOK_SIGNING_KEY" in r.message and "NEVER fire" in r.message
        for r in caplog.records
    )


def test_startup_warns_when_composio_configured_without_key(main_mod, monkeypatch, caplog):
    monkeypatch.setenv("COMPOSIO_API_KEY", "ck_test")
    with caplog.at_level(logging.WARNING):
        main_mod._warn_if_composio_webhook_unconfigured()
    assert any(
        "cannot be enabled" in r.message for r in caplog.records
    )


def test_startup_silent_when_key_present(main_mod, monkeypatch, caplog):
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "whsec_test")
    with caplog.at_level(logging.WARNING):
        main_mod._warn_if_composio_webhook_unconfigured()
    assert not any("COMPOSIO" in r.message for r in caplog.records)
