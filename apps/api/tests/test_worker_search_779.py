"""#779 — GET /workers?q= filters server-side by name/description/tags."""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "search-secret-779"


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
  runner: "local"
  command: "python run.py"
inputs: []
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    specs = {
        "sales-summary": _yml("sales-summary", "Sales Summary", "Summarises weekly sales numbers"),
        "invoice-bot": _yml("invoice-bot", "Invoice Bot", "Generates customer invoices"),
        "standup-notes": _yml("standup-notes", "Standup Notes", "Collects daily standup updates"),
    }
    for wid, yml in specs.items():
        d = workers_dir / wid
        d.mkdir(parents=True)
        (d / "worker.yml").write_text(yml, encoding="utf-8")
        (d / "run.py").write_text("print('x')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler", "main"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")
    from fastapi.testclient import TestClient
    yield TestClient(main.app, headers={"x-floom-secret": _SECRET})
    db.get_repositories.cache_clear()


def _ids(resp):
    assert resp.status_code == 200, resp.text
    return {w["id"] for w in resp.json()}


def test_search_matches_name_and_description(client):
    assert _ids(client.get("/workers?shape=list&q=sales")) == {"sales-summary"}
    assert _ids(client.get("/workers?shape=list&q=invoice")) == {"invoice-bot"}
    # Description-only hit.
    assert _ids(client.get("/workers?shape=list&q=standup")) == {"standup-notes"}


def test_search_is_case_insensitive(client):
    assert _ids(client.get("/workers?shape=list&q=INVOICE")) == {"invoice-bot"}


def test_empty_query_returns_all_and_no_match_returns_none(client):
    assert _ids(client.get("/workers?shape=list")) == {"sales-summary", "invoice-bot", "standup-notes"}
    assert _ids(client.get("/workers?shape=list&q=nonexistentxyz")) == set()
