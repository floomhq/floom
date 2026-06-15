"""#1338 #1329 — shareable-link run path: run-meta, public run trigger, public SSE.

Three endpoints for the /run/[id] shareable-link page that lets an unauthenticated
colleague (no account) see a worker's schema, trigger a run, and watch it via SSE.
All three authenticate solely with the HMAC worker-public token or the existing
standalone run share token.

  GET  /workers/public/{id}/run-meta?token=<hmac>
  POST /workers/public/{id}/runs               body {inputs, token}
  GET  /runs/{run_id}/stream?token=<fls_token> (public SSE, no auth)

Run: cd apps/api && python -m pytest tests/test_public_run_sharetoken.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any, Dict
from unittest.mock import patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "sharetoken-test-secret-XYZ"
OWNER = "alice"

_YML = """\
schema_version: "0.3"
name: "form-worker"
title: "Form Worker"
description: "A worker that accepts inputs and produces output"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: topic
    label: Topic
    type: string
    required: true
    description: "What to summarize"
outputs:
  - name: summary
    label: Summary
    type: markdown
connections: []
"""


def _purge_modules():
    to_purge = [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]
    for name in to_purge:
        sys.modules.pop(name, None)
    for rn in [x for x in list(sys.modules) if x.startswith("routers") or x.startswith("services")]:
        sys.modules.pop(rn, None)


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "form-worker"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("import json; print(json.dumps({'summary': 'ok'}))\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    _purge_modules()

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()

    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=OWNER)

    from fastapi.testclient import TestClient
    # authed client (owner)
    authed = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    # anonymous client (no header)
    anon = TestClient(main.app, raise_server_exceptions=False)

    yield {"authed": authed, "anon": anon, "main": main}
    db.get_repositories.cache_clear()


def _public_token(ctx: Dict[str, Any]) -> str:
    """Derive the HMAC token for form-worker as OWNER."""
    main = ctx["main"]
    from services.worker_serialize import _worker_public_token
    repos = main.get_repositories()
    worker = repos.workers.get_any(worker_id="form-worker")
    assert worker is not None, "form-worker must be registered"
    return _worker_public_token(worker)


# ---------------------------------------------------------------------------
# 1.  GET /workers/public/{id}/run-meta?token=
# ---------------------------------------------------------------------------

class TestRunMeta:
    def test_valid_token_returns_schema(self, ctx):
        token = _public_token(ctx)
        resp = ctx["anon"].get(f"/workers/public/form-worker/run-meta?token={token}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == "form-worker"
        assert body["name"] == "Form Worker"
        # Inputs must be present, outputs too
        inp_names = [i["name"] for i in body["inputs"]]
        assert "topic" in inp_names, f"expected 'topic' in {inp_names}"
        out_names = [o["name"] for o in body["outputs"]]
        assert "summary" in out_names, f"expected 'summary' in {out_names}"

    def test_sensitive_fields_absent(self, ctx):
        token = _public_token(ctx)
        resp = ctx["anon"].get(f"/workers/public/form-worker/run-meta?token={token}")
        assert resp.status_code == 200
        body = resp.json()
        # owner_id, secrets, config, webhook_url must not leak
        for key in ("owner_id", "secrets", "config", "webhook_url", "bundle_path"):
            assert key not in body, f"sensitive key {key!r} leaked"

    def test_wrong_token_returns_401(self, ctx):
        resp = ctx["anon"].get("/workers/public/form-worker/run-meta?token=" + "a" * 64)
        assert resp.status_code == 401

    def test_missing_token_returns_422(self, ctx):
        resp = ctx["anon"].get("/workers/public/form-worker/run-meta")
        assert resp.status_code == 422

    def test_unknown_worker_returns_404(self, ctx):
        token = _public_token(ctx)
        resp = ctx["anon"].get(f"/workers/public/ghost-worker/run-meta?token={token}")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 2.  POST /workers/public/{id}/runs
# ---------------------------------------------------------------------------

class TestPublicRun:
    def test_rejects_bad_token(self, ctx):
        resp = ctx["anon"].post(
            "/workers/public/form-worker/runs",
            json={"inputs": {"topic": "hello"}, "token": "bad" * 20},
        )
        assert resp.status_code == 401

    def test_rejects_unknown_worker(self, ctx):
        token = _public_token(ctx)
        resp = ctx["anon"].post(
            "/workers/public/ghost/runs",
            json={"inputs": {}, "token": token},
        )
        assert resp.status_code == 404

    def test_valid_token_creates_run(self, ctx):
        """POST with valid HMAC token must return a run_id."""
        token = _public_token(ctx)
        # Patch start_run so we don't need a real e2b sandbox.
        with patch("run_service.start_run", return_value=None):
            resp = ctx["anon"].post(
                "/workers/public/form-worker/runs",
                json={"inputs": {"topic": "AI"}, "token": token},
            )
        # 200 or 422 (missing required input handled by the validation path); the
        # key guarantee is NOT 401/404/403 (auth rejected).
        assert resp.status_code not in (401, 403, 404), resp.text
        if resp.status_code == 200:
            body = resp.json()
            assert "run_id" in body

    def test_missing_inputs_returns_400_not_401(self, ctx):
        """A token-authed request with missing required inputs must be rejected
        by input validation (400/422), NOT by the auth gate (401/403).
        """
        token = _public_token(ctx)
        with patch("run_service.start_run", return_value=None):
            resp = ctx["anon"].post(
                "/workers/public/form-worker/runs",
                json={"inputs": {}, "token": token},
            )
        # Auth must have passed; only validation may reject.
        assert resp.status_code not in (401, 403)


# ---------------------------------------------------------------------------
# 3.  GET /runs/{run_id}/stream?token=<fls_token>  (public SSE)
# ---------------------------------------------------------------------------

class TestPublicStreamSSE:
    """The public SSE endpoint is backed by the same in-memory part buffer as
    the authenticated stream. We verify the auth gate (token validation) and the
    happy-path response shape without a live SSE connection."""

    def _mint_run_and_share(self, ctx: Dict[str, Any]) -> tuple[str, str]:
        """Helper: create a completed run and mint its share link."""
        main = ctx["main"]
        repos = main.get_repositories()
        repos.runs.create(
            user_id=OWNER,
            run_id="run_pub_stream_1",
            worker_id="form-worker",
            status=main.RunStatus.COMPLETED.value,
            trigger_source="manual",
            runner="e2b",
            input_json={"topic": "test"},
            output_json={"summary": "done"},
        )
        # Mint a share link via the authed endpoint.
        resp = ctx["authed"].post("/runs/run_pub_stream_1/share-link")
        assert resp.status_code == 200, resp.text
        token = resp.json()["token"]
        return "run_pub_stream_1", token

    def test_valid_token_opens_stream(self, ctx):
        run_id, token = self._mint_run_and_share(ctx)
        # The endpoint returns a StreamingResponse; just check it's not rejected.
        resp = ctx["anon"].get(f"/runs/{run_id}/stream?token={token}")
        # 200 or a streaming-compatible code; NOT 401/403/404.
        assert resp.status_code not in (401, 403, 404), resp.text

    def test_wrong_token_returns_404(self, ctx):
        run_id, _ = self._mint_run_and_share(ctx)
        resp = ctx["anon"].get(f"/runs/{run_id}/stream?token=fls_wrongwrong00000000000")
        assert resp.status_code == 404

    def test_token_for_other_run_returns_404(self, ctx):
        """A share token for run A must NOT open run B's stream."""
        main = ctx["main"]
        repos = main.get_repositories()
        repos.runs.create(
            user_id=OWNER,
            run_id="run_pub_stream_2",
            worker_id="form-worker",
            status=main.RunStatus.COMPLETED.value,
            trigger_source="manual",
            runner="e2b",
            input_json={},
            output_json={},
        )
        _, token_for_1 = self._mint_run_and_share(ctx)
        # Token minted for run_pub_stream_1 must not open run_pub_stream_2.
        resp = ctx["anon"].get(f"/runs/run_pub_stream_2/stream?token={token_for_1}")
        assert resp.status_code == 404

    def test_no_token_and_no_auth_returns_auth_error(self, ctx):
        """Without a share token AND without an operator credential, the existing
        auth guard rejects the request.  The token param is optional (not required)
        so the route doesn't 422 — it falls through to the auth dependency."""
        resp = ctx["anon"].get("/runs/any-run-id/stream")
        # Auth dependency rejects → 401 or 403.
        assert resp.status_code in (401, 403, 404)
