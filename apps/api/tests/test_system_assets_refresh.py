from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "system-assets-refresh-secret"


def _load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    contexts_dir = tmp_path / "contexts"
    workers_dir.mkdir()
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path / "workspace"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    monkeypatch.delenv("WORKEROS_DEV", raising=False)
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    for name in list(sys.modules):
        if name in {
            "main",
            "db",
            "models",
            "files",
            "worker_registry",
            "run_service",
            "contexts",
            "auth",
            "scheduler",
        } or name.startswith(("db.", "auth.", "routers.", "services.", "core.")):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return main, workers_dir, contexts_dir


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


def test_internal_refresh_overwrites_stale_worker_bundle_and_embeds_files(monkeypatch, tmp_path):
    main, workers_dir, _contexts_dir = _load_main(monkeypatch, tmp_path)
    stale_dir = workers_dir / "worker-author"
    stale_dir.mkdir()
    (stale_dir / "worker.yml").write_text("name: stale\nsystem_worker: true\n", encoding="utf-8")
    (stale_dir / "run.py").write_text("print('stale')\n", encoding="utf-8")

    with _client(main) as client:
        response = client.post(
            "/internal/system-assets/refresh",
            headers={"x-floom-secret": SECRET},
            json={"asset": "worker-author"},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["count"] == 1
    refreshed = body["refreshed"][0]
    assert refreshed["asset"] == "worker-author"
    assert refreshed["kind"] == "worker"
    assert refreshed["files"] >= 3

    deployed_yml = (REPO_ROOT / "workers" / "worker-author" / "worker.yml").read_text(encoding="utf-8")
    local_yml = (workers_dir / "worker-author" / "worker.yml").read_text(encoding="utf-8")
    assert local_yml == deployed_yml
    deployed_run_py = (REPO_ROOT / "workers" / "worker-author" / "run.py").read_text(encoding="utf-8")
    assert (workers_dir / "worker-author" / "run.py").read_text(encoding="utf-8") == deployed_run_py

    db = importlib.import_module("db")
    worker = db.get_repositories().workers.get_any(worker_id="worker-author")
    assert worker is not None
    manifest = worker["manifest_json"]
    assert manifest["system_worker"] is True
    assert manifest["_system_source_hash"] == refreshed["hash"]
    assert manifest["_files"]["worker.yml"] == deployed_yml
    assert "run.py" in manifest["_files"]


def test_internal_refresh_creates_missing_system_worker_row(monkeypatch, tmp_path):
    main, _workers_dir, _contexts_dir = _load_main(monkeypatch, tmp_path)

    db = importlib.import_module("db")
    assert db.get_repositories().workers.get_any(worker_id="workspace-agent") is None

    with _client(main) as client:
        response = client.post(
            "/internal/system-assets/refresh",
            headers={"x-floom-secret": SECRET},
            json={"asset": "workspace-agent", "workspace_id": "ws_system"},
        )

    assert response.status_code == 200, response.text
    worker = db.get_repositories().workers.get_any(worker_id="workspace-agent")
    assert worker is not None
    assert worker["workspace_id"] == "ws_system"
    assert worker["visibility"] == "workspace"
    assert worker["manifest_json"]["_files"]["worker.yml"].startswith("schema_version:")


def test_internal_refresh_replaces_system_context_and_calls_sync_hook(monkeypatch, tmp_path):
    main, _workers_dir, contexts_dir = _load_main(monkeypatch, tmp_path)
    stale_pack = contexts_dir / "ws_system" / "worker-author-style"
    stale_pack.mkdir(parents=True)
    (stale_pack / "STYLE.md").write_text("stale style\n", encoding="utf-8")

    contexts = importlib.import_module("contexts")
    calls = []

    def _hook(scope, name, source_dir, summary):
        calls.append(
            {
                "scope": scope,
                "name": name,
                "source_dir": str(source_dir),
                "summary": dict(summary),
            }
        )

    contexts.set_context_refresh_hook(_hook)

    with _client(main) as client:
        response = client.post(
            "/internal/system-assets/refresh",
            headers={"x-floom-secret": SECRET},
            json={"asset": "worker-author-style", "workspace_id": "ws_system"},
        )

    assert response.status_code == 200, response.text
    deployed_style = (
        REPO_ROOT / "contexts" / "worker-author-style" / "STYLE.md"
    ).read_text(encoding="utf-8")
    assert (stale_pack / "STYLE.md").read_text(encoding="utf-8") == deployed_style
    assert len(calls) == 1
    assert calls[0]["scope"] == "ws_system"
    assert calls[0]["name"] == "worker-author-style"
    assert calls[0]["source_dir"] == str(stale_pack)
    assert calls[0]["summary"]["file_count"] >= 5

    with contexts.use_context_scope("ws_system"):
        metadata = contexts.load_context_metadata()
    pack_meta = metadata["worker-author-style"]
    assert pack_meta["writeable"] is False
    assert pack_meta["sensitive"] is True
    assert pack_meta["category"] == "system"


def test_internal_refresh_requires_auth(monkeypatch, tmp_path):
    main, _workers_dir, _contexts_dir = _load_main(monkeypatch, tmp_path)

    with _client(main) as client:
        response = client.post(
            "/internal/system-assets/refresh",
            json={"asset": "worker-author"},
        )

    assert response.status_code == 401
