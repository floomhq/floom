"""#925 — workspace export hardening: persistent audit trail.

The export endpoint is already admin-gated (#925) and rate-limited (#948,
5/hour). This adds the durable audit recommendation: every export writes a
queryable `workspace_export_audit` row reviewable via an admin endpoint.

Run: cd apps/api && python -m pytest tests/test_925_export_audit.py -q
"""
from __future__ import annotations

import importlib
import sys
import textwrap
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-925"


def _yml(name: str) -> str:
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{name}"
        name: "{name}"
        title: t
        description: d
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        """
    ).strip() + "\n"


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    d = workers_dir / "alpha"
    d.mkdir(parents=True)
    (d / "worker.yml").write_text(_yml("alpha"), encoding="utf-8")
    (d / "run.py").write_text("print('x')\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    # rate-limit middleware is a no-op without a secret; secret is set above, so
    # avoid tripping the 5/hour export cap across tests by raising the dev flag off
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler", "main"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    yield TestClient(main.app, headers={"x-floom-secret": SECRET}), main
    db.get_repositories.cache_clear()


def test_migration_79_table_exists(client):
    _c, main = client
    with main.get_db() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(workspace_export_audit)").fetchall()}
    assert {"id", "user_id", "role", "exported_at"} <= cols


def test_export_writes_an_audit_row(client):
    c, main = client
    resp = c.get("/workspace/export")
    assert resp.status_code == 200, resp.text
    with main.get_db() as conn:
        rows = conn.execute("SELECT user_id, role FROM workspace_export_audit").fetchall()
    assert len(rows) == 1
    assert rows[0]["user_id"]


def test_audit_endpoint_lists_exports(client):
    c, _ = client
    c.get("/workspace/export")
    resp = c.get("/workspace/export/audit")
    assert resp.status_code == 200, resp.text
    trail = resp.json()
    assert len(trail) >= 1
    assert "exported_at" in trail[0] and "user_id" in trail[0]


def test_export_is_admin_only(client):
    # member (shared-secret demoted to member) cannot export — #925 core guard
    c, main = client
    import os

    os.environ["WORKEROS_SHARED_SECRET_ROLE"] = "member"
    try:
        resp = c.get("/workspace/export")
        assert resp.status_code == 403, resp.text
        resp2 = c.get("/workspace/export/audit")
        assert resp2.status_code == 403
    finally:
        os.environ.pop("WORKEROS_SHARED_SECRET_ROLE", None)
