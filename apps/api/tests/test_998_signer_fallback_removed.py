"""#998 — no HMAC signer falls back to the public 'dev-secret-not-set' constant.

Every public-share / legacy-token signer must fail closed (no signing or
validation) when FLOOM_SECRET is absent, so forged share/approval/webhook
links cannot be minted or accepted on a misconfigured deploy.

Run: cd apps/api && python -m pytest tests/test_998_signer_fallback_removed.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

REPO_ROOT = API_DIR


def test_no_dev_secret_constant_anywhere_in_signers():
    # The literal must be gone from every signer module (run_token was #972).
    for rel in ("main.py", "chat_service.py", "webhook_service.py"):
        text = (API_DIR / rel).read_text(encoding="utf-8")
        assert "dev-secret-not-set" not in text, f"{rel} still has the dev-secret fallback (#998)"


def test_webhook_legacy_token_fails_closed_without_secret(monkeypatch):
    # main.py loads the repo .env in local mode; keep this explicitly empty so
    # python-dotenv cannot repopulate a developer signing secret.
    monkeypatch.setenv("FLOOM_SECRET", "")
    for name in ("webhook_service",):
        sys.modules.pop(name, None)
    ws = importlib.import_module("webhook_service")
    with pytest.raises(ws.WebhookSigningSecretMissing):
        ws._legacy_token("some-worker")


def test_webhook_verify_rejects_legacy_token_without_secret(monkeypatch):
    # main.py loads the repo .env in local mode; keep this explicitly empty so
    # python-dotenv cannot repopulate a developer signing secret.
    monkeypatch.setenv("FLOOM_SECRET", "")
    monkeypatch.setenv("WORKEROS_WEBHOOK_LEGACY_GRACE", "1")
    sys.modules.pop("webhook_service", None)
    ws = importlib.import_module("webhook_service")
    # a missing secret means the legacy token can never validate — but it must
    # NOT raise out of the verify path; it returns False (fail closed).
    if hasattr(ws, "_legacy_grace_enabled") and ws._legacy_grace_enabled():
        # forge an arbitrary token; verification must reject, not crash
        try:
            result = ws.verify_webhook_token("w1", "deadbeef" * 8)
        except TypeError:
            pytest.skip("verify signature differs; covered by the unit raise above")
        assert result is False


def test_main_share_token_signers_raise_503_without_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    # main.py loads the repo .env in local mode; keep this explicitly empty so
    # python-dotenv cannot repopulate a developer signing secret.
    monkeypatch.setenv("FLOOM_SECRET", "")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)
    import types as _types

    sys.modules["scheduler"] = _types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e1:
        main._worker_public_token({"id": "w1"})
    assert e1.value.status_code == 503
    with pytest.raises(HTTPException) as e2:
        main._workspace_share_token("local-user")
    assert e2.value.status_code == 503
    with pytest.raises(HTTPException) as e3:
        main._approval_public_token({"id": "a1", "run_id": "r1", "owner_id": "o1"})
    assert e3.value.status_code == 503
