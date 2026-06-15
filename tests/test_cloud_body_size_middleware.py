"""Regression tests for #1166: cloud override routes enforce body-size limits.

Cloud override routes are registered on the cloud FastAPI app BEFORE the engine
sub-app is mounted, so the engine's request_body_size_middleware never fires for
them.  cloud_body_size_middleware must cap these routes at DEFAULT_JSON_BODY_LIMIT
and return 413 before the handler reads the body.
"""
from __future__ import annotations

import importlib
import json
import sys
import types

from fastapi.testclient import TestClient


def _load_cloud_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    for name in [
        "apps.api.main",
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def _oversized_body(limit_bytes: int, extra: int = 1024) -> bytes:
    """Return a JSON bytes body larger than limit_bytes."""
    payload = {"data": "x" * (limit_bytes + extra)}
    return json.dumps(payload).encode()


def test_cloud_draft_and_create_rejects_oversized_body(monkeypatch, tmp_path):
    """POST /api/workers/draft-and-create must return 413 for bodies > 256 KiB (#1166)."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    client = TestClient(main.app)
    body = _oversized_body(256 * 1024)
    resp = client.post(
        "/api/workers/draft-and-create",
        content=body,
        headers={"Content-Type": "application/json", "x-floom-token": "test-token"},
    )
    assert resp.status_code == 413, f"Expected 413, got {resp.status_code}: {resp.text}"


def test_cloud_worker_files_update_rejects_oversized_body(monkeypatch, tmp_path):
    """PUT /api/workers/{id}/files must return 413 for bodies > 256 KiB (#1166)."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    client = TestClient(main.app)
    body = _oversized_body(256 * 1024)
    resp = client.put(
        "/api/workers/test-worker/files",
        content=body,
        headers={"Content-Type": "application/json", "x-floom-token": "test-token"},
    )
    assert resp.status_code == 413, f"Expected 413, got {resp.status_code}: {resp.text}"


def test_cloud_mcp_endpoint_rejects_oversized_body(monkeypatch, tmp_path):
    """POST /mcp/{workspace_id} must return 413 for bodies > 256 KiB (#1166)."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    client = TestClient(main.app)
    body = _oversized_body(256 * 1024)
    resp = client.post(
        "/mcp/test-workspace",
        content=body,
        headers={"Content-Type": "application/json", "x-floom-token": "test-token"},
    )
    assert resp.status_code == 413, f"Expected 413, got {resp.status_code}: {resp.text}"


def test_cloud_webhook_rejects_oversized_body(monkeypatch, tmp_path):
    """POST /api/webhooks/{worker_id} must return 413 for bodies > 1 MB (#1166)."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    client = TestClient(main.app)
    # Webhook limit is 1 MB (_MAX_WEBHOOK_BODY_BYTES); send 2 MB.
    body = _oversized_body(1 * 1024 * 1024)
    resp = client.post(
        "/api/webhooks/test-worker?token=some-token",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 413, f"Expected 413, got {resp.status_code}: {resp.text}"


def test_cloud_body_limit_via_content_length_header(monkeypatch, tmp_path):
    """413 must fire on Content-Length hint even before the body is fully read (#1166)."""
    main = _load_cloud_main(monkeypatch, tmp_path)
    client = TestClient(main.app)
    limit = 256 * 1024
    resp = client.post(
        "/api/workers/draft-and-create",
        content=b"x" * (limit + 1),
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(limit + 1),
            "x-floom-token": "test-token",
        },
    )
    assert resp.status_code == 413, f"Expected 413, got {resp.status_code}: {resp.text}"


def test_small_body_is_not_rejected(monkeypatch, tmp_path):
    """Bodies within the limit must not be rejected by the size middleware (#1166).

    Auth will reject (401) but not the body-size check (413).
    """
    main = _load_cloud_main(monkeypatch, tmp_path)
    client = TestClient(main.app)
    body = json.dumps({"prompt": "hello"}).encode()
    resp = client.post(
        "/api/workers/draft-and-create",
        content=body,
        headers={"Content-Type": "application/json", "x-floom-token": "test-token"},
    )
    # The middleware must NOT reject small bodies; auth/handler responds 4xx/5xx.
    assert resp.status_code != 413, f"Small body must not be rejected: {resp.text}"
