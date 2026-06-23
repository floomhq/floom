"""Cloud upload download-token signing secret derivation tests (#1892)."""
from __future__ import annotations

import hashlib
import hmac
import os

from apps.api._engine import ensure_engine_api_path, import_engine_module
from apps.api.startup import _ensure_upload_signing_secret

_VAR = "WORKEROS_UPLOAD_URL_SIGNING_SECRET"
_LABEL = b"workeros-upload-url-signing-secret-v1"


def _expected_derived(service_key: str) -> str:
    return hmac.new(service_key.encode("utf-8"), _LABEL, hashlib.sha256).hexdigest()


def _uploads_module():
    ensure_engine_api_path()
    return import_engine_module("services.uploads")


def test_upload_signing_key_derives_from_service_role_without_floom_secret(monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    monkeypatch.delenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv(_VAR, raising=False)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    _ensure_upload_signing_secret()

    expected = _expected_derived("test-service-role-key")
    assert os.environ[_VAR] == expected
    assert _uploads_module()._upload_signing_key() == expected.encode("utf-8")


def test_upload_signing_key_derives_from_prefixed_alias(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "alias-service-key")
    monkeypatch.delenv(_VAR, raising=False)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    _ensure_upload_signing_secret()

    expected = _expected_derived("alias-service-key")
    assert os.environ[_VAR] == expected
    assert _uploads_module()._upload_signing_key() == expected.encode("utf-8")


def test_explicit_upload_signing_secret_wins(monkeypatch):
    monkeypatch.setenv(_VAR, "operator-upload-secret")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")

    _ensure_upload_signing_secret()

    assert os.environ[_VAR] == "operator-upload-secret"
