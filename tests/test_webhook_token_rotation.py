"""Security tests for webhook URL token rotation (2026-06-02, P1 from the 2139 probe).

BUG fixed: rotating a worker's webhook secret did NOT invalidate the old webhook
URL, because the URL token derived from the platform-global FLOOM_SECRET instead
of the per-worker rotatable secret. A leaked URL was therefore unrevocable.

FIX verified here:
  * token derives from the per-worker rotatable secret hash;
  * rotation changes the token, so the OLD token is rejected (401) and the NEW
    token is accepted;
  * two rotations -> only the newest token works;
  * a worker with no prior secret is backfilled (lazy-init) so a stable token
    key always exists;
  * verification is constant-time (uses hmac.compare_digest);
  * legacy FLOOM_SECRET-derived token is rejected by default (hard cutover) and
    only accepted when WORKEROS_WEBHOOK_LEGACY_TOKEN_GRACE is explicitly on.
"""

import hashlib
import hmac
import importlib
import json
import os
import sys
import types
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_AUTH_HEADER = {"x-floom-secret": "test-secret-webhook-rotate"}


def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_SECRET", _AUTH_HEADER["x-floom-secret"])
    monkeypatch.delenv("WORKEROS_WEBHOOK_LEGACY_TOKEN_GRACE", raising=False)
    monkeypatch.setenv("WORKERS_API_URL", "https://workers-api.floom.dev")

    reset_prefixes = ("auth.", "db.")
    reset_exact = {
        "main", "auth", "contexts", "db", "files", "models",
        "worker_registry", "run_service", "composio_client",
        "runner_utils", "scheduler", "webhook_service",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    main.get_auth_provider.cache_clear()
    return main


def _insert_webhook_worker(main, worker_id, *, owner_id="federico", with_secret=True):
    """Insert a worker whose trigger is a webhook (optionally with secret=true)."""
    now = main.now_iso()
    skill_version_id = f"skill_{worker_id}"
    trigger = {"type": "webhook", "webhook": {"secret": with_secret, "allowed_methods": ["POST"]}}
    manifest = {
        "id": worker_id,
        "name": worker_id,
        "description": "webhook rotation test worker",
        "runtime": {"type": "python311", "entrypoint": "run.py", "runner": "e2b"},
        "trigger": trigger,
        "triggers": [trigger],
        "inputs": [],
        "outputs": [],
    }
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO skill_versions (id, name, version, manifest_json, bundle_path, created_at)
            VALUES (?, ?, '0.1.0', ?, ?, ?)
            """,
            (skill_version_id, worker_id, json.dumps(manifest), f"workers/{worker_id}", now),
        )
        conn.execute(
            """
            INSERT INTO workers (id, skill_version_id, name, trigger_type, triggers_json, created_at, owner_id)
            VALUES (?, ?, ?, 'webhook', ?, ?, ?)
            """,
            (worker_id, skill_version_id, worker_id, json.dumps([trigger]), now, owner_id),
        )


# ---------------------------------------------------------------------------
# Service-level tests (DB-backed, no HTTP)
# ---------------------------------------------------------------------------

class TestRotationInvalidatesToken:
    def test_rotation_changes_token_and_old_is_rejected(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        # Initial token (backfills a secret on first build).
        old_token = ws.current_webhook_token(wid)
        assert ws.verify_webhook_token(wid, old_token) is True

        # Rotate the secret.
        ws.generate_webhook_secret(wid)
        new_token = ws.current_webhook_token(wid)

        assert new_token != old_token, "rotation MUST change the URL token"
        assert ws.verify_webhook_token(wid, old_token) is False, "old token MUST be rejected after rotate"
        assert ws.verify_webhook_token(wid, new_token) is True, "new token MUST be accepted"

    def test_two_rotations_only_newest_works(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        t0 = ws.current_webhook_token(wid)
        ws.generate_webhook_secret(wid)
        t1 = ws.current_webhook_token(wid)
        ws.generate_webhook_secret(wid)
        t2 = ws.current_webhook_token(wid)

        assert len({t0, t1, t2}) == 3, "each rotation produces a distinct token"
        assert ws.verify_webhook_token(wid, t0) is False
        assert ws.verify_webhook_token(wid, t1) is False
        assert ws.verify_webhook_token(wid, t2) is True

    def test_build_webhook_url_reflects_current_token(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        url_before = ws.build_webhook_url(wid)
        ws.generate_webhook_secret(wid)
        url_after = ws.build_webhook_url(wid)

        assert url_before != url_after
        # The URL always carries the current token.
        assert f"token={ws.current_webhook_token(wid)}" in url_after


class TestBackfill:
    def test_worker_with_no_secret_gets_backfilled(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        # Insert with secret=false so no secret is ever generated up front.
        _insert_webhook_worker(main, wid, with_secret=False)

        assert ws.get_webhook_secret_hash(wid) is None, "precondition: no secret yet"

        # First token request lazily mints a secret.
        token = ws.current_webhook_token(wid)
        assert token and len(token) == 32

        key = ws.get_webhook_secret_hash(wid)
        assert key is not None, "backfill MUST persist a token key"
        # Token is reproducible from the backfilled key.
        assert ws.derive_webhook_token(wid, key) == token

    def test_backfill_is_stable_across_calls(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid, with_secret=False)

        t1 = ws.current_webhook_token(wid)
        t2 = ws.current_webhook_token(wid)
        assert t1 == t2, "backfill must not re-mint on every call"

    def test_verify_missing_secret_is_read_only(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid, with_secret=False)

        assert ws.get_webhook_secret_hash(wid) is None, "precondition: no secret yet"
        assert ws.verify_webhook_token(wid, "bad-token") is False
        assert ws.get_webhook_secret_hash(wid) is None, "verification must not backfill"


class TestConstantTime:
    def test_verify_uses_compare_digest(self, monkeypatch):
        """Verification must be constant-time (hmac.compare_digest), not ==."""
        import webhook_service as ws
        import inspect
        src = inspect.getsource(ws.verify_webhook_token)
        assert "compare_digest" in src
        # Ensure no naive equality on the token is used for the decision.
        assert "token == expected" not in src
        assert "token != expected" not in src

    def test_empty_token_rejected(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws
        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)
        assert ws.verify_webhook_token(wid, "") is False


class TestLegacyGrace:
    def _legacy_token(self, worker_id, floom_secret):
        return hmac.new(
            floom_secret.encode(), worker_id.encode(), hashlib.sha256
        ).hexdigest()[:32]

    def test_legacy_token_rejected_by_default(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws
        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        legacy = self._legacy_token(wid, _AUTH_HEADER["x-floom-secret"])
        # Default (grace OFF): legacy token must NOT authorize — hard cutover.
        assert ws.verify_webhook_token(wid, legacy) is False

    def test_legacy_token_accepted_under_grace_flag(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws
        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        legacy = self._legacy_token(wid, _AUTH_HEADER["x-floom-secret"])
        monkeypatch.setenv("WORKEROS_WEBHOOK_LEGACY_TOKEN_GRACE", "1")
        assert ws.verify_webhook_token(wid, legacy) is True
        # Current token still works under grace.
        assert ws.verify_webhook_token(wid, ws.current_webhook_token(wid)) is True
        # A garbage token is still rejected even under grace.
        assert ws.verify_webhook_token(wid, "deadbeef" * 4) is False


# ---------------------------------------------------------------------------
# HTTP-level tests (full webhook + rotate flow)
# ---------------------------------------------------------------------------

class TestHttpFlow:
    def _client(self, main):
        from fastapi.testclient import TestClient
        return TestClient(main.app, raise_server_exceptions=False)

    def test_rotate_endpoint_returns_new_url_and_old_url_stops_working(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws
        client = self._client(main)

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        old_token = ws.current_webhook_token(wid)

        # Old URL works before rotation.
        ok = client.post(f"/webhooks/{wid}?token={old_token}", json={"a": 1})
        assert ok.status_code in (200, 202), ok.text
        assert ok.json().get("status") == "queued"

        # Rotate via the dedicated endpoint.
        rot = client.post(f"/workers/{wid}/webhook-secret/rotate", headers=_AUTH_HEADER)
        assert rot.status_code == 200, rot.text
        body = rot.json()
        assert body.get("secret"), "rotate returns the raw secret once"
        new_url = body.get("webhook_url")
        assert new_url, "rotate MUST return the new webhook_url to re-register"

        # Old token now rejected (401).
        denied = client.post(f"/webhooks/{wid}?token={old_token}", json={"a": 1})
        assert denied.status_code == 401, denied.text

        # New token (from the returned URL) accepted.
        new_token = new_url.split("token=", 1)[1]
        assert new_token != old_token
        accepted = client.post(f"/webhooks/{wid}?token={new_token}", json={"a": 1})
        assert accepted.status_code in (200, 202), accepted.text

    def test_worker_detail_surfaces_current_url(self, monkeypatch, tmp_path):
        main = _load_api(monkeypatch, tmp_path)
        import webhook_service as ws
        client = self._client(main)

        wid = f"wk-{uuid.uuid4().hex[:8]}"
        _insert_webhook_worker(main, wid)

        detail = client.get(f"/workers/{wid}", headers=_AUTH_HEADER)
        assert detail.status_code == 200, detail.text
        url = detail.json().get("webhook_url")
        assert url, "webhook worker detail must surface a webhook_url"
        token = url.split("token=", 1)[1]
        assert ws.verify_webhook_token(wid, token) is True
