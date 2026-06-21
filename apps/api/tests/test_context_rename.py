"""#1813 — folder/brain-pack rename endpoint.

PR #1811 made folder creation auto-name (no blocking prompt) so the user can
"just choose one, I can change it later". Contexts had create + delete but no
rename, so auto-named folders were stuck. POST /contexts/{name}/rename closes
that loop: it moves the directory, carries metadata (writeable, sensitive,
category, per-file tags) + visibility, and refuses to clobber or to silently
break workers that mount the pack.

Run: cd apps/api && python -m pytest tests/test_context_rename.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-ctxrename"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for name in list(sys.modules):
        if name in ("main", "db", "contexts") or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("routers") or name.startswith("services"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    # non-sensitive (git-tracked), writeable, with a content-category tag
    assert c.post("/contexts/facts", json={"writeable": True, "sensitive": False, "category": "research"}).status_code in (200, 201)
    c.put("/contexts/facts/files/top.md", json={"content": "top level"})
    c.put("/contexts/facts/files/reports/q1.md", json={"content": "q1 report"})
    yield c
    db.get_repositories.cache_clear()


def _names(resp):
    assert resp.status_code == 200, resp.text
    return {f["path"] for f in resp.json()["files"]}


def test_rename_moves_folder_and_preserves_state(client):
    resp = client.post("/contexts/facts/rename", json={"new_name": "company-facts"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "company-facts"
    # metadata carried across the rename
    assert body["writeable"] is True
    assert body["sensitive"] is False
    assert body["category"] == "research"

    # old name is gone, new name has every file with content preserved
    assert client.get("/contexts/facts").status_code == 404
    assert _names(client.get("/contexts/company-facts")) == {"top.md", "reports/q1.md"}
    got = client.get("/contexts/company-facts/files/reports/q1.md")
    assert got.status_code == 200, got.text
    assert "q1 report" in got.text

    # list reflects the rename
    listed = {c["name"] for c in client.get("/contexts").json()}
    assert "company-facts" in listed
    assert "facts" not in listed


def test_rename_preserves_visibility(client):
    assert client.put("/contexts/facts/visibility", json={"visibility": "workspace"}).status_code == 200
    assert client.get("/contexts/facts").json()["visibility"] == "workspace"

    resp = client.post("/contexts/facts/rename", json={"new_name": "shared-facts"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["visibility"] == "workspace"
    assert client.get("/contexts/shared-facts").json()["visibility"] == "workspace"


def test_rename_into_stale_shared_id_does_not_leak_private(client):
    """#1813 P1: a private folder renamed onto a pack id whose brain_packs row
    was left "workspace" by a previously renamed shared folder must NOT inherit
    that stale shared visibility.

    `ensure_brain_pack` never downgrades an existing row's visibility, so the
    rename path must rewrite the destination visibility to the source value for
    every case — including private — or it silently exposes the folder.
    """
    # 1) Make `facts` shared, then rename it away. That leaves a stale
    #    brain_packs row keyed `facts` with visibility=workspace (the rename
    #    materializes a row for the NEW name and never clears the old id).
    assert client.put("/contexts/facts/visibility", json={"visibility": "workspace"}).status_code == 200
    assert client.post("/contexts/facts/rename", json={"new_name": "moved-away"}).status_code == 200

    # 2) A fresh, private folder.
    assert client.post("/contexts/draft", json={"writeable": True, "sensitive": False}).status_code in (200, 201)
    assert client.get("/contexts/draft").json()["visibility"] == "private"

    # 3) Rename it onto the now-free `facts` id (which still has the stale
    #    workspace row). It MUST stay private.
    resp = client.post("/contexts/draft/rename", json={"new_name": "facts"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["visibility"] == "private"
    assert client.get("/contexts/facts").json()["visibility"] == "private"


def test_rename_does_not_leave_stale_shared_row_at_old_name(client):
    """#1813 P1: renaming a SHARED pack must not leave its `brain_packs` row
    stranded at the old id. A new folder later created with the old name would
    otherwise inherit the stale `workspace` visibility (`ensure_brain_pack`
    never downgrades), silently sharing a private folder.
    """
    # Share `facts`, then rename it away.
    assert client.put("/contexts/facts/visibility", json={"visibility": "workspace"}).status_code == 200
    assert client.post("/contexts/facts/rename", json={"new_name": "renamed-shared"}).status_code == 200
    assert client.get("/contexts/renamed-shared").json()["visibility"] == "workspace"

    # CREATE a brand-new folder reusing the freed `facts` id. It must be private,
    # not silently workspace-shared by the row the rename left behind.
    assert client.post("/contexts/facts", json={"writeable": True, "sensitive": False}).status_code in (200, 201)
    assert client.get("/contexts/facts").json()["visibility"] == "private"


def test_rename_blocks_on_other_owner_worker_in_workspace(client):
    """#1813 P2: the worker-reference scan must cover the whole workspace, not
    just the caller's own workers. A worker owned by a different user but mounting
    the pack must still block the rename (else the admin breaks it silently).
    """
    import db as db_mod

    # Insert a worker owned by ANOTHER user in the same (default) workspace that
    # mounts `facts`. The caller's owner-scoped list would never see it.
    repos = db_mod.get_repositories()
    repos.workers.create(
        user_id="someone-else",
        worker_id="w-other",
        name="other-worker",
        manifest_json={
            "schema_version": "0.3",
            "name": "other-worker",
            "title": "Other",
            "description": "mounts facts",
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "exec": {"entry": "run.py", "runtime": "python311", "runner": "e2b", "command": "python run.py"},
            "inputs": [],
            "connections": [],
            "contexts": ["facts"],
        },
    )
    resp = client.post("/contexts/facts/rename", json={"new_name": "renamed-facts"})
    assert resp.status_code == 409, resp.text
    assert "w-other" in resp.json()["detail"]["referenced_by"]
    # rename did not happen
    assert client.get("/contexts/facts").status_code == 200
    assert client.get("/contexts/renamed-facts").status_code == 404


def test_rename_to_existing_name_conflicts(client):
    assert client.post("/contexts/other", json={"writeable": True}).status_code in (200, 201)
    resp = client.post("/contexts/facts/rename", json={"new_name": "other"})
    assert resp.status_code == 409


def test_rename_to_same_name_rejected(client):
    resp = client.post("/contexts/facts/rename", json={"new_name": "facts"})
    assert resp.status_code == 400


def test_rename_invalid_name_rejected(client):
    resp = client.post("/contexts/facts/rename", json={"new_name": "bad name!"})
    assert resp.status_code == 400
    # original is untouched
    assert client.get("/contexts/facts").status_code == 200


def test_rename_missing_source_404(client):
    resp = client.post("/contexts/nope/rename", json={"new_name": "anything"})
    assert resp.status_code == 404


def test_rename_blocked_when_referenced_by_workers(client, monkeypatch):
    import routers.contexts as contexts_router

    monkeypatch.setattr(
        contexts_router, "_workers_referencing_context", lambda *a, **k: ["worker-a"]
    )
    resp = client.post("/contexts/facts/rename", json={"new_name": "renamed-facts"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["referenced_by"] == ["worker-a"]
    # the rename did not happen
    assert client.get("/contexts/facts").status_code == 200
    assert client.get("/contexts/renamed-facts").status_code == 404
