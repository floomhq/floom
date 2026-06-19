"""#771 + #779 — GET /workers visibility filter and ?q= server-side search.

#771: optional ?visibility=private|workspace|public|all filter shapes the
already-authorized list (no access-control change).
#779: optional ?q= substring filter on name+description (case-insensitive),
so large workspaces filter server-side instead of shipping the full list.

Run: cd apps/api && python -m pytest tests/test_workers_list_filters.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-listfilters"


def _yml(name: str, title: str, desc: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "{desc}"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    specs = [
        ("alpha-invoices", "Alpha Invoices", "Reconciles supplier invoices"),
        ("beta-newsletter", "Beta Newsletter", "Drafts the weekly newsletter"),
        ("gamma-invoice-audit", "Gamma Invoice Audit", "Audits invoice anomalies"),
    ]
    for name, title, desc in specs:
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(_yml(name, title, desc), encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main
    db.get_repositories.cache_clear()


def _ids(resp):
    assert resp.status_code == 200, resp.text
    return {w["id"] for w in resp.json()}


def test_q_filters_by_name_and_description(client_and_main):
    client, _ = client_and_main
    # "invoice" matches alpha (name) + gamma (name/desc), not beta
    ids = _ids(client.get("/workers?q=invoice"))
    assert ids == {"alpha-invoices", "gamma-invoice-audit"}


def test_q_is_case_insensitive_and_matches_description(client_and_main):
    client, _ = client_and_main
    ids = _ids(client.get("/workers?q=NEWSLETTER"))
    assert ids == {"beta-newsletter"}


def test_q_empty_returns_all(client_and_main):
    client, _ = client_and_main
    ids = _ids(client.get("/workers?q="))
    assert {"alpha-invoices", "beta-newsletter", "gamma-invoice-audit"} <= ids


def test_visibility_filter_private_default(client_and_main):
    client, _ = client_and_main
    # discovered workers default to private
    ids = _ids(client.get("/workers?visibility=private"))
    assert {"alpha-invoices", "beta-newsletter", "gamma-invoice-audit"} <= ids


def test_visibility_filter_workspace_excludes_private(client_and_main):
    client, main = client_and_main
    # promote one worker to workspace visibility directly in the DB
    with main.get_db() as conn:
        conn.execute("UPDATE workers SET visibility = 'workspace' WHERE id = ?", ("beta-newsletter",))
    ids = _ids(client.get("/workers?visibility=workspace"))
    assert ids == {"beta-newsletter"}
    private_ids = _ids(client.get("/workers?visibility=private"))
    assert "beta-newsletter" not in private_ids


def test_visibility_invalid_value_422(client_and_main):
    client, _ = client_and_main
    resp = client.get("/workers?visibility=bogus")
    assert resp.status_code == 422


def test_visibility_all_is_noop(client_and_main):
    client, _ = client_and_main
    ids = _ids(client.get("/workers?visibility=all"))
    assert {"alpha-invoices", "beta-newsletter", "gamma-invoice-audit"} <= ids
