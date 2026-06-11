"""#783 + #770 — brain subfolder filtering and file move/rename.

#783: GET /contexts/{name}?path_prefix=reports narrows the (flat) file list
to one subfolder for nested-folder navigation.
#770: POST /contexts/{name}/files/{old}/move renames within a context
(preserving history) instead of DELETE + PUT which loses version history.

Run: cd apps/api && python -m pytest tests/test_context_subfolder_and_move.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-ctxmove"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for name in list(sys.modules):
        if name in ("main", "db", "contexts") or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    # create a non-sensitive pack so writes are allowed + git-tracked
    assert c.post("/contexts/facts", json={"writeable": True, "sensitive": False}).status_code in (200, 201)
    # seed files: root + a reports/ subfolder
    c.put("/contexts/facts/files/top.md", json={"content": "top level"})
    c.put("/contexts/facts/files/reports/q1.md", json={"content": "q1 report"})
    c.put("/contexts/facts/files/reports/q2.md", json={"content": "q2 report"})
    yield c
    db.get_repositories.cache_clear()


def _paths(resp):
    assert resp.status_code == 200, resp.text
    return {f["path"] for f in resp.json()["files"]}


def test_path_prefix_filters_to_subfolder(client):
    all_paths = _paths(client.get("/contexts/facts"))
    assert {"top.md", "reports/q1.md", "reports/q2.md"} <= all_paths

    sub = _paths(client.get("/contexts/facts?path_prefix=reports"))
    assert sub == {"reports/q1.md", "reports/q2.md"}
    assert "top.md" not in sub


def test_path_prefix_empty_is_noop(client):
    assert "top.md" in _paths(client.get("/contexts/facts?path_prefix="))


def test_move_file_within_context(client):
    resp = client.post(
        "/contexts/facts/files/reports/q1.md/move",
        json={"new_path": "archive/2026-q1.md"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["path"] == "archive/2026-q1.md"

    paths = _paths(client.get("/contexts/facts"))
    assert "archive/2026-q1.md" in paths
    assert "reports/q1.md" not in paths
    # content preserved
    got = client.get("/contexts/facts/files/archive/2026-q1.md")
    assert got.status_code == 200, got.text


def test_move_to_existing_path_conflicts(client):
    resp = client.post(
        "/contexts/facts/files/reports/q1.md/move",
        json={"new_path": "reports/q2.md"},
    )
    assert resp.status_code == 409


def test_move_missing_source_404(client):
    resp = client.post(
        "/contexts/facts/files/reports/nope.md/move",
        json={"new_path": "reports/x.md"},
    )
    assert resp.status_code == 404
