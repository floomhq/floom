from __future__ import annotations

import importlib
import io
import json
import os
import sys
import types
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
WEB_DIR = Path(__file__).resolve().parents[1] / "apps" / "web"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "round7-secret"}


def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("COMPOSIO_API_KEY", "cmp-test")
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_USER_ID", "federico")
    monkeypatch.setenv("trusted_proxies", "*")
    monkeypatch.delenv("WORKEROS_ENABLE_INTERNAL_AUTH_CONFIGS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN_REGEX", raising=False)
    monkeypatch.delenv("WORKEROS_DEV", raising=False)

    reset_prefixes = ("auth.", "db.", "routers")
    reset_exact = {
        "main",
        "auth",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    main._ENV_PATH = tmp_path / ".env"
    main._rate_buckets.clear()
    with main.get_db() as conn:
        conn.execute("DELETE FROM cli_auth_devices")
    return main


def _headers(user_id: str = "federico") -> dict[str, str]:
    return {**AUTH, "x-floom-user": user_id}


def _stored_zip(size_bytes: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("worker.yml", b"A" * size_bytes)
    return buffer.getvalue()


def _insert_connection(main, *, user_id: str = "federico") -> str:
    local_id = str(uuid.uuid4())
    now = main.now_iso()
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO composio_connections
                (id, app_name, composio_connection_id, status, created_at, updated_at, user_id)
            VALUES (?, 'gmail', ?, 'active', ?, ?, ?)
            """,
            (local_id, f"ca_{uuid.uuid4().hex}", now, now, user_id),
        )
    return local_id


def _insert_minimal_worker(main, worker_id: str) -> None:
    now = main.now_iso()
    skill_version_id = f"sv_{worker_id}"
    manifest = {
        "schema_version": "0.3",
        "name": worker_id,
        "title": "Test Worker",
        "description": "Test worker",
        "version": "0.1.0",
        "entrypoint": "run.py",
        "targets": ["generic"],
        "exec": {
            "command": "python run.py",
            "runtime": "python311",
            "mode": "pure-script",
            "runner": "e2b",
            "inputs": [],
            "outputs": [],
        },
        "trigger": {"type": "manual"},
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
            INSERT INTO workers (id, skill_version_id, name, trigger_type, created_at, owner_id)
            VALUES (?, ?, ?, 'manual', ?, 'federico')
            """,
            (worker_id, skill_version_id, worker_id, now),
        )


def _insert_run_with_logs(main) -> str:
    worker_id = "log-worker"
    run_id = f"run_{uuid.uuid4().hex}"
    now = main.now_iso()
    _insert_minimal_worker(main, worker_id)
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner, input_json, output_json, created_at)
            VALUES (?, ?, 'completed', 'manual', 'e2b', '{}', '{}', ?)
            """,
            (run_id, worker_id, now),
        )
        conn.execute(
            """
            INSERT INTO logs (run_id, level, message, timestamp, trace_id)
            VALUES (?, 'info', ?, ?, ?)
            """,
            (run_id, "trace_a2278662e7ae4e05 mode=agent runner=e2b internal step", now, "trace_a2278662e7ae4e05"),
        )
    return run_id


def test_workers_validation_does_not_echo_input(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    marker = "R7_VALIDATION_MARKER_" * 500

    resp = client.post("/workers", headers=_headers(), json={"worker_yml": marker, "run_py": 123})

    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"] == "validation failed"
    assert marker not in resp.text
    assert '"input"' not in resp.text
    assert '"ctx"' not in resp.text
    assert body["errors"]
    assert all(set(error) == {"loc", "msg", "type"} for error in body["errors"])


def test_workers_oversize_json_rejected_413(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    payload = b'{"name":"' + (b"A" * (main.WORKER_FILES_BODY_LIMIT_BYTES + 1)) + b'"}'

    resp = client.post(
        "/workers",
        headers={**_headers(), "content-type": "application/json"},
        content=payload,
    )

    assert resp.status_code == 413


def test_bundle_oversize_rejected_413(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    bundle = _stored_zip(6 * 1024 * 1024)

    resp = client.post(
        "/workers/from-bundle",
        headers=_headers(),
        files={"bundle": ("bundle.zip", bundle, "application/zip")},
    )

    assert resp.status_code == 413


def test_cli_auth_devices_ratelimited(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    responses = [
        client.post("/cli-auth/devices", json={"client_name": "floom-cli"})
        for _ in range(6)
    ]

    assert [response.status_code for response in responses[:5]] == [200] * 5
    assert responses[5].status_code == 429


def test_cli_auth_store_bounded(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    first_device_code = ""

    for index in range(101):
        resp = client.post(
            "/cli-auth/devices",
            headers={"CF-Connecting-IP": f"10.0.0.{index + 1}"},
            json={"client_name": "floom-cli"},
        )
        assert resp.status_code == 200, resp.text
        if index == 0:
            first_device_code = resp.json()["device_code"]

    records = main.get_repositories().cli_auth.list(user_id="federico")
    assert len(records) == 100
    assert first_device_code not in {record["device_code"] for record in records}


def test_cli_auth_requires_typed_code():
    page = (WEB_DIR / "app" / "cli-auth" / "page.tsx").read_text(encoding="utf-8")

    assert 'id="cli-auth-confirm-code"' in page
    assert "normalizedConfirmCode === code" in page
    assert "disabled={!canApprove" in page


def test_secret_name_too_long_rejected(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(f"/secrets/{'A' * 65}", headers=_headers(), json={"value": "x"})

    assert resp.status_code == 422
    assert not main._ENV_PATH.exists()


def test_secret_value_too_large_rejected(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post("/secrets/VALID_NAME", headers=_headers(), json={"value": "x" * (32 * 1024 + 1)})

    assert resp.status_code == 422
    assert not main._ENV_PATH.exists()


def test_secret_name_invalid_chars_rejected(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post("/secrets/invalid-name", headers=_headers(), json={"value": "x"})

    assert resp.status_code == 422
    assert not main._ENV_PATH.exists()


def test_ratelimit_uses_cf_connecting_ip(monkeypatch, tmp_path):
    """The IP rate limiter must bucket on CF-Connecting-IP, not the CF edge IP.

    Run-create is rate-limited by a per-user DB quota (not by IP), so this
    exercises an IP-keyed path instead: /cli-auth/devices is unauthenticated
    and capped at 5/60s per client IP. A different CF-Connecting-IP gets a
    fresh bucket, proving the limiter keys on the real client IP that
    Cloudflare forwards rather than the shared edge IP.
    """
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    responses = [
        client.post(
            "/cli-auth/devices",
            headers={"CF-Connecting-IP": "1.2.3.4"},
            json={"client_name": "ratelimit-test"},
        )
        for _ in range(6)
    ]
    changed_ip = client.post(
        "/cli-auth/devices",
        headers={"CF-Connecting-IP": "5.6.7.8"},
        json={"client_name": "ratelimit-test"},
    )

    # 6th request from the same client IP exceeds the 5/60s cap.
    assert responses[-1].status_code == 429
    # A different forwarded client IP gets a fresh bucket (proves CF-IP keying).
    assert changed_ip.status_code == 200


def test_run_logs_no_internal_metadata(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    run_id = _insert_run_with_logs(main)

    resp = client.get(f"/runs/{run_id}/logs", headers=_headers())

    assert resp.status_code == 200
    assert "trace_" not in resp.text
    assert "runner" not in resp.text
    assert "mode" not in resp.text


def test_account_info_strips_internal_ids(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    connection_id = _insert_connection(main)

    with patch("routers.connections._fetch_composio_account_info") as fetch_info:
        fetch_info.return_value = {
            "email": "user@example.com",
            "scopes": ["gmail.readonly"],
            "user_id": "federico",
            "auth_config_id": "ac_internal",
        }
        resp = client.get(f"/connections/{connection_id}/account-info", headers=_headers())

    assert resp.status_code == 200
    body = resp.json()
    # Single-tenant owner view (#233): account-info returns the OWNER's own
    # connected account identity (their real Google/GitHub email) so the UI can
    # show the real login instead of a placeholder. This is the owner's own
    # data, not a cross-tenant leak. INTERNAL identifiers (user_id,
    # auth_config_id) are still stripped — that is the actual security invariant.
    assert body == {
        "email": "user@example.com",
        "scopes": ["gmail.readonly"],
        "connected_at": body["connected_at"],
    }
    assert "user_id" not in body
    assert "auth_config_id" not in body
    assert "ac_internal" not in resp.text
    assert "federico" not in resp.text


def test_auth_configs_endpoint_internal_only(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.get("/connections/auth-configs/ac_internal", headers=_headers())

    assert resp.status_code == 404
