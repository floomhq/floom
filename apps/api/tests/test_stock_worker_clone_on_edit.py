"""Tests for stock-worker write protection + add-tool-when-none + two-way YAML sync.

Covers the X5/X6 fixes:

  X5 — Editing a read-only stock worker (PROTECTED_STOCK_WORKER_IDS) via
       PUT /workers/{id} or PUT /workers/{id}/files is rejected. Stock templates
       are shared, git-tracked bundles and direct edit routes must not mutate or
       implicitly fork them.

  X6 — Adding a tool/connection to a worker that declares `connections: []`
       writes a new connections entry to worker.yml. And the UI<->YAML round trip
       is two-way: an edit through PUT /files is reflected on the next GET (the
       editor re-reads worker.yml after save).

These are integration tests that boot the full FastAPI app (SQLite-backed) and
run on Linux/CI only (the db layer uses fcntl).
"""

from __future__ import annotations

import platform
import sys
from pathlib import Path

import pytest
import yaml as pyyaml

_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

HEADERS = {"x-floom-secret": "test-secret"}

# A worker whose id is in PROTECTED_STOCK_WORKER_IDS (read-only stock template).
_STOCK_ID = "github-digest"
_STOCK_WORKER_YML = """\
schema_version: "0.3"
name: "github-digest"
title: "GitHub Digest"
description: "Stock GitHub digest worker."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
"""

# An UNDERSCORE-named stock worker (in PROTECTED_STOCK_WORKER_IDS). Its clone id
# is `<id>-copy` = `weekly_update-copy`, which is NOT a valid SLUG_PATTERN id
# (underscores forbidden) — the clone must slugify the base to `weekly-update`.
# Carries `is_example: true` so the test can assert the copy clears it to false.
_USCORE_STOCK_ID = "weekly_update"
_USCORE_STOCK_WORKER_YML = """\
schema_version: "0.3"
name: "weekly_update"
is_example: true
title: "Weekly Update"
description: "Stock weekly update worker."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
"""

# A normal (non-stock) worker that declares NO connections.
_PLAIN_ID = "plain-no-conns"
_PLAIN_WORKER_YML = """\
schema_version: "0.3"
name: "plain-no-conns"
title: "Plain Worker"
description: "Worker that declares no connections."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
connections: []
"""

_RUN_PY = 'print("hello")\n'


@_LINUX_ONLY
class TestStockWorkerWriteProtection:
    @pytest.fixture(autouse=True)
    def _clear_caches(self):
        import db.factory as factory_mod
        if hasattr(factory_mod.get_repositories, "cache_clear"):
            factory_mod.get_repositories.cache_clear()
        yield
        if hasattr(factory_mod.get_repositories, "cache_clear"):
            factory_mod.get_repositories.cache_clear()

    @pytest.fixture
    def client(self, tmp_path):
        """Boot the app with a temp workers dir holding a stock + a plain worker."""
        from fastapi.testclient import TestClient

        workers_dir = tmp_path / "workers"
        workers_dir.mkdir()

        stock_dir = workers_dir / _STOCK_ID
        stock_dir.mkdir()
        (stock_dir / "worker.yml").write_text(_STOCK_WORKER_YML)
        (stock_dir / "run.py").write_text(_RUN_PY)

        uscore_dir = workers_dir / _USCORE_STOCK_ID
        uscore_dir.mkdir()
        (uscore_dir / "worker.yml").write_text(_USCORE_STOCK_WORKER_YML)
        (uscore_dir / "run.py").write_text(_RUN_PY)

        plain_dir = workers_dir / _PLAIN_ID
        plain_dir.mkdir()
        (plain_dir / "worker.yml").write_text(_PLAIN_WORKER_YML)
        (plain_dir / "run.py").write_text(_RUN_PY)

        contexts_dir = tmp_path / "contexts"
        contexts_dir.mkdir()

        env_patches = {
            "FLOOM_WORKERS_DIR": str(workers_dir),
            "FLOOM_CONTEXTS_DIR": str(contexts_dir),
            "WORKEROS_DB": str(tmp_path / "workeros.db"),
            "FLOOM_DB": str(tmp_path / "workeros.db"),
            "WORKEROS_DEPLOY": "local",
            "FLOOM_SECRET": "test-secret",
        }
        with pytest.MonkeyPatch().context() as mp:
            for k, v in env_patches.items():
                mp.setenv(k, v)

            for mod in [
                "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                "db.interface", "models", "worker_registry", "runner_utils",
                "run_service", "main",
            ]:
                sys.modules.pop(mod, None)

            import db as db_mod
            db_mod.init_db()
            db_mod.get_repositories.cache_clear()

            import main as app_main
            app = app_main.app
            client = TestClient(app, raise_server_exceptions=False)
            yield client, workers_dir

    # ----- X5: direct stock edits are blocked -------------------------------

    def test_attach_brain_to_stock_worker_is_blocked(self, client):
        c, workers_dir = client
        # The brain pack must exist before a worker can reference it.
        assert c.post("/contexts/my-brain-pack", headers=HEADERS).status_code in (200, 201, 409)
        stock_yml = (workers_dir / _STOCK_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(stock_yml)
        edited["contexts"] = ["my-brain-pack"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)

        r = c.put(
            f"/workers/{_STOCK_ID}/files",
            json={"files": [
                {"path": "worker.yml", "content": edited_yml},
                {"path": "run.py", "content": _RUN_PY},
            ]},
            headers=HEADERS,
        )
        assert r.status_code == 403, r.text
        assert r.json() == {"detail": "Stock workers cannot be modified through the API"}

        stock_after = pyyaml.safe_load((workers_dir / _STOCK_ID / "worker.yml").read_text())
        assert "contexts" not in stock_after
        assert stock_after["name"] == _STOCK_ID

    def test_put_stock_worker_is_blocked(self, client):
        c, workers_dir = client
        stock_yml = (workers_dir / _STOCK_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(stock_yml)
        edited["connections"] = ["gmail"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)

        r = c.put(
            f"/workers/{_STOCK_ID}",
            json={"worker_yml": edited_yml, "run_py": _RUN_PY},
            headers=HEADERS,
        )
        assert r.status_code == 403, r.text
        assert r.json() == {"detail": "Stock workers cannot be modified through the API"}

        stock_after = pyyaml.safe_load((workers_dir / _STOCK_ID / "worker.yml").read_text())
        assert "connections" not in stock_after

    # ----- Explicit create/fork keeps underscore stock ids safe -------------

    def test_create_from_underscore_stock_worker_slugifies_copy_id(self, client):
        c, workers_dir = client
        assert c.post("/contexts/my-brain-pack", headers=HEADERS).status_code in (200, 201, 409)

        stock_yml = (workers_dir / _USCORE_STOCK_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(stock_yml)
        edited["contexts"] = ["my-brain-pack"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)

        r = c.post(
            "/workers",
            json={"worker_yml": edited_yml, "run_py": _RUN_PY},
            headers=HEADERS,
        )
        assert r.status_code == 200, r.text
        body = r.json()

        assert body["id"] == "weekly-update-copy"
        assert "_" not in body["id"]

        # The copy is a real owned worker, not a stock example.
        copy_dir = workers_dir / body["id"]
        assert copy_dir.is_dir()
        copy_cfg = pyyaml.safe_load((copy_dir / "worker.yml").read_text())
        assert copy_cfg.get("is_example") is False
        assert copy_cfg.get("contexts") == ["my-brain-pack"]

        # The stock template on disk is UNCHANGED (still its example flag + id).
        stock_after = pyyaml.safe_load(
            (workers_dir / _USCORE_STOCK_ID / "worker.yml").read_text()
        )
        assert stock_after.get("is_example") is True
        assert "contexts" not in stock_after

    def test_underscore_stock_create_copy_collision_appends_suffix(self, client):
        """A second explicit copy of the same underscore stock worker gets a `-2` suffix."""
        c, workers_dir = client
        assert c.post("/contexts/my-brain-pack", headers=HEADERS).status_code in (200, 201, 409)

        stock_yml = (workers_dir / _USCORE_STOCK_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(stock_yml)
        edited["contexts"] = ["my-brain-pack"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)
        payload = {"worker_yml": edited_yml, "run_py": _RUN_PY}

        first = c.post("/workers", json=payload, headers=HEADERS)
        assert first.status_code == 200, first.text
        assert first.json()["id"] == "weekly-update-copy"

        second = c.post("/workers", json=payload, headers=HEADERS)
        assert second.status_code == 200, second.text
        assert second.json()["id"] == "weekly-update-copy-2"

    # ----- X6: add tool when none declared + two-way sync --------------------

    def test_add_connection_when_none_declared_writes_entry(self, client):
        c, workers_dir = client
        # Plain worker declares connections: [] — adding a tool must write it.
        plain_yml = (workers_dir / _PLAIN_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(plain_yml)
        edited["connections"] = ["slack"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)

        r = c.put(
            f"/workers/{_PLAIN_ID}/files",
            json={"files": [
                {"path": "worker.yml", "content": edited_yml},
                {"path": "run.py", "content": _RUN_PY},
            ]},
            headers=HEADERS,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Plain worker is NOT stock — edits in place, no fork.
        assert body.get("cloned_from") is None
        assert body["id"] == _PLAIN_ID

        # connections entry written to worker.yml on disk.
        disk_cfg = pyyaml.safe_load((workers_dir / _PLAIN_ID / "worker.yml").read_text())
        assert "slack" in [
            (c if isinstance(c, str) else (c.get("app") or c.get("composio", {}).get("app")))
            for c in (disk_cfg.get("connections") or [])
        ]

    def test_two_way_sync_ui_edit_reflected_on_get(self, client):
        c, workers_dir = client
        # UI edit (PUT /files) -> next GET reflects the connection.
        plain_yml = (workers_dir / _PLAIN_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(plain_yml)
        edited["connections"] = ["github"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)

        put = c.put(
            f"/workers/{_PLAIN_ID}/files",
            json={"files": [
                {"path": "worker.yml", "content": edited_yml},
                {"path": "run.py", "content": _RUN_PY},
            ]},
            headers=HEADERS,
        )
        assert put.status_code == 200, put.text

        got = c.get(f"/workers/{_PLAIN_ID}", headers=HEADERS)
        assert got.status_code == 200, got.text
        detail = got.json()
        conn_apps = [
            (x if isinstance(x, str) else (x.get("app") or x.get("composio", {}).get("app")))
            for x in (detail["config"].get("connections") or [])
        ]
        assert "github" in conn_apps

    def test_two_way_sync_yaml_edit_reflected_on_get(self, client):
        c, workers_dir = client
        # YAML edit (Source tab) writes a contexts block -> GET reflects it.
        assert c.post("/contexts/docs-pack", headers=HEADERS).status_code in (200, 201, 409)
        plain_yml = (workers_dir / _PLAIN_ID / "worker.yml").read_text()
        edited = pyyaml.safe_load(plain_yml)
        edited["contexts"] = ["docs-pack"]
        edited_yml = pyyaml.safe_dump(edited, sort_keys=False)

        put = c.put(
            f"/workers/{_PLAIN_ID}/files",
            json={"files": [
                {"path": "worker.yml", "content": edited_yml},
                {"path": "run.py", "content": _RUN_PY},
            ]},
            headers=HEADERS,
        )
        assert put.status_code == 200, put.text

        got = c.get(f"/workers/{_PLAIN_ID}", headers=HEADERS)
        assert got.status_code == 200, got.text
        detail = got.json()
        # The raw worker.yml surfaced by the detail reflects the YAML edit, so the
        # Brain/Tools UI (which reads config.contexts) sees it on re-read.
        ctx = [
            (x if isinstance(x, str) else x.get("name"))
            for x in (detail["config"].get("contexts") or [])
        ]
        assert "docs-pack" in ctx
