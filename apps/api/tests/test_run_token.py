"""Tests for run-scoped capability tokens.

Covers:
  - make_run_token / verify_run_token round-trip
  - Expired token rejection
  - Tampered token rejection
  - Middleware: run token accepted only on /runs/{id}/composio-execute/*
  - Middleware: run token blocked on DELETE /workers/{id} (and other destructive paths)
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

    def test_dev_mode_no_secret(self):
        """In dev mode (no secret), token is accepted based on payload only."""
        from run_token import make_run_token, verify_run_token
        token = make_run_token("run-dev", secret="")
        result = verify_run_token(token, secret="")
        assert result == "run-dev"

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
        import re as _re
        import os
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        app = FastAPI()

        _RE_COMPOSIO = _re.compile(r"^/runs/[a-zA-Z0-9_-]+/composio-execute/[A-Z0-9_]+$")

        @app.middleware("http")
        async def _run_token_middleware(request: Request, call_next):
            from run_token import verify_run_token
            path = request.url.path
            if request.method == "OPTIONS":
                return await call_next(request)
            run_token_header = request.headers.get("x-workeros-run-token", "")
            if run_token_header:
                run_id = verify_run_token(run_token_header, secret=secret)
                if run_id is None:
                    return JSONResponse(status_code=401, content={"detail": "Invalid or expired run token"})
                if not _RE_COMPOSIO.match(path):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Run-scoped tokens may only call composio-execute endpoints"},
                    )
                path_run_id = path.split("/")[2] if len(path.split("/")) > 2 else ""
                if path_run_id != run_id:
                    return JSONResponse(status_code=403, content={"detail": "Run token run_id does not match path"})
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

        @app.delete("/workers/{worker_id}")
        def delete_worker(worker_id: str): return {"deleted": worker_id}

        @app.post("/runs/{run_id}/composio-execute/{tool}")
        def composio_execute(run_id: str, tool: str): return {"ok": True, "run_id": run_id}

        return app

    def test_run_token_allowed_on_composio_path(self):
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        app = self._make_app(secret)
        client = TestClient(app, raise_server_exceptions=False)

        token = make_run_token("run-abc", secret=secret)
        r = client.post(
            "/runs/run-abc/composio-execute/GMAIL_FETCH_EMAILS",
            headers={"X-Workeros-Run-Token": token},
        )
        assert r.status_code == 200

    def test_run_token_blocked_on_delete_worker(self):
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        app = self._make_app(secret)
        client = TestClient(app, raise_server_exceptions=False)

        token = make_run_token("run-abc", secret=secret)
        r = client.delete(
            "/workers/some-worker",
            headers={"X-Workeros-Run-Token": token},
        )
        assert r.status_code == 403
        assert "composio-execute" in r.json()["detail"]

    def test_run_token_blocked_on_list_workers(self):
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        app = self._make_app(secret)
        client = TestClient(app, raise_server_exceptions=False)

        token = make_run_token("run-abc", secret=secret)
        r = client.get("/workers", headers={"X-Workeros-Run-Token": token})
        assert r.status_code == 403

    def test_run_token_wrong_run_id_in_path_blocked(self):
        """Token for run-abc cannot be used to call run-xyz's composio path."""
        from run_token import make_run_token
        from fastapi.testclient import TestClient

        secret = "my-secret"
        app = self._make_app(secret)
        client = TestClient(app, raise_server_exceptions=False)

        token = make_run_token("run-abc", secret=secret)
        r = client.post(
            "/runs/run-xyz/composio-execute/SOME_TOOL",
            headers={"X-Workeros-Run-Token": token},
        )
        assert r.status_code == 403
        assert "run_id" in r.json()["detail"]

    def test_invalid_run_token_rejected(self):
        from fastapi.testclient import TestClient

        app = self._make_app("my-secret")
        client = TestClient(app, raise_server_exceptions=False)

        r = client.post(
            "/runs/run-abc/composio-execute/SOME_TOOL",
            headers={"X-Workeros-Run-Token": "not-a-valid-token"},
        )
        assert r.status_code == 401

    def test_operator_with_correct_secret_can_delete(self):
        """Operators using x-floom-secret can still call destructive endpoints."""
        from fastapi.testclient import TestClient

        secret = "my-secret"
        app = self._make_app(secret)
        client = TestClient(app, raise_server_exceptions=False)

        r = client.delete("/workers/some-worker", headers={"x-floom-secret": secret})
        assert r.status_code == 200

    def test_operator_with_wrong_secret_rejected(self):
        from fastapi.testclient import TestClient

        app = self._make_app("my-secret")
        client = TestClient(app, raise_server_exceptions=False)

        r = client.delete("/workers/some-worker", headers={"x-floom-secret": "wrong"})
        assert r.status_code == 401

    def test_expired_token_rejected_with_401(self):
        import hashlib, hmac as _hmac
        from fastapi.testclient import TestClient

        secret = "my-secret"
        app = self._make_app(secret)
        client = TestClient(app, raise_server_exceptions=False)

        expired = int(time.time()) - 1
        hex_exp = format(expired, "010x")
        data = f"run:run-abc:{hex_exp}"
        sig = _hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()
        token = f"{data}.{sig}"

        r = client.post(
            "/runs/run-abc/composio-execute/SOME_TOOL",
            headers={"X-Workeros-Run-Token": token},
        )
        assert r.status_code == 401
