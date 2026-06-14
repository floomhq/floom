"""#1077 — robustness items fixable in the engine.

1. GET /workers now honors + validates limit/offset (consistent with /runs):
   bad values -> 422, valid values -> a sliced page; default (no limit) still
   returns all for CLI/MCP back-compat.
4. A NUL byte in a context file path (notes.md%00.png) now returns a clean 400
   instead of a raw OS "embedded null character in path" 500.

(Item 5 — retry-once on Supabase RemoteProtocolError churn — is cloud-repo
specific and not exercisable against the SQLite engine; see the issue comment.)
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


# --- item 4: null-byte path -> clean 400 (validator unit test) ---------------

def test_normalize_context_file_path_rejects_null_byte():
    from contexts import normalize_context_file_path

    with pytest.raises(ValueError):
        normalize_context_file_path("notes.md\x00.png")


def test_context_file_path_or_400_maps_null_byte_to_http_400():
    from fastapi import HTTPException
    from services.context_access import _context_file_path_or_400

    with pytest.raises(HTTPException) as exc:
        _context_file_path_or_400("notes.md\x00.png")
    assert exc.value.status_code == 400


def test_normalize_context_file_path_accepts_normal_path():
    from contexts import normalize_context_file_path

    assert normalize_context_file_path("notes.md") == "notes.md"
    assert normalize_context_file_path("sub/dir/notes.md") == "sub/dir/notes.md"


# --- item 1: /workers pagination validation + slicing (route test) -----------

def _worker_yml(name: str) -> str:
    return f"""\
schema_version: '0.3'
name: {name}
title: {name}
description: probe worker for #1077 pagination test.
version: 0.1.0
targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
trigger:
  type: manual
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    for name in ("probe-a", "probe-b", "probe-c"):
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(_worker_yml(name), encoding="utf-8")
        (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
        (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-1077")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="federico")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-1077"}) as c:
        yield c
    db.get_repositories.cache_clear()


def test_workers_default_returns_all(client):
    resp = client.get("/workers?shape=list")
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 3


def test_workers_limit_and_offset_are_honored(client):
    page1 = client.get("/workers?shape=list&limit=2&offset=0")
    page2 = client.get("/workers?shape=list&limit=2&offset=2")
    assert page1.status_code == 200 and page2.status_code == 200
    assert len(page1.json()) == 2
    assert len(page2.json()) == 1
    ids1 = {w["id"] for w in page1.json()}
    ids2 = {w["id"] for w in page2.json()}
    assert ids1.isdisjoint(ids2)


@pytest.mark.parametrize("qs", ["limit=0", "limit=-1", "limit=99999", "offset=-1"])
def test_workers_invalid_pagination_is_422(client, qs):
    resp = client.get(f"/workers?shape=list&{qs}")
    assert resp.status_code == 422, resp.text
