"""Tests for NEW-7 (2026-06-02): the raw Composio ``ca_*`` connection id must not
be exposed via GET /connections, and the worker form references a connection by its
internal Floom UUID ``id`` instead.

Covers:
  - GET /connections response omits ``composio_connection_id``.
  - _public_connection_item drops the raw id from the serialized item.
  - _resolve_composio_connection_id maps an internal id -> raw ``ca_*`` and
    passes a raw ``ca_*`` ref through unchanged (backward compatibility).
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _n in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(_n, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _bootstrap_owner(main) -> str:
    return main._bootstrap_user_id()


def test_list_connections_omits_raw_composio_id(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = _bootstrap_owner(main)
    repos.connections.upsert(
        user_id=owner,
        id="conn-uuid-1",
        app_name="gmail",
        composio_connection_id="ca_SECRET_handle",
        status="active",
    )

    client = TestClient(main.app)
    resp = client.get("/connections", headers={"x-floom-secret": "test-secret"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    item = body[0]
    # The internal UUID is still present; the raw Composio handle is gone.
    assert item["id"] == "conn-uuid-1"
    assert item["app_name"] == "gmail"
    assert "composio_connection_id" not in item
    # And the raw value never appears anywhere in the serialized response.
    assert "ca_SECRET_handle" not in resp.text


def test_public_connection_item_drops_raw_id(monkeypatch, tmp_path):
    _db, main = _load_app(monkeypatch, tmp_path)
    item = main._public_connection_item(
        {
            "id": "conn-uuid-2",
            "app_name": "googlecalendar",
            "composio_connection_id": "ca_should_be_hidden",
            "status": "active",
            "created_at": "2026-06-02T00:00:00Z",
            "updated_at": "2026-06-02T00:00:00Z",
        }
    )
    dumped = item.model_dump()
    assert "composio_connection_id" not in dumped
    assert dumped["id"] == "conn-uuid-2"


def test_resolve_connection_id_internal_to_raw(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = _bootstrap_owner(main)
    repos.connections.upsert(
        user_id=owner,
        id="conn-uuid-3",
        app_name="gmail",
        composio_connection_id="ca_real_handle",
        status="active",
    )
    # Internal id resolves to the raw ca_* handle (server-side, with the API key).
    assert main._resolve_composio_connection_id("conn-uuid-3") == "ca_real_handle"


def test_resolve_connection_id_passes_through_raw(monkeypatch, tmp_path):
    _db, main = _load_app(monkeypatch, tmp_path)
    # A legacy worker.yml still carrying a raw ca_* ref must pass through unchanged.
    assert main._resolve_composio_connection_id("ca_legacy_handle") == "ca_legacy_handle"


def test_resolve_connection_id_unknown_falls_back(monkeypatch, tmp_path):
    _db, main = _load_app(monkeypatch, tmp_path)
    # An unknown id falls back to itself so the upstream call surfaces a clear error.
    assert main._resolve_composio_connection_id("conn-does-not-exist") == "conn-does-not-exist"
