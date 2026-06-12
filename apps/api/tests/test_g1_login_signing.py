"""g1 security batch — signing-key fixes.

Covers:
  #917 — magic-link issuance refuses to run on the per-process fallback HMAC
         key (links would die on restart); consumption is unaffected.
  #930 — upload download-token signing key no longer falls back to the
         hardcoded public string "local-dev-upload-url-signing".

Run:
    cd apps/api && python -m pytest tests/test_g1_login_signing.py -v
"""
from __future__ import annotations

import hashlib
import hmac as hmac_mod
import importlib
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

GOOD_PASSWORD = "correct-horse-battery"


def _load_main(monkeypatch, tmp_path, *, env: dict | None = None):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    for name in ("FLOOM_SECRET", "WORKEROS_MAGIC_LINK_SECRET", "WORKEROS_UPLOAD_URL_SIGNING_SECRET"):
        monkeypatch.delenv(name, raising=False)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


def _login_session(client):
    resp = client.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# #917 — magic-link issuance requires a configured signing secret
# ---------------------------------------------------------------------------

def test_magic_link_issuance_refused_on_fallback_key(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with _client(main) as client:
        _login_session(client)
        resp = client.post("/auth/magic-link")
    assert resp.status_code == 503, resp.text
    assert "WORKEROS_MAGIC_LINK_SECRET" in resp.json()["detail"]


def test_magic_link_issuance_works_with_configured_secret(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_MAGIC_LINK_SECRET": "g1-magic-secret"}
    )
    with _client(main) as client:
        _login_session(client)
        resp = client.post("/auth/magic-link")
        assert resp.status_code == 200, resp.text
        url = resp.json()["url"]
        token = url.rsplit("/auth/magic/", 1)[1]

        # the issued link is consumable
        consumed = client.get(f"/auth/magic/{token}")
        assert consumed.status_code == 200, consumed.text


# ---------------------------------------------------------------------------
# #930 — upload signing key fallback is not a public constant
# ---------------------------------------------------------------------------

def test_upload_signing_key_is_not_hardcoded_constant(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._upload_signing_key() != b"local-dev-upload-url-signing"


def test_token_forged_with_old_hardcoded_key_is_rejected(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    payload = main._b64url_encode(
        json.dumps(
            {"file_id": "f" * 64, "uploaded_by": "attacker", "expires_at": int(time.time()) + 3600},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    forged_sig = hmac_mod.new(
        b"local-dev-upload-url-signing", payload.encode("ascii"), hashlib.sha256
    ).hexdigest()
    with pytest.raises(HTTPException) as exc_info:
        main._verify_upload_download_token("f" * 64, f"{payload}.{forged_sig}")
    assert exc_info.value.status_code == 404


def test_upload_token_round_trip_still_works(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    token = main._make_upload_download_token("a" * 64, "alice")
    assert main._verify_upload_download_token("a" * 64, token) == "alice"


def test_upload_signing_key_env_override_used(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_UPLOAD_URL_SIGNING_SECRET": "g1-upload-key"}
    )
    assert main._upload_signing_key() == b"g1-upload-key"
