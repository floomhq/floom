"""#1078 — pin the context version-history contract.

Empirically (this test): the versioning/rollback machinery records git history
correctly for a NON-sensitive writeable context, and intentionally records
NOTHING for a sensitive context (the create default), because sensitive packs
"never enter git" — they may hold credentials. The cloud #272 repro saw empty
versions because the pack was sensitive-by-default (and/or the cloud git
workspace is ephemeral), not because recording is broken. Whether a writeable
pack should default to non-sensitive (and thus be versioned) is a product call,
tracked on the issue — not a code bug here.
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


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-1078")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("WORKEROS_ROOT", str(tmp_path))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(ws))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(ws / "contexts"))
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith(("routers", "services"))]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-1078"}) as c:
        yield c
    db.get_repositories.cache_clear()


def _write(client, name, content):
    return client.put(
        f"/contexts/{name}/files/notes.md",
        headers={"content-type": "application/json"},
        json={"content": content},
    )


def test_nonsensitive_context_records_versions(client):
    r = client.post("/contexts/probe-vers", json={"writeable": True, "sensitive": False})
    assert r.status_code in (200, 201), r.text
    assert _write(client, "probe-vers", "v1\n").status_code == 200
    assert _write(client, "probe-vers", "v2\n").status_code == 200

    versions = client.get("/contexts/probe-vers/files/notes.md/versions")
    assert versions.status_code == 200, versions.text
    print("NONSENSITIVE versions:", versions.json())
    assert len(versions.json()) >= 2, versions.json()


def test_sensitive_default_context_has_no_versions(client):
    r = client.post("/contexts/probe-sens", json={"writeable": True})  # sensitive defaults True
    assert r.status_code in (200, 201), r.text
    assert _write(client, "probe-sens", "s1\n").status_code == 200
    assert _write(client, "probe-sens", "s2\n").status_code == 200

    versions = client.get("/contexts/probe-sens/files/notes.md/versions")
    assert versions.status_code == 200, versions.text
    # By design: sensitive contexts never enter git, so no version history.
    assert versions.json() == [], versions.json()
