from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    env_file = tmp_path / "api.env"
    env_file.write_text("")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(env_file))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))

    for name in [
        "main",
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "files",
        "worker_registry",
        "run_service",
        "webhook_service",
        "composio_client",
        "scheduler",
        "auth",
        "auth.context",
        "auth.dependency",
        "auth.factory",
        "auth.interface",
        "auth.local",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_post_workers_replays_buffered_body_once(monkeypatch, tmp_path):
    main = load_main(monkeypatch, tmp_path)
    payload = {
        "worker_yml": """id: phase2-smoke
name: Phase 2 Smoke
description: Echo smoke worker.
trigger:
  type: manual
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
inputs: []
outputs:
  - name: result
    type: string
    label: Result
secrets: []
connections: []
""",
        "run_py": """from typing import Any, Dict


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    context["log"]("phase2 smoke run")
    return {"status": "success", "outputs": {"result": "ok"}, "artifacts": []}
""",
    }

    with TestClient(main.app) as client:
        response = client.post(
            "/workers",
            headers={"x-floom-secret": "test-secret"},
            json=payload,
        )

        assert response.status_code == 200, response.text
        assert response.json()["id"] == "phase2-smoke"

        list_response = client.get(
            "/workers",
            headers={"x-floom-secret": "test-secret"},
        )
        assert list_response.status_code == 200, list_response.text
        assert any(item["id"] == "phase2-smoke" for item in list_response.json())


def test_default_json_oversize_returns_friendly_message(monkeypatch, tmp_path):
    main = load_main(monkeypatch, tmp_path)
    payload = {"prompt": "x" * (main.DEFAULT_JSON_BODY_LIMIT_BYTES + 1)}

    with TestClient(main.app) as client:
        response = client.post(
            "/workers/draft-from-prompt",
            headers={"x-floom-secret": "test-secret"},
            json=payload,
        )

    assert response.status_code == 413
    detail = response.json()["detail"]
    assert "Request body is too large" in detail
    assert detail != "Request body too large"


def _make_request(path: str, method: str = "POST", root_path: str = ""):
    """Build a minimal Starlette Request with a given ASGI path.

    When mounted under a prefix (cloud mounts the engine under /api), Starlette
    sets scope['root_path'] to the mount prefix while scope['path'] keeps the
    full prefixed path — exactly the shape that breaks the bare exemption
    checks. Pass root_path to simulate that mounted case.
    """
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "root_path": root_path,
        "headers": [],
        "query_string": b"",
        "scheme": "http",
        "server": ("testserver", 80),
        "client": ("testclient", 50000),
    }
    return Request(scope)


def test_body_limit_helpers_are_mount_prefix_agnostic(monkeypatch, tmp_path):
    """B10: cloud mounts the engine under /api, so exemption checks must see
    through a leading /api mount prefix. The un-prefixed path and the
    /api-prefixed path must resolve to the SAME limit / classification."""
    main = load_main(monkeypatch, tmp_path)

    def mounted(path: str, method: str = "POST"):
        # Mounted shape: full /api-prefixed scope['path'] + root_path='/api',
        # exactly what Starlette produces when the engine is mounted under /api.
        return _make_request(path, method=method, root_path="/api")

    # Context upload: exempt (None) on BOTH the bare and the /api-mounted path.
    assert main._body_limit_for_request(_make_request("/contexts/x/upload")) is None
    assert main._body_limit_for_request(mounted("/api/contexts/x/upload")) is None

    assert main._is_context_upload_request(_make_request("/contexts/x/upload")) is True
    assert main._is_context_upload_request(mounted("/api/contexts/x/upload")) is True

    # Approval screenshot uploads: exempt on both.
    assert main._body_limit_for_request(_make_request("/approvals/a/uploads")) is None
    assert main._body_limit_for_request(mounted("/api/approvals/a/uploads")) is None

    # from-bundle / workspace import: generous caps on both.
    assert (
        main._body_limit_for_request(_make_request("/workers/from-bundle"))
        == main.FROM_BUNDLE_BODY_LIMIT_BYTES
    )
    assert (
        main._body_limit_for_request(mounted("/api/workers/from-bundle"))
        == main.FROM_BUNDLE_BODY_LIMIT_BYTES
    )
    assert (
        main._body_limit_for_request(_make_request("/workspace/import"))
        == main.WORKSPACE_IMPORT_BODY_LIMIT_BYTES
    )
    assert (
        main._body_limit_for_request(mounted("/api/workspace/import"))
        == main.WORKSPACE_IMPORT_BODY_LIMIT_BYTES
    )

    # PUT /workers/{id}/files: generous cap on both.
    assert (
        main._body_limit_for_request(_make_request("/workers/w/files", method="PUT"))
        == main.WORKER_FILES_BODY_LIMIT_BYTES
    )
    assert (
        main._body_limit_for_request(mounted("/api/workers/w/files", method="PUT"))
        == main.WORKER_FILES_BODY_LIMIT_BYTES
    )

    # A genuinely non-exempt JSON path keeps the small default on both forms.
    assert (
        main._body_limit_for_request(_make_request("/workers/draft-from-prompt"))
        == main.DEFAULT_JSON_BODY_LIMIT_BYTES
    )
    assert (
        main._body_limit_for_request(mounted("/api/workers/draft-from-prompt"))
        == main.DEFAULT_JSON_BODY_LIMIT_BYTES
    )

    # Guard against over-stripping: a path that merely *starts with* the prefix
    # string but is a different segment (/apiary) must NOT be normalized.
    assert (
        main._body_limit_for_request(
            _make_request("/apiary/contexts/x/upload", root_path="/api")
        )
        == main.DEFAULT_JSON_BODY_LIMIT_BYTES
    )


def test_api_mounted_context_upload_not_413_for_one_mb(monkeypatch, tmp_path):
    """B10 (cloud repro): with the engine mounted under /api (as workeros-cloud
    does), a >256KB upload to /api/contexts/x/upload must NOT be rejected with
    413 by the body-size middleware. It should reach the route (auth/404),
    never 413."""
    main = load_main(monkeypatch, tmp_path)

    parent = FastAPI()
    parent.mount("/api", main.app)

    one_mb = b"x" * (1024 * 1024 + 1024)  # ~1 MB, well over the 256KB default
    with TestClient(parent) as client:
        # Authenticate so the request gets past auth_middleware and actually
        # reaches the body-size middleware (the live repro is an authed cookie
        # request; an unauthed one short-circuits at 401 before body size).
        response = client.post(
            "/api/contexts/test/upload",
            headers={"x-floom-secret": "test-secret"},
            files={"files": ("img.png", one_mb, "image/png")},
        )

    assert response.status_code != 413, (
        f"middleware 413'd a 1MB upload on the /api-mounted path: {response.text}"
    )


def test_worker_files_put_accepts_four_mb_payload(monkeypatch, tmp_path):
    main = load_main(monkeypatch, tmp_path)
    worker_yml = """id: large-files
name: Large Files
description: Worker with bundled data.
trigger:
  type: manual
runtime:
  type: python
  entrypoint: run.py
  runner: e2b
inputs: []
outputs:
  - name: result
    type: string
    label: Result
secrets: []
connections: []
"""
    run_py = """import json

with open("result.json", "w", encoding="utf-8") as handle:
    json.dump({"status": "success", "outputs": {"result": "ok"}, "artifacts": []}, handle)
"""

    with TestClient(main.app) as client:
        created = client.post(
            "/workers",
            headers={"x-floom-secret": "test-secret"},
            json={"worker_yml": worker_yml, "run_py": run_py},
        )
        assert created.status_code == 200, created.text

        large_payload = "x" * (4 * 1024 * 1024)
        updated = client.put(
            "/workers/large-files/files",
            headers={"x-floom-secret": "test-secret"},
            json={
                "files": [
                    {"path": "worker.yml", "content": worker_yml},
                    {"path": "run.py", "content": run_py},
                    {"path": "candidates.json", "content": large_payload},
                ]
            },
        )

    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["id"] == "large-files"
    assert any(item["path"] == "candidates.json" for item in body["files"])
