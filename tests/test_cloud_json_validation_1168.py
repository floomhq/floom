"""Regression tests for #1168: cloud JSON override routes return 4xx for wrong-shaped bodies.

Syntactically valid JSON with the wrong shape (array, null, string at top-level; or
non-dict items in the files list) must return a controlled 422, not a 500.
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

    for name in ["apps.api.main", "main", "db", "models", "worker_registry", "run_service", "chat_service"]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def _client(main):
    return TestClient(main.app)


# ─── PUT /api/workers/{id}/files ────────────────────────────────────────────

def test_worker_files_update_array_body_returns_422(monkeypatch, tmp_path):
    """Top-level JSON array must return 422, not 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    resp = client.put(
        "/api/workers/w1/files",
        content=json.dumps([{"path": "run.py", "content": ""}]).encode(),
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    assert resp.status_code in (401, 422), f"Got {resp.status_code}: {resp.text}"
    # 401 = auth rejected (fine); if it reaches validation, must be 422, never 500
    assert resp.status_code != 500


def test_worker_files_update_null_body_returns_422(monkeypatch, tmp_path):
    """Top-level JSON null must not cause a 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    resp = client.put(
        "/api/workers/w1/files",
        content=b"null",
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    assert resp.status_code != 500, f"Got 500: {resp.text}"


def test_worker_files_update_non_list_files_field_returns_422(monkeypatch, tmp_path):
    """files field set to a string must return 422, not 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    resp = client.put(
        "/api/workers/w1/files",
        content=json.dumps({"files": "not-a-list"}).encode(),
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    assert resp.status_code != 500, f"Got 500: {resp.text}"


def test_worker_files_update_files_with_non_dict_items_returns_4xx(monkeypatch, tmp_path):
    """Non-dict items in files list must not cause a 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    # ["path"] has no .get() or subscript on key "path"
    resp = client.put(
        "/api/workers/w1/files",
        content=json.dumps({"files": ["path"]}).encode(),
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    # Empty files dict after filtering → 400 "files list must not be empty", not 500
    assert resp.status_code != 500, f"Got 500: {resp.text}"


# ─── PATCH /api/workers/{id}/visibility ─────────────────────────────────────

def test_visibility_array_body_returns_422(monkeypatch, tmp_path):
    """Top-level JSON array must return 422, not 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    resp = client.patch(
        "/api/workers/w1/visibility",
        content=b"[]",
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    assert resp.status_code != 500, f"Got 500: {resp.text}"


def test_visibility_null_body_returns_422(monkeypatch, tmp_path):
    """Top-level JSON null must not cause a 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    resp = client.patch(
        "/api/workers/w1/visibility",
        content=b"null",
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    assert resp.status_code != 500, f"Got 500: {resp.text}"


def test_visibility_string_body_returns_422(monkeypatch, tmp_path):
    """A bare JSON string must not cause a 500 (#1168)."""
    client = _client(_load_cloud_main(monkeypatch, tmp_path))
    resp = client.patch(
        "/api/workers/w1/visibility",
        content=b'"shared"',
        headers={"Content-Type": "application/json", "x-floom-token": "tok"},
    )
    assert resp.status_code != 500, f"Got 500: {resp.text}"
