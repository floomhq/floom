"""Integration tests for secret detection at the context-write boundary.

Covers:
  * PUT /contexts/{name}/files/... returns secret_warnings (warn default) and
    persists has_secret_warning so the UI can badge the file.
  * A clean write returns no warnings.
  * Strict mode (WORKEROS_BLOCK_SECRETS_IN_CONTEXTS=1) rejects the write 400.
  * GET /contexts/{name}/secret-scan flags a planted key (masked).
  * No raw secret value ever appears in any response body.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# A synthetic AWS key (fake, shaped to match AKIA[0-9A-Z]{16}).
PLANTED_KEY = "AKIAIOSFODNN7EXAMPLE"


def _build_client(monkeypatch, tmp_path, *, block=False):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-scan")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "0")
    if block:
        monkeypatch.setenv("WORKEROS_BLOCK_SECRETS_IN_CONTEXTS", "1")
    else:
        monkeypatch.delenv("WORKEROS_BLOCK_SECRETS_IN_CONTEXTS", raising=False)

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "secret_scan",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-scan"})
    return client, db


def _make_pack(client, name="leakpack"):
    resp = client.post(f"/contexts/{name}", json={"writeable": True})
    assert resp.status_code in (200, 201), resp.text
    return name


def test_write_returns_secret_warning_and_persists_flag(monkeypatch, tmp_path):
    client, db = _build_client(monkeypatch, tmp_path)
    with client:
        name = _make_pack(client)
        body = f"AWS creds\naws_key = {PLANTED_KEY}\n"
        resp = client.put(
            f"/contexts/{name}/files/creds.md",
            json={"content": body},
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["has_secret_warning"] is True
        warnings = payload["secret_warnings"]
        assert warnings, "expected secret_warnings on the write response"
        assert any(w["pattern"] == "AWS Access Key ID" for w in warnings)
        # IRON RULE: raw secret never returned.
        assert PLANTED_KEY not in resp.text
        for w in warnings:
            assert PLANTED_KEY not in w["masked"]

        # Flag persisted: the file shows up flagged in the pack detail.
        detail = client.get(f"/contexts/{name}").json()
        flagged = {f["path"]: f for f in detail["files"]}
        assert flagged["creds.md"]["has_secret_warning"] is True
    db.get_repositories.cache_clear()


def test_clean_write_has_no_warning(monkeypatch, tmp_path):
    client, db = _build_client(monkeypatch, tmp_path)
    with client:
        name = _make_pack(client, "cleanpack")
        resp = client.put(
            f"/contexts/{name}/files/notes.md",
            json={"content": "# Notes\nThe capital of France is Paris.\n"},
        )
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["has_secret_warning"] is False
        assert payload["secret_warnings"] == []
    db.get_repositories.cache_clear()


def test_block_mode_rejects_write(monkeypatch, tmp_path):
    client, db = _build_client(monkeypatch, tmp_path, block=True)
    with client:
        name = _make_pack(client, "strictpack")
        resp = client.put(
            f"/contexts/{name}/files/creds.md",
            json={"content": f"key={PLANTED_KEY}\n"},
        )
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert "live credential" in detail
        assert "AWS Access Key ID" in detail
        # The masked snippet, not the raw key, appears in the error.
        assert PLANTED_KEY not in resp.text
        # And the file must NOT have been written to disk.
        got = client.get(f"/contexts/{name}/files/creds.md")
        assert got.status_code == 404
    db.get_repositories.cache_clear()


def test_secret_scan_endpoint_flags_planted_key(monkeypatch, tmp_path):
    client, db = _build_client(monkeypatch, tmp_path)
    with client:
        name = _make_pack(client, "auditpack")
        # Plant a key directly via a clean-looking write (warn mode stores it).
        client.put(
            f"/contexts/{name}/files/legacy.txt",
            json={"content": f"old config\ntoken = {PLANTED_KEY}\n"},
        )
        client.put(
            f"/contexts/{name}/files/safe.md",
            json={"content": "nothing sensitive here\n"},
        )
        resp = client.get(f"/contexts/{name}/secret-scan")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["name"] == name
        assert data["scanned_files"] >= 2
        flagged_paths = {f["path"] for f in data["flagged_files"]}
        assert "legacy.txt" in flagged_paths
        assert "safe.md" not in flagged_paths
        # No raw value in the audit response.
        assert PLANTED_KEY not in resp.text
    db.get_repositories.cache_clear()
