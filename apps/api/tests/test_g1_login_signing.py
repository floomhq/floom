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
        monkeypatch.setenv(name, "")
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    for name in list(sys.modules):
        if (
            name in ("main", "db", "auth", "routers", "services")
            or name.startswith(("db.", "auth.", "routers.", "services."))
        ):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    for name in ("FLOOM_SECRET", "WORKEROS_MAGIC_LINK_SECRET", "WORKEROS_UPLOAD_URL_SIGNING_SECRET"):
        monkeypatch.setenv(name, "")
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
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
# F4 — magic links are one-time use (no replay for the full TTL)
# ---------------------------------------------------------------------------

def test_magic_link_is_single_use(monkeypatch, tmp_path):
    """A valid, unexpired magic link must be consumable exactly once. A second
    GET with the same token (replay) is rejected even though the HMAC + exp are
    still valid, because the token's nonce has been marked consumed."""
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_MAGIC_LINK_SECRET": "g1-magic-secret"}
    )
    with _client(main) as client:
        _login_session(client)
        resp = client.post("/auth/magic-link")
        assert resp.status_code == 200, resp.text
        token = resp.json()["url"].rsplit("/auth/magic/", 1)[1]

        first = client.get(f"/auth/magic/{token}")
        assert first.status_code == 200, first.text

        # Replay the exact same (still-unexpired, still-signature-valid) link.
        second = client.get(f"/auth/magic/{token}")
        assert second.status_code == 400, second.text
        assert "already used" in second.json()["detail"].lower()


# ---------------------------------------------------------------------------
# #1702 — a failed/consumed magic link, when opened directly in a BROWSER,
# redirects to /login?error=... instead of dumping raw {"detail": ...} JSON.
# fetch()/API callers keep the JSON contract.
# ---------------------------------------------------------------------------

def test_consumed_link_browser_navigation_redirects_to_login_1702(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_MAGIC_LINK_SECRET": "g1-magic-secret"}
    )
    with _client(main) as client:
        _login_session(client)
        token = client.post("/auth/magic-link").json()["url"].rsplit("/auth/magic/", 1)[1]

        # First consume succeeds.
        assert client.get(f"/auth/magic/{token}").status_code == 200

        # Replay as a top-level browser navigation -> redirect to login, no JSON.
        replayed = client.get(
            f"/auth/magic/{token}",
            headers={"sec-fetch-mode": "navigate"},
            follow_redirects=False,
        )
        assert replayed.status_code == 303, replayed.text
        location = replayed.headers["location"]
        assert "/login?error=expired_link" in location
        # No raw JSON body leaked.
        assert "Auth callback failed" not in replayed.text
        assert "already used" not in replayed.text


def test_invalid_token_browser_navigation_redirects_to_login_1702(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_MAGIC_LINK_SECRET": "g1-magic-secret"}
    )
    with _client(main) as client:
        _login_session(client)
        resp = client.get(
            "/auth/magic/not-a-real-token",
            headers={"sec-fetch-mode": "navigate"},
            follow_redirects=False,
        )
        assert resp.status_code == 303, resp.text
        assert "/login?error=expired_link" in resp.headers["location"]


def test_consumed_link_fetch_caller_keeps_json_contract_1702(monkeypatch, tmp_path):
    # A programmatic fetch (no navigate mode) must still get the JSON error so the
    # existing web MagicLinkPage fetch flow is unchanged.
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_MAGIC_LINK_SECRET": "g1-magic-secret"}
    )
    with _client(main) as client:
        _login_session(client)
        token = client.post("/auth/magic-link").json()["url"].rsplit("/auth/magic/", 1)[1]
        assert client.get(f"/auth/magic/{token}").status_code == 200

        replayed = client.get(
            f"/auth/magic/{token}",
            headers={"sec-fetch-mode": "cors", "accept": "application/json"},
            follow_redirects=False,
        )
        assert replayed.status_code == 400, replayed.text
        assert "already used" in replayed.json()["detail"].lower()


def test_legacy_magic_link_without_nonce_is_rejected(monkeypatch, tmp_path):
    """A token forged/issued without a nonce cannot be made one-time, so it is
    rejected rather than allowed unbounded reuse."""
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_MAGIC_LINK_SECRET": "g1-magic-secret"}
    )
    # Hand-craft a validly-signed token that omits the nonce.
    payload = {"user_id": "alice", "exp": int(time.time()) + 900}
    encoded = main._b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    sig = hmac_mod.new(
        main._magic_link_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
    ).hexdigest()
    token = f"{encoded}.{sig}"
    with pytest.raises(HTTPException) as exc:
        main._validate_magic_link_full(token)
    assert exc.value.status_code == 400


def test_magic_link_validation_refused_without_configured_secret(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with pytest.raises(HTTPException) as exc:
        main._validate_magic_link_full("bad.token")
    assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# #930 — upload signing key fallback is not a public constant
# ---------------------------------------------------------------------------

def test_upload_signing_key_requires_configured_secret(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    with pytest.raises(HTTPException) as exc:
        main._upload_signing_key()
    assert exc.value.status_code == 503


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
    assert exc_info.value.status_code == 503


def test_upload_token_round_trip_still_works(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_UPLOAD_URL_SIGNING_SECRET": "g1-upload-key"}
    )
    token = main._make_upload_download_token("a" * 64, "alice")
    assert main._verify_upload_download_token("a" * 64, token) == "alice"


def test_upload_signing_key_env_override_used(monkeypatch, tmp_path):
    main = _load_main(
        monkeypatch, tmp_path, env={"WORKEROS_UPLOAD_URL_SIGNING_SECRET": "g1-upload-key"}
    )
    assert main._upload_signing_key() == b"g1-upload-key"
