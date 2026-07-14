"""#788 — POST /workers/{id}/pause and /resume toggle the enabled state.

Workers have an `enabled` DB column but no dedicated endpoint to toggle it;
pausing required editing worker.yml via a full PUT. These endpoints flip
enabled (and clear next_run_at on pause to unschedule).

Run: cd apps/api && python -m pytest tests/test_worker_pause_resume.py -q
"""
from __future__ import annotations

import importlib
import shutil
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-pause"

_YML = """\
schema_version: "0.3"
name: "pausable"
title: "Pausable Worker"
description: "A worker we can pause and resume"
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 9 * * *"
  timezone: "UTC"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "pausable"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main
    db.get_repositories.cache_clear()


def test_pause_then_resume(client_and_main):
    client, _ = client_and_main
    initial = client.get("/workers/pausable").json()
    assert initial["enabled"] is True
    assert initial["status"] == "ready"

    paused = client.post("/workers/pausable/pause")
    assert paused.status_code == 200, paused.text
    assert paused.json()["enabled"] is False
    assert paused.json()["status"] == "needs_attention"
    paused_detail = client.get("/workers/pausable").json()
    assert paused_detail["enabled"] is False
    assert paused_detail["status"] == "needs_attention"

    resumed = client.post("/workers/pausable/resume")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["enabled"] is True
    assert resumed.json()["status"] == "ready"
    resumed_detail = client.get("/workers/pausable").json()
    assert resumed_detail["enabled"] is True
    assert resumed_detail["status"] == "ready"


def test_pause_clears_next_run_at(client_and_main):
    client, main = client_and_main
    with main.get_db() as conn:
        conn.execute("UPDATE workers SET next_run_at = '2099-01-01T00:00:00Z' WHERE id = ?", ("pausable",))
    client.post("/workers/pausable/pause")
    with main.get_db() as conn:
        row = conn.execute("SELECT next_run_at FROM workers WHERE id = ?", ("pausable",)).fetchone()
    assert row["next_run_at"] is None


def test_manual_pause_resume_preserves_unpaused_worker_yml(client_and_main):
    client, main = client_and_main
    worker_yml = main.WORKERS_DIR / "pausable" / "worker.yml"
    original = "# keep this operator comment\n" + worker_yml.read_text(encoding="utf-8")
    worker_yml.write_text(original, encoding="utf-8")

    assert client.post("/workers/pausable/pause").status_code == 200
    assert client.post("/workers/pausable/resume").status_code == 200

    assert worker_yml.read_text(encoding="utf-8") == original


def test_resume_clears_auto_pause_manifest_and_worker_yml(client_and_main):
    client, main = client_and_main
    repos = main.get_repositories()
    from services.run_pause_policy import _persist_worker_paused_flag

    _persist_worker_paused_flag(
        "pausable",
        repos=repos,
        user_id="local-user",
    )
    paused = repos.workers.get(user_id="local-user", worker_id="pausable")
    assert paused["enabled"] is False
    assert paused["manifest"]["paused"] is True
    assert paused["manifest"]["enabled"] is False
    worker_yml = main.WORKERS_DIR / "pausable" / "worker.yml"
    paused_yml = worker_yml.read_text(encoding="utf-8").replace(
        "paused: true",
        "paused: yes",
    )
    worker_yml.write_text(paused_yml, encoding="utf-8")
    paused_manifest = dict(paused["manifest"])
    paused_manifest["_files"] = {
        "worker.yml": paused_yml,
        "run.py": "print('hi')\n",
    }
    repos.workers.update(
        user_id="local-user",
        worker_id="pausable",
        enabled=False,
        manifest_json=paused_manifest,
    )

    resumed = client.post("/workers/pausable/resume")

    assert resumed.status_code == 200, resumed.text
    stored = repos.workers.get(user_id="local-user", worker_id="pausable")
    assert stored["enabled"] is True
    assert stored["manifest"]["paused"] is False
    assert stored["manifest"]["enabled"] is True
    assert "archive_reason" not in stored["manifest"]
    content = worker_yml.read_text(encoding="utf-8")
    assert "paused:" not in content
    assert "paused:" not in stored["manifest"]["_files"]["worker.yml"]


def test_resume_rolls_back_worker_yml_when_repository_update_fails(
    client_and_main,
    monkeypatch,
):
    client, main = client_and_main
    repos = main.get_repositories()
    from services.run_pause_policy import _persist_worker_paused_flag

    _persist_worker_paused_flag(
        "pausable",
        repos=repos,
        user_id="local-user",
    )
    worker_yml = main.WORKERS_DIR / "pausable" / "worker.yml"
    paused_yml = worker_yml.read_text(encoding="utf-8")
    original_update = repos.workers.update

    def fail_update(*, user_id, worker_id, **fields):
        if fields.get("enabled") is True:
            raise RuntimeError("repository unavailable")
        return original_update(user_id=user_id, worker_id=worker_id, **fields)

    monkeypatch.setattr(repos.workers, "update", fail_update)

    with pytest.raises(RuntimeError, match="repository unavailable"):
        client.post("/workers/pausable/resume")

    assert worker_yml.read_text(encoding="utf-8") == paused_yml
    stored = repos.workers.get(user_id="local-user", worker_id="pausable")
    assert stored["enabled"] is False
    assert stored["manifest"]["paused"] is True


def test_resume_clears_embedded_worker_yml_without_local_bundle(client_and_main):
    client, main = client_and_main
    repos = main.get_repositories()
    from services.run_pause_policy import _persist_worker_paused_flag

    _persist_worker_paused_flag(
        "pausable",
        repos=repos,
        user_id="local-user",
    )
    paused = repos.workers.get(user_id="local-user", worker_id="pausable")
    worker_yml = main.WORKERS_DIR / "pausable" / "worker.yml"
    paused_yml = worker_yml.read_text(encoding="utf-8")
    paused_manifest = dict(paused["manifest"])
    paused_manifest["_files"] = {
        "worker.yml": paused_yml,
        "run.py": "print('hi')\n",
    }
    repos.workers.update(
        user_id="local-user",
        worker_id="pausable",
        manifest_json=paused_manifest,
    )
    shutil.rmtree(worker_yml.parent)

    resumed = client.post("/workers/pausable/resume")

    assert resumed.status_code == 200, resumed.text
    stored = repos.workers.get(user_id="local-user", worker_id="pausable")
    assert stored["enabled"] is True
    assert stored["manifest"]["paused"] is False
    assert "paused:" not in stored["manifest"]["_files"]["worker.yml"]


def test_resume_preserves_canonical_embedded_bundle_when_disk_differs(client_and_main):
    client, main = client_and_main
    repos = main.get_repositories()
    from services.run_pause_policy import _persist_worker_paused_flag

    _persist_worker_paused_flag(
        "pausable",
        repos=repos,
        user_id="local-user",
    )
    paused = repos.workers.get(user_id="local-user", worker_id="pausable")
    worker_yml = main.WORKERS_DIR / "pausable" / "worker.yml"
    disk_yml = worker_yml.read_text(encoding="utf-8") + "# stale disk copy\n"
    worker_yml.write_text(disk_yml, encoding="utf-8")
    canonical_yml = disk_yml.replace(
        "# stale disk copy",
        "# canonical portable bundle",
    )
    paused_manifest = dict(paused["manifest"])
    paused_manifest["_files"] = {
        "worker.yml": canonical_yml,
        "run.py": "print('canonical')\n",
    }
    repos.workers.update(
        user_id="local-user",
        worker_id="pausable",
        manifest_json=paused_manifest,
    )

    resumed = client.post("/workers/pausable/resume")

    assert resumed.status_code == 200, resumed.text
    stored = repos.workers.get(user_id="local-user", worker_id="pausable")
    embedded = stored["manifest"]["_files"]["worker.yml"]
    assert "# canonical portable bundle" in embedded
    assert "# stale disk copy" not in embedded
    assert "paused:" not in embedded


def test_pause_unknown_worker_404(client_and_main):
    client, _ = client_and_main
    assert client.post("/workers/does-not-exist/pause").status_code == 404
