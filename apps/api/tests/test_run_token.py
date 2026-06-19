"""Tests for run-scoped capability tokens.

Covers:
  - make_run_token / verify_run_token round-trip
  - Expired token rejection
  - Tampered token rejection
  - Middleware: run token accepted only on its own /runs/{id}/composio-execute/* path
  - Middleware: run token blocked everywhere else
  - Middleware: run_id in path must match token's run_id
"""

from __future__ import annotations

import platform
import sys
import time
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_NEEDS_FASTAPI = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="fastapi/httpx not installed in local Windows env; runs in CI on ubuntu-latest",
)

# ---------------------------------------------------------------------------
# Unit tests: token helpers (cross-platform, no fcntl)
# ---------------------------------------------------------------------------

class TestMakeVerifyRunToken:
    SECRET = "test-secret-abc"

    def test_round_trip(self):
        from run_token import make_run_token, verify_run_token
        token = make_run_token("run-123", secret=self.SECRET)
        assert verify_run_token(token, secret=self.SECRET) == "run-123"

    def test_wrong_secret_rejected(self):
        from run_token import make_run_token, verify_run_token
        token = make_run_token("run-123", secret=self.SECRET)
        assert verify_run_token(token, secret="wrong-secret") is None

    def test_expired_token_rejected(self):
        from run_token import verify_run_token
        import hashlib, hmac
        expired = int(time.time()) - 1
        hex_exp = format(expired, "010x")
        data = f"run:run-123:{hex_exp}"
        sig = hmac.new(self.SECRET.encode(), data.encode(), hashlib.sha256).hexdigest()
        token = f"{data}.{sig}"
        assert verify_run_token(token, secret=self.SECRET) is None

    def test_tampered_payload_rejected(self):
        from run_token import make_run_token, verify_run_token
        token = make_run_token("run-123", secret=self.SECRET)
        # Flip one character in the data portion
        data, sig = token.rsplit(".", 1)
        tampered = data[:-1] + ("x" if data[-1] != "x" else "y")
        bad_token = f"{tampered}.{sig}"
        assert verify_run_token(bad_token, secret=self.SECRET) is None

    def test_empty_token_returns_none(self):
        from run_token import verify_run_token
        assert verify_run_token("", secret=self.SECRET) is None

    def test_garbage_token_returns_none(self):
        from run_token import verify_run_token
        assert verify_run_token("not-a-token", secret=self.SECRET) is None

    def test_different_run_ids_produce_different_tokens(self):
        from run_token import make_run_token
        t1 = make_run_token("run-aaa", secret=self.SECRET)
        t2 = make_run_token("run-bbb", secret=self.SECRET)
        assert t1 != t2

    def test_empty_secret_rejects_token(self):
        """Run tokens are never accepted without an HMAC key."""
        from run_token import make_run_token, verify_run_token
        token = make_run_token("run-dev", secret="")
        result = verify_run_token(token, secret="")
        assert result is None

    def test_empty_secret_rejects_forged_token(self):
        from run_token import verify_run_token

        assert verify_run_token("run:victim-run-id:ffffffffff.fakesig", secret="") is None

    def test_token_embeds_correct_run_id(self):
        from run_token import make_run_token, verify_run_token
        for run_id in ["run-abc", "run_xyz_123", "abc-def-ghi"]:
            token = make_run_token(run_id, secret=self.SECRET)
            assert verify_run_token(token, secret=self.SECRET) == run_id

    def test_token_has_expected_format(self):
        from run_token import make_run_token
        token = make_run_token("run-123", secret=self.SECRET)
        # Format: run:<run_id>:<hex_expires>.<hex_sig>
        assert token.startswith("run:run-123:")
        parts = token.rsplit(".", 1)
        assert len(parts) == 2
        data, sig = parts
        assert len(sig) == 64  # SHA-256 hex digest


# ---------------------------------------------------------------------------
# Middleware tests (using TestClient — needs no fcntl, patches DB access)
# ---------------------------------------------------------------------------

@_NEEDS_FASTAPI
class TestRunTokenMiddleware:
    """Test that the auth middleware enforces run token scoping.

    Uses a minimal FastAPI app that mirrors the real middleware logic without
    booting the entire engine (avoids fcntl / SQLite / all the imports).
    """

    def _make_app(self, secret: str):
        """Build a minimal FastAPI app with the real run-token middleware logic."""
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        app = FastAPI()

        @app.middleware("http")
        async def _run_token_middleware(request: Request, call_next):
            from run_token import verify_run_token
            if request.method == "OPTIONS":
                return await call_next(request)
            run_token_header = request.headers.get("x-workeros-run-token", "")
            if run_token_header:
                run_id = verify_run_token(run_token_header, secret=secret)
                if run_id is None:
                    return JSONResponse(status_code=401, content={"detail": "Invalid or expired run token"})
                path = request.url.path
                if not path.startswith(f"/runs/{run_id}/composio-execute/"):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Run tokens are only valid for Composio proxy calls"},
                    )
                return await call_next(request)
            # No run token — require operator secret
            if secret:
                header = request.headers.get("x-floom-secret", "")
                if header != secret:
                    return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
            return await call_next(request)

        @app.get("/healthz")
        def healthz(): return {"ok": True}

        @app.get("/workers")
        def list_workers(): return []

        @app.patch("/workers/{worker_id}")
        def patch_worker(worker_id: str): return {"patched": worker_id}

        @app.post("/workers")
        def create_worker(): return {"created": True}

        @app.delete("/workers/{worker_id}")
        def delete_worker(worker_id: str): return {"deleted": worker_id}

        @app.post("/runs/{run_id}/composio-execute/{tool}")
        def composio_execute(run_id: str, tool: str): return {"ok": True, "run_id": run_id}

        return app

    def test_run_token_allowed_on_composio_path(self):
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)
        token = make_run_token("run-abc", secret=secret)
        r = client.post(
            "/runs/run-abc/composio-execute/GMAIL_FETCH_EMAILS",
            headers={"X-Workeros-Run-Token": token},
        )
        assert r.status_code == 200

    def test_run_token_blocked_on_get_workers(self):
        """Sandbox run tokens are not operator API credentials."""
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)
        token = make_run_token("run-abc", secret=secret)
        r = client.get("/workers", headers={"X-Workeros-Run-Token": token})
        assert r.status_code == 403

    def test_run_token_blocked_on_patch_worker(self):
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)
        token = make_run_token("run-abc", secret=secret)
        r = client.patch("/workers/some-worker", headers={"X-Workeros-Run-Token": token})
        assert r.status_code == 403

    def test_run_token_blocked_on_create_worker(self):
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)
        token = make_run_token("run-abc", secret=secret)
        r = client.post("/workers", headers={"X-Workeros-Run-Token": token})
        assert r.status_code == 403

    def test_run_token_blocked_on_delete_worker(self):
        """DELETE is not available through a sandbox run token."""
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)
        token = make_run_token("run-abc", secret=secret)
        r = client.delete("/workers/some-worker", headers={"X-Workeros-Run-Token": token})
        assert r.status_code == 403
        assert "composio proxy" in r.json()["detail"].lower()

    def test_invalid_run_token_rejected(self):
        from fastapi.testclient import TestClient

        client = TestClient(self._make_app("my-secret"), raise_server_exceptions=False)
        r = client.post(
            "/runs/run-abc/composio-execute/SOME_TOOL",
            headers={"X-Workeros-Run-Token": "not-a-valid-token"},
        )
        assert r.status_code == 401

    def test_operator_with_correct_secret_can_delete(self):
        """Operators using x-floom-secret can still call destructive endpoints."""
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)
        r = client.delete("/workers/some-worker", headers={"x-floom-secret": secret})
        assert r.status_code == 200

    def test_operator_with_wrong_secret_rejected(self):
        from fastapi.testclient import TestClient

        client = TestClient(self._make_app("my-secret"), raise_server_exceptions=False)
        r = client.delete("/workers/some-worker", headers={"x-floom-secret": "wrong"})
        assert r.status_code == 401

    def test_expired_token_rejected_with_401(self):
        import hashlib, hmac as _hmac
        from fastapi.testclient import TestClient

        secret = "my-secret"
        client = TestClient(self._make_app(secret), raise_server_exceptions=False)

        expired = int(time.time()) - 1
        hex_exp = format(expired, "010x")
        data = f"run:run-abc:{hex_exp}"
        sig = _hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()
        token = f"{data}.{sig}"

        r = client.get("/workers", headers={"X-Workeros-Run-Token": token})
        assert r.status_code == 401


class TestWorkerCallSecretRequired:
    """#972: worker-call tokens must never sign/validate with a hardcoded
    fallback key. No real FLOOM_SECRET → fail closed."""

    def test_issue_refuses_without_secret(self, monkeypatch):
        from run_token import issue_worker_call_token, WorkerCallSecretMissing

        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        with pytest.raises(WorkerCallSecretMissing):
            issue_worker_call_token(
                user_id="u1", parent_run_id="r1", callable_workers=["w1"]
            )
        # explicit empty secret also refused
        with pytest.raises(WorkerCallSecretMissing):
            issue_worker_call_token(
                user_id="u1", parent_run_id="r1", callable_workers=["w1"], secret=""
            )

    def test_validate_refuses_without_secret(self, monkeypatch):
        from run_token import (
            issue_worker_call_token,
            validate_worker_call_token,
            WorkerCallSecretMissing,
        )

        # a token validly signed under a real secret...
        token = issue_worker_call_token(
            user_id="u1", parent_run_id="r1", callable_workers=["w1"], secret="real-secret"
        )
        # ...must NOT validate when the server has no secret (no guessable key).
        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        with pytest.raises(WorkerCallSecretMissing):
            validate_worker_call_token(token)
        with pytest.raises(WorkerCallSecretMissing):
            validate_worker_call_token(token, secret="")

    def test_missing_secret_error_is_valueerror(self):
        # the validate middleware catches ValueError → 401; WorkerCallSecretMissing
        # must subclass it so a misconfigured server rejects the token, not 500.
        from run_token import WorkerCallSecretMissing

        assert issubclass(WorkerCallSecretMissing, ValueError)

    def test_forged_dev_secret_token_is_rejected(self, monkeypatch):
        # the old public fallback must no longer validate anything.
        import hashlib
        import hmac
        import json
        import base64

        from run_token import validate_worker_call_token, WORKER_CALL_TOKEN_PREFIX

        payload = {
            "user_id": "attacker",
            "parent_run_id": "r1",
            "callable_workers": ["victim-worker"],
            "depth": 0,
            "nonce": "x",
            "exp": 9999999999,
        }
        encoded = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        ).rstrip(b"=").decode()
        forged_sig = hmac.new(
            b"dev-secret-not-set", encoded.encode(), hashlib.sha256
        ).hexdigest()
        forged = f"{WORKER_CALL_TOKEN_PREFIX}{encoded}.{forged_sig}"

        # even with a real secret configured, the forged dev-secret signature fails
        monkeypatch.setenv("FLOOM_SECRET", "real-secret")
        with pytest.raises(ValueError):
            validate_worker_call_token(forged)


class TestWorkerCallSecretDecoupled:
    """#992: signing secret decoupled from FLOOM_SECRET (env var + resolver hook)
    so multi-tenant cloud can sign without re-enabling the x-floom-secret gate,
    while OSS still fails closed (#972)."""

    def teardown_method(self):
        from run_token import set_worker_call_secret_resolver
        set_worker_call_secret_resolver(None)

    def test_dedicated_env_var_used_before_floom_secret(self, monkeypatch):
        from run_token import _worker_call_signing_key

        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        monkeypatch.setenv("WORKEROS_WORKER_CALL_SECRET", "wcs-real")
        assert _worker_call_signing_key() == "wcs-real"

    def test_resolver_wins_over_env(self, monkeypatch):
        from run_token import _worker_call_signing_key, set_worker_call_secret_resolver

        monkeypatch.setenv("WORKEROS_WORKER_CALL_SECRET", "env-secret")
        set_worker_call_secret_resolver(lambda: "resolver-secret")
        assert _worker_call_signing_key() == "resolver-secret"

    def test_cloud_path_signs_and_validates_without_floom_secret(self, monkeypatch):
        from run_token import (
            issue_worker_call_token,
            validate_worker_call_token,
            set_worker_call_secret_resolver,
        )

        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        monkeypatch.delenv("WORKEROS_WORKER_CALL_SECRET", raising=False)
        # cloud registers a Supabase-derived secret at startup
        set_worker_call_secret_resolver(lambda: "supabase-derived-secret")
        token = issue_worker_call_token(user_id="u1", parent_run_id="r1", callable_workers=["w1"])
        payload = validate_worker_call_token(token)
        assert payload["user_id"] == "u1"

    def test_oss_still_fails_closed_with_no_secret_and_no_resolver(self, monkeypatch):
        from run_token import issue_worker_call_token, WorkerCallSecretMissing

        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        monkeypatch.delenv("WORKEROS_WORKER_CALL_SECRET", raising=False)
        with pytest.raises(WorkerCallSecretMissing):
            issue_worker_call_token(user_id="u1", parent_run_id="r1", callable_workers=["w1"])

    def test_resolver_returning_none_falls_through_to_env(self, monkeypatch):
        from run_token import _worker_call_signing_key, set_worker_call_secret_resolver

        monkeypatch.delenv("FLOOM_SECRET", raising=False)
        monkeypatch.setenv("WORKEROS_WORKER_CALL_SECRET", "env-fallback")
        set_worker_call_secret_resolver(lambda: None)
        assert _worker_call_signing_key() == "env-fallback"
