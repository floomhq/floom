from __future__ import annotations

import importlib
import json
import shutil
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _worker_yml(worker_id: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{worker_id}"
title: "{worker_id}"
description: Test worker
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


def _boot(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    (tmp_path / "workers").mkdir()
    for name in list(sys.modules):
        if (
            name == "main"
            or name == "auth"
            or name == "auth.local"
            or name == "db"
            or name == "models"
            or name == "worker_registry"
            or name == "run_service"
            or name.startswith("db.")
            or name.startswith("routers.")
            or name.startswith("services.")
        ):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    return TestClient(
        main.app,
        headers={"x-floom-secret": "test-secret", "x-floom-user": "local-user"},
    ), main


def test_worker_json_bundle_clone_and_restart(monkeypatch, tmp_path):
    client, main = _boot(monkeypatch, tmp_path)
    worker_yml = _worker_yml("bundle-api-worker")
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
    assert "lib/helper.py" in {item["path"] for item in created.json()["files"]}

    cloned = client.post("/workers/bundle-api-worker/clone")
    assert cloned.status_code == 200, cloned.text
    assert cloned.json()["id"] == "bundle-api-worker-copy"
    assert "lib/helper.py" in {item["path"] for item in cloned.json()["files"]}

    worker_dir = main.WORKERS_DIR / "bundle-api-worker"
    main._embed_files_in_skill_version("bundle-api-worker", worker_dir)
    (worker_dir / "run.py").unlink()
    restarted = client.post("/workers/bundle-api-worker/restart")
    assert restarted.status_code == 200, restarted.text
    assert restarted.json()["rematerialized"] is True
    assert (worker_dir / "run.py").exists()


def test_worker_json_bundle_limits_and_rejects_path_escape(monkeypatch, tmp_path):
    client, _main = _boot(monkeypatch, tmp_path)
    worker_yml = _worker_yml("bad-json-worker")
    too_many_files = [{"path": "worker.yml", "content": worker_yml}]
    too_many_files.extend({"path": f"lib/file_{idx}.py", "content": ""} for idx in range(2000))

    oversized = client.post(
        "/workers",
        json={"worker_yml": worker_yml, "files": too_many_files},
    )
    assert oversized.status_code == 413, oversized.text

    for bad_path in ["../evil.py", str((tmp_path / "evil.py").resolve()), "C:\\temp\\evil.py"]:
        escaped = client.post(
            "/workers",
            json={
                "worker_yml": worker_yml,
                "files": [
                    {"path": "worker.yml", "content": worker_yml},
                    {"path": bad_path, "content": "print('bad')\n"},
                ],
            },
        )
        assert escaped.status_code == 400, escaped.text


def test_worker_clone_and_restart_are_owner_scoped(monkeypatch, tmp_path):
    client, _main = _boot(monkeypatch, tmp_path)
    worker_yml = _worker_yml("private-worker")
    created = client.post(
        "/workers",
        json={
            "worker_yml": worker_yml,
            "files": [
                {"path": "worker.yml", "content": worker_yml},
                {"path": "run.py", "content": "print('ok')\n"},
            ],
        },
    )
    assert created.status_code == 200, created.text

    from fastapi.testclient import TestClient

    other_client = TestClient(
        client.app,
        headers={"x-floom-secret": "test-secret", "x-floom-user": "other-user"},
    )

    assert other_client.post("/workers/private-worker/clone").status_code == 404
    assert other_client.post("/workers/private-worker/restart").status_code == 404


def test_worker_restart_skips_malicious_embedded_file_paths(monkeypatch, tmp_path):
    client, main = _boot(monkeypatch, tmp_path)
    worker_yml = _worker_yml("contained-worker")
    created = client.post(
        "/workers",
        json={
            "worker_yml": worker_yml,
            "files": [
                {"path": "worker.yml", "content": worker_yml},
                {"path": "run.py", "content": "print('original')\n"},
            ],
        },
    )
    assert created.status_code == 200, created.text
    absolute_escape = (tmp_path / "absolute-escape.py").resolve()
    worker_dir = main.WORKERS_DIR / "contained-worker"

    with main.get_db() as conn:
        row = conn.execute(
            "SELECT sv.id, sv.manifest_json FROM skill_versions sv "
            "JOIN workers w ON w.skill_version_id = sv.id WHERE w.id = ?",
            ("contained-worker",),
        ).fetchone()
        manifest = json.loads(row["manifest_json"])
        manifest["_files"] = {
            "worker.yml": worker_yml,
            "run.py": "print('restored')\n",
            "../escape.py": "print('bad')\n",
            str(absolute_escape): "print('bad')\n",
            "C:\\temp\\floom-escape.py": "print('bad')\n",
        }
        conn.execute(
            "UPDATE skill_versions SET manifest_json = ? WHERE id = ?",
            (json.dumps(manifest), row["id"]),
        )

    shutil.rmtree(worker_dir)
    restarted = client.post("/workers/contained-worker/restart")

    assert restarted.status_code == 200, restarted.text
    assert (worker_dir / "run.py").read_text(encoding="utf-8") == "print('restored')\n"
    assert not (main.WORKERS_DIR.parent / "escape.py").exists()
    assert not absolute_escape.exists()
    assert not (worker_dir / "C:" / "temp" / "floom-escape.py").exists()
