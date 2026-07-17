"""#2270 — one worker count, three surfaces.

``workers_list`` (MCP -> ``list_workers`` -> GET /workers), ``system_stats``
(MCP -> GET /stats ``total_workers``), and Emily's ``workers__list_all`` chat
tool historically read three different queries with three different filters:

  - GET /workers:   _list_visible_workers + system/archived filter
  - GET /stats:     bare repos.workers.list(user_id) (owner-only, counted
                    hidden internal workers, missed stock/shared/granted ones)
  - Emily:          repos.workers.list_for_agent (DB rows only, broader
                    visibility tiers, its own stock/system hiding — missed
                    on-disk stock workers the grid shows)

Live result: workers_list said 13, system_stats said 8, Emily told the user
"you have 8 workers" and was missing 4 real workers. All three now route
through ``services.worker_access.list_operator_workers`` (the single source of
truth) and MUST agree — including on a workspace fixture that mixes plain
workers, a draft-stage worker, a manifest ``system_worker``, an archived
worker, and an internal engine worker id.

Run:
    cd apps/api && python -m pytest tests/test_2270_worker_count_consistency.py -v
"""

from __future__ import annotations

import importlib
import json
import platform
import sqlite3
import sys
from pathlib import Path

import pytest

_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_WORKER_YML = """\
schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "Count-consistency fixture worker."
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

_SECRET = "test-secret-2270"
_USER_ID = "local-user"
_NOW = "2026-01-01T00:00:00Z"


def _insert_db_worker(db_path: Path, worker_id: str, manifest: dict) -> None:
    """Insert a DB-only worker row (real schema) owned by the fixture user."""
    c = sqlite3.connect(db_path)
    sv_id = f"sv-{worker_id}"
    c.execute(
        "INSERT INTO skill_versions (id,name,version,manifest_json,bundle_path,created_at) "
        "VALUES (?,?,?,?,?,?)",
        (sv_id, worker_id, "1.0", json.dumps(manifest), "/x", _NOW),
    )
    c.execute(
        "INSERT INTO workers (id,skill_version_id,name,trigger_type,enabled,"
        "owner_id,workspace_id,visibility,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (worker_id, sv_id, worker_id, "manual", 1, _USER_ID, "local-default", "private", _NOW),
    )
    c.commit()
    c.close()


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Full FastAPI app on an isolated SQLite DB + isolated workers dir."""
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    for name, title in (("alpha-digest", "Alpha Digest"), ("beta-digest", "Beta Digest")):
        wdir = workers_dir / name
        wdir.mkdir()
        (wdir / "worker.yml").write_text(
            _WORKER_YML.format(name=name, title=title), encoding="utf-8"
        )
        (wdir / "run.py").write_text("print('ok')\n", encoding="utf-8")

    db_path = tmp_path / "floom.db"
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "chat_service", "main",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=_USER_ID)

    # DB-only rows: a draft-stage worker (counts like any worker), a manifest
    # system worker + an archived worker (both hidden-but-footnoted), and an
    # internal engine worker id (never part of the operator's set at all).
    _insert_db_worker(db_path, "draft-notes", {"title": "Draft Notes", "stage": "draft"})
    _insert_db_worker(db_path, "sys-maintenance", {"title": "Sys", "system_worker": True})
    _insert_db_worker(db_path, "old-archived", {"title": "Old", "archived": True})
    _insert_db_worker(db_path, "workspace-agent", {"title": "Engine internal"})

    chat_service = importlib.import_module("chat_service")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    yield {"client": client, "chat_service": chat_service}
    db.get_repositories.cache_clear()


_EXPECTED_VISIBLE = {"alpha-digest", "beta-digest", "draft-notes"}
_EXPECTED_HIDDEN = 2  # sys-maintenance (system_worker) + old-archived (archived)


@_LINUX_ONLY
class TestWorkerCountSingleSourceOfTruth:
    def test_three_surfaces_agree_on_default_count(self, env):
        client, cs = env["client"], env["chat_service"]

        # Surface 1 — GET /workers (dashboard grid; the MCP workers_list
        # handler calls this exact route function, main._mcp_call_workers_list).
        grid = client.get("/workers").json()
        grid_ids = {w["id"] for w in grid}

        # Surface 2 — GET /stats (the MCP system.stats handler proxies here).
        stats = client.get("/stats").json()

        # Surface 3 — Emily's workers__list_all chat tool.
        emily = cs._tool_workers_list_all({}, _USER_ID)
        emily_ids = {w["id"] for w in emily["workers"]}

        assert grid_ids == _EXPECTED_VISIBLE, grid_ids
        assert emily_ids == grid_ids, (
            f"split-brain: Emily {sorted(emily_ids)} != grid {sorted(grid_ids)}"
        )
        assert len(grid) == stats["total_workers"] == emily["count"] == len(_EXPECTED_VISIBLE), (
            f"counts diverged: grid={len(grid)} stats={stats['total_workers']} "
            f"emily={emily['count']}"
        )

    def test_hidden_accounting_agrees(self, env):
        client, cs = env["client"], env["chat_service"]

        stats = client.get("/stats").json()
        emily = cs._tool_workers_list_all({}, _USER_ID)

        # The system/archived exclusions are footnoted identically everywhere;
        # the internal engine worker (workspace-agent) is not the operator's
        # worker on ANY surface and is not footnoted.
        assert stats["hidden_system_workers"] == _EXPECTED_HIDDEN
        assert emily.get("hidden_system_count", 0) == _EXPECTED_HIDDEN

        grid_default = client.get("/workers").json()
        grid_all = client.get(
            "/workers", params={"include_system": "true", "include_archived": "true"}
        ).json()
        assert len(grid_all) - len(grid_default) == _EXPECTED_HIDDEN

    def test_include_system_parity(self, env):
        client, cs = env["client"], env["chat_service"]

        grid_all = client.get(
            "/workers", params={"include_system": "true", "include_archived": "true"}
        ).json()
        grid_all_ids = {w["id"] for w in grid_all}

        emily_all = cs._tool_workers_list_all({"include_system": True}, _USER_ID)
        emily_all_ids = {w["id"] for w in emily_all["workers"]}

        assert emily_all_ids == grid_all_ids, (
            f"include_system split-brain: Emily {sorted(emily_all_ids)} != "
            f"grid {sorted(grid_all_ids)}"
        )
        assert "workspace-agent" not in grid_all_ids  # engine-internal everywhere
        assert emily_all["count"] == len(grid_all)
        assert "hidden_system_count" not in emily_all
