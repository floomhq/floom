"""#979 — GET /workers/{id}/versions must be side-effect free.

The old route committed a baseline when history was empty, so a read (browser
prefetch, crawler) mutated server-side git state and could snapshot a
wrongly-visible private worker. The GET must never create a commit; an empty
history returns [].

Run: cd apps/api && python -m pytest tests/test_979_versions_read_only.py -q
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
def app_client(tmp_path, monkeypatch):
    if "fcntl" not in sys.modules:
        _fcntl = types.ModuleType("fcntl")
        for attr in ("LOCK_EX", "LOCK_SH", "LOCK_UN", "LOCK_NB"):
            setattr(_fcntl, attr, 0)
        _fcntl.flock = lambda fd, op: None
        sys.modules["fcntl"] = _fcntl

    import git_ops

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    workspace = tmp_path
    git_ops.ensure_repo(workspace)
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    # Modular refactor: reloading only `main` leaves routers/services/core (and
    # models) bound to whatever a prior test reloaded — a stale response_model
    # then 422s on a fresh model instance. Purge them so main's reload reimports
    # a consistent set (Lesson 10).
    for name in list(sys.modules):
        if name in ("models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts")):
            sys.modules.pop(name, None)

    import main as _main_mod

    importlib.reload(_main_mod)
    from fastapi.testclient import TestClient

    return TestClient(_main_mod.app, raise_server_exceptions=False), workspace, workers_dir, _main_mod


def _head_sha(workspace) -> str | None:
    import git_ops

    rows = git_ops.get_log(workspace, rel_path=".", limit=1)
    return rows[0]["sha"] if rows else None


def test_get_versions_with_empty_history_creates_no_commit(app_client, monkeypatch):
    client, workspace, workers_dir, main = app_client

    # a worker dir that was never committed (pre-existing, no version history)
    (workers_dir / "uncommitted").mkdir()
    (workers_dir / "uncommitted" / "worker.yml").write_text("id: uncommitted\nname: Uncommitted")

    # make it visible to the caller without going through create (which would
    # legitimately commit a baseline): stub the visibility check.
    monkeypatch.setattr(
        main, "_get_visible_worker", lambda worker_id, **kw: {"id": worker_id, "owner_id": "dev"}
    )
    # any baseline commit attempt during the GET is a bug — make it loud.
    monkeypatch.setattr(
        main,
        "_git_commit_worker",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("GET must not commit (#979)")),
    )

    before = _head_sha(workspace)
    resp = client.get("/workers/uncommitted/versions", headers={"x-floom-secret": "dev"})
    after = _head_sha(workspace)

    assert resp.status_code == 200, resp.text
    assert resp.json() == []  # empty history, not a freshly-minted baseline
    assert before == after, "GET /versions must not advance git HEAD"
