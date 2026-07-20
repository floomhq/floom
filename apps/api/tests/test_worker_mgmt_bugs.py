from __future__ import annotations

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(name: str, *, title: str, trigger: str = "manual", default_channel: bool = False) -> str:
    default_line = '\n    default: "CDEFAULT123"' if default_channel else ""
    cron = '\n  cron: "*/5 * * * *"' if trigger == "schedule" else ""
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "{title}"
version: "0.1.0"
trigger:
  type: "{trigger}"{cron}
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "channel"
    kind: "scalar"
    type: "string"
    required: true
    label: "Channel"{default_line}
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


@pytest.fixture
def app_ctx(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    specs = {
        "sales-summary": _worker_yml("sales-summary", title="Sales Summary"),
        "scheduled-no-default": _worker_yml(
            "scheduled-no-default",
            title="Scheduled No Default",
            trigger="schedule",
        ),
        "scheduled-with-default": _worker_yml(
            "scheduled-with-default",
            title="Scheduled With Default",
            trigger="schedule",
            default_channel=True,
        ),
    }
    for worker_id, yml in specs.items():
        worker_dir = workers_dir / worker_id
        worker_dir.mkdir()
        (worker_dir / "worker.yml").write_text(yml, encoding="utf-8")
        (worker_dir / "run.py").write_text(
            "import json\nfrom pathlib import Path\n"
            "inputs=json.loads(Path('inputs.json').read_text())\n"
            "Path('summary.md').write_text(str(inputs))\n",
            encoding="utf-8",
        )

    db_path = tmp_path / "workeros.db"
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "worker-mgmt-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "auth",
        "auth.local",
        "worker_registry",
        "runner_utils",
        "run_service",
        "scheduler",
        "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(_rn, None)
    for _sn in [x for x in list(sys.modules) if x.startswith("services.")]:
        sys.modules.pop(_sn, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient

    client = TestClient(
        main.app,
        headers={"x-floom-secret": "worker-mgmt-secret", "x-floom-user": "local-user"},
    )
    yield client, main, importlib.import_module("scheduler")
    db.get_repositories.cache_clear()


def test_worker_routes_resolve_slug_equivalent_id(app_ctx):
    client, main, _scheduler = app_ctx

    listed = client.get("/workers?shape=list")
    assert listed.status_code == 200, listed.text
    listed_workers = {worker["id"]: worker for worker in listed.json()}
    assert "sales-summary" in listed_workers
    assert listed_workers["sales-summary"]["created_at"]
    assert "updated_at" in listed_workers["sales-summary"]

    detail = client.get("/workers/Sales_Summary")
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == "sales-summary"

    patched = client.patch("/workers/Sales_Summary", json={"input_values": {"channel": "C123"}})
    assert patched.status_code == 200, patched.text
    with main.get_db() as conn:
        row = conn.execute("SELECT input_values_json FROM workers WHERE id = 'sales-summary'").fetchone()
    assert json.loads(row["input_values_json"]) == {"channel": "C123"}

    shared = client.put("/workers/Sales_Summary/visibility", json={"visibility": "workspace"})
    assert shared.status_code == 200, shared.text
    assert shared.json()["visibility"] == "workspace"

    deleted = client.delete("/workers/Sales_Summary")
    assert deleted.status_code == 204, deleted.text
    assert client.get("/workers/sales-summary").status_code == 404


def test_worker_create_accepts_full_file_bundle(app_ctx):
    client, _main, _scheduler = app_ctx
    worker_yml = _worker_yml("bundle-worker", title="Bundle Worker")

    created = client.post(
        "/workers",
        json={
            "worker_yml": worker_yml,
            "files": [
                {"path": "worker.yml", "content": worker_yml},
                {"path": "run.py", "content": "from lib.helper import main\nmain()\n"},
                {"path": "lib/helper.py", "content": "def main(): pass\n"},
            ],
        },
    )

    assert created.status_code == 200, created.text
    body = created.json()
    assert body["id"] == "bundle-worker"
    file_paths = {item["path"] for item in body["files"]}
    assert "lib/helper.py" in file_paths


def test_worker_file_update_merges_and_preserves_omitted_files(app_ctx):
    client, main, _scheduler = app_ctx
    worker_dir = main.WORKERS_DIR / "sales-summary"
    requirements = worker_dir / "requirements.txt"
    requirements.write_text("httpx==0.28.1\n", encoding="utf-8")
    worker_yml = (worker_dir / "worker.yml").read_text(encoding="utf-8")

    response = client.put(
        "/workers/sales-summary/files",
        json={"files": [
            {"path": "worker.yml", "content": worker_yml},
            {"path": "run.py", "content": "print('changed')\n"},
        ]},
    )

    assert response.status_code == 200, response.text
    assert requirements.read_text(encoding="utf-8") == "httpx==0.28.1\n"


def test_worker_versions_returns_history_after_file_edit(app_ctx):
    client, main, _scheduler = app_ctx
    worker_dir = main.WORKERS_DIR / "sales-summary"
    worker_yml = (worker_dir / "worker.yml").read_text(encoding="utf-8")

    edited = client.put(
        "/workers/sales-summary/files",
        json={"files": [
            {"path": "worker.yml", "content": worker_yml},
            {"path": "run.py", "content": "print('versioned')\n"},
        ]},
    )
    versions = client.get("/workers/sales-summary/versions")

    assert edited.status_code == 200, edited.text
    assert versions.status_code == 200, versions.text
    assert len(versions.json()) >= 1
    assert versions.json()[0]["id"] != ""


def test_worker_pause_and_resume_toggle_enabled(app_ctx):
    client, _main, _scheduler = app_ctx

    paused = client.post("/workers/sales-summary/pause")
    resumed = client.post("/workers/sales-summary/resume")

    assert paused.status_code == 200, paused.text
    assert paused.json()["enabled"] is False
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["enabled"] is True


def test_worker_management_tools_are_exposed_on_all_mcp_surfaces(app_ctx):
    _client, main, _scheduler = app_ctx
    required = {"workers.delete", "workers.pause", "workers.resume", "workers.write_file", "workers.versions"}
    cloud = {tool["name"] for tool in main._MCP_DEFAULT_TOOLS}
    remote = {tool["name"] for tool in main._workeros_remote_mcp_tool_definitions()}
    server_source = (Path(__file__).parents[2] / "mcp" / "src" / "server.ts").read_text(encoding="utf-8")

    assert required <= cloud
    assert required <= remote
    assert all(f'"{name}"' in server_source for name in required - {"workers.pause", "workers.resume"})
    assert '`workers.${action}`' in server_source


def test_worker_create_rejects_oversized_json_file_bundle(app_ctx):
    client, _main, _scheduler = app_ctx
    worker_yml = _worker_yml("huge-json-bundle", title="Huge JSON Bundle")
    files = [{"path": "worker.yml", "content": worker_yml}]
    files.extend({"path": f"lib/file_{idx}.py", "content": ""} for idx in range(2000))

    created = client.post(
        "/workers",
        json={"worker_yml": worker_yml, "files": files},
    )

    assert created.status_code == 413, created.text
    assert "too many entries" in created.json()["detail"]


@pytest.mark.parametrize("bad_path", ["../evil.py", "/tmp/evil.py", "C:\\temp\\evil.py"])
def test_worker_create_rejects_json_file_path_escape(app_ctx, bad_path):
    client, _main, _scheduler = app_ctx
    worker_yml = _worker_yml("bad-path-worker", title="Bad Path Worker")

    created = client.post(
        "/workers",
        json={
            "worker_yml": worker_yml,
            "files": [
                {"path": "worker.yml", "content": worker_yml},
                {"path": "run.py", "content": "print('ok')\n"},
                {"path": bad_path, "content": "print('escape')\n"},
            ],
        },
    )

    assert created.status_code == 400, created.text
    assert "Invalid path" in created.json()["detail"]


def test_worker_clone_duplicates_full_bundle(app_ctx):
    client, _main, _scheduler = app_ctx

    cloned = client.post("/workers/sales-summary/clone")

    assert cloned.status_code == 200, cloned.text
    body = cloned.json()
    assert body["id"] == "sales-summary-copy"
    assert body["id"] != "sales-summary"
    file_paths = {item["path"] for item in body["files"]}
    assert "worker.yml" in file_paths
    assert "run.py" in file_paths


def test_worker_clone_and_restart_404_for_non_owner(app_ctx):
    client, _main, _scheduler = app_ctx
    from fastapi.testclient import TestClient

    other_client = TestClient(
        client.app,
        headers={"x-floom-secret": "worker-mgmt-secret", "x-floom-user": "other-user"},
    )

    cloned = other_client.post("/workers/sales-summary/clone")
    restarted = other_client.post("/workers/sales-summary/restart")

    assert cloned.status_code == 404, cloned.text
    assert restarted.status_code == 404, restarted.text


def test_worker_restart_rematerializes_from_embedded_files(app_ctx):
    client, main, _scheduler = app_ctx
    worker_dir = main.WORKERS_DIR / "sales-summary"
    run_py = worker_dir / "run.py"
    original = run_py.read_text(encoding="utf-8")
    main._embed_files_in_skill_version("sales-summary", worker_dir)
    run_py.unlink()
    assert not run_py.exists()

    restarted = client.post("/workers/sales-summary/restart")

    assert restarted.status_code == 200, restarted.text
    assert restarted.json()["rematerialized"] is True
    assert run_py.read_text(encoding="utf-8") == original


def test_worker_restart_skips_embedded_path_escape(app_ctx, tmp_path):
    client, main, _scheduler = app_ctx
    worker_dir = main.WORKERS_DIR / "sales-summary"
    absolute_escape = (tmp_path / "absolute-escape.py").resolve()
    main._embed_files_in_skill_version("sales-summary", worker_dir)
    with main.get_db() as conn:
        row = conn.execute(
            "SELECT sv.id, sv.manifest_json FROM skill_versions sv "
            "JOIN workers w ON w.skill_version_id = sv.id WHERE w.id = ?",
            ("sales-summary",),
        ).fetchone()
        manifest = json.loads(row["manifest_json"])
        manifest["_files"] = {
            "worker.yml": _worker_yml("sales-summary", title="Sales Summary"),
            "run.py": "print('restored')\n",
            "../escape.py": "print('bad')\n",
            str(absolute_escape): "print('bad')\n",
            "C:\\temp\\floom-escape.py": "print('bad')\n",
        }
        conn.execute(
            "UPDATE skill_versions SET manifest_json = ? WHERE id = ?",
            (json.dumps(manifest), row["id"]),
        )
    import shutil

    shutil.rmtree(worker_dir)
    restarted = client.post("/workers/sales-summary/restart")

    assert restarted.status_code == 200, restarted.text
    assert (worker_dir / "run.py").read_text(encoding="utf-8") == "print('restored')\n"
    assert not (main.WORKERS_DIR.parent / "escape.py").exists()
    assert not absolute_escape.exists()
    assert not (worker_dir / "C:" / "temp" / "floom-escape.py").exists()


def test_workers_shape_list_empty_workspace_returns_200(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "empty-workeros.db"
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "worker-mgmt-secret-empty")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "scheduler",
        "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": "worker-mgmt-secret-empty"})
    resp = client.get("/workers?shape=list")
    assert resp.status_code == 200, resp.text
    assert resp.json() == []
    db.get_repositories.cache_clear()


def test_scheduler_skips_missing_required_scheduled_inputs(app_ctx, monkeypatch):
    _client, main, scheduler = app_ctx
    monkeypatch.setattr(scheduler, "start_run", lambda *args, **kwargs: None)
    repos = main.get_repositories()
    now = datetime.now(timezone.utc)
    past = (now - timedelta(minutes=1)).isoformat()

    with main.get_db() as conn:
        conn.execute("UPDATE workers SET enabled = 0 WHERE id != 'scheduled-no-default'")
        conn.execute("UPDATE worker_triggers SET next_run_at = ? WHERE worker_id = 'scheduled-no-default'", (past,))

    considered = scheduler._tick_trigger_rows(repos, now, now.isoformat())

    assert considered == 1
    with main.get_db() as conn:
        runs = conn.execute("SELECT COUNT(*) AS count FROM runs WHERE worker_id = 'scheduled-no-default'").fetchone()
        trigger = conn.execute(
            "SELECT next_run_at FROM worker_triggers WHERE worker_id = 'scheduled-no-default'"
        ).fetchone()
    assert runs["count"] == 0
    assert trigger["next_run_at"] != past


def test_scheduler_uses_manifest_default_inputs_for_schedule_runs(app_ctx, monkeypatch):
    _client, main, scheduler = app_ctx
    monkeypatch.setattr(scheduler, "start_run", lambda *args, **kwargs: None)
    repos = main.get_repositories()
    now = datetime.now(timezone.utc)
    past = (now - timedelta(minutes=1)).isoformat()

    with main.get_db() as conn:
        conn.execute("UPDATE workers SET enabled = 0 WHERE id != 'scheduled-with-default'")
        conn.execute("UPDATE worker_triggers SET next_run_at = ? WHERE worker_id = 'scheduled-with-default'", (past,))

    considered = scheduler._tick_trigger_rows(repos, now, now.isoformat())

    assert considered == 1
    with main.get_db() as conn:
        run = conn.execute(
            "SELECT input_json FROM runs WHERE worker_id = 'scheduled-with-default' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    assert run is not None
    assert json.loads(run["input_json"])["channel"] == "CDEFAULT123"
