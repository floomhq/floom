"""#732 — brain folders are flat: pin the decided contract (option 1).

Decision: contexts (Brain folders) do NOT nest. "Nesting" is modeled as file
sub-paths inside one context, rendered as a path tree by the UI (#783
path_prefix + #770 move). This pins both halves:
  - context names with "/" are rejected (no folder-in-folder)
  - multi-level file sub-paths round-trip inside a single context

Run: cd apps/api && python -m pytest tests/test_brain_flat_contract_732.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-732"


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
    yield c
    db.get_repositories.cache_clear()


def test_context_name_with_slash_is_rejected():
    from contexts import validate_context_name
    for bad in ("a/b", "parent/child", "/abs", "a/"):
        with pytest.raises(ValueError):
            validate_context_name(bad)


def test_create_nested_context_via_api_fails(client):
    # encoded slash must not create a folder-in-folder
    resp = client.post("/contexts/parent%2Fchild", json={"writeable": True, "sensitive": False})
    assert resp.status_code >= 400, resp.text
    names = {c["name"] for c in client.get("/contexts").json()}
    assert "parent/child" not in names
    assert "parent" not in names


def test_multi_level_file_subpaths_round_trip(client):
    assert client.post("/contexts/flatpack", json={"writeable": True, "sensitive": False}).status_code in (200, 201)
    deep = "reports/2026/q2/summary.md"
    put = client.put(f"/contexts/flatpack/files/{deep}", json={"content": "deep file"})
    assert put.status_code == 200, put.text
    assert put.json()["path"] == deep

    detail = client.get("/contexts/flatpack")
    assert detail.status_code == 200, detail.text
    assert deep in {f["path"] for f in detail.json()["files"]}

    sub = client.get("/contexts/flatpack?path_prefix=reports/2026")
    assert sub.status_code == 200, sub.text
    assert {f["path"] for f in sub.json()["files"]} == {deep}

    got = client.get(f"/contexts/flatpack/files/{deep}")
    assert got.status_code == 200
    assert got.text == "deep file"
