"""#790 — attach/detach/update brain folders on a worker without a full YAML
rewrite (POST/PATCH/DELETE /workers/{id}/contexts).

Run: cd apps/api && python -m pytest tests/test_worker_context_attach.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-ctxattach"

_YML = """\
schema_version: "0.3"
name: "ctx-worker"
title: "Ctx Worker"
description: "mounts packs"
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
contexts: []
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "ctx-worker"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main", "contexts",
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
        main._persist_discovered_workers(conn, workers, user_id="federico")
    from fastapi.testclient import TestClient
    c = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield c, wdir
    db.get_repositories.cache_clear()


def _ctx_names(detail_json):
    return {c["name"]: c for c in detail_json["config"]["contexts"]}


def test_attach_then_detach(client):
    c, _ = client
    resp = c.post("/workers/ctx-worker/contexts", json={"name": "my-brain", "writeable": True})
    assert resp.status_code == 200, resp.text
    ctxs = _ctx_names(resp.json())
    assert "my-brain" in ctxs
    assert ctxs["my-brain"]["writeable"] is True

    # detach
    det = c.delete("/workers/ctx-worker/contexts/my-brain")
    assert det.status_code == 200, det.text
    assert "my-brain" not in _ctx_names(det.json())


def test_update_writeable(client):
    c, _ = client
    c.post("/workers/ctx-worker/contexts", json={"name": "research", "writeable": False})
    upd = c.patch("/workers/ctx-worker/contexts/research", json={"writeable": True})
    assert upd.status_code == 200, upd.text
    assert _ctx_names(upd.json())["research"]["writeable"] is True


def test_attach_persists_to_worker_yml(client):
    c, wdir = client
    c.post("/workers/ctx-worker/contexts", json={"name": "persisted", "writeable": False})
    import yaml
    doc = yaml.safe_load((wdir / "worker.yml").read_text())
    names = {ctx["name"] for ctx in (doc.get("contexts") or [])}
    assert "persisted" in names


def test_attach_patches_contexts_without_full_yaml_rewrite(client):
    c, wdir = client
    worker_yml = wdir / "worker.yml"
    worker_yml.write_text(
        """\
schema_version: "0.3"
# keep-comment
name: "ctx-worker"
title: "Ctx Worker"
description: "mounts packs"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  contexts:
    - legacy-pack
inputs: []
connections: []
contexts: []
""",
        encoding="utf-8",
    )

    resp = c.post("/workers/ctx-worker/contexts", json={"name": "kept", "writeable": True})
    assert resp.status_code == 200, resp.text
    text = worker_yml.read_text(encoding="utf-8")
    assert "# keep-comment" in text
    assert 'schema_version: "0.3"' in text
    assert "  contexts:" not in text

    import yaml
    doc = yaml.safe_load(text)
    assert doc["contexts"] == [{"name": "kept", "writeable": True}]
    assert "contexts" not in doc["exec"]


def test_detach_missing_context_404(client):
    c, _ = client
    assert c.delete("/workers/ctx-worker/contexts/never-attached").status_code == 404


def test_attach_unknown_worker_404(client):
    c, _ = client
    assert c.post("/workers/nope/contexts", json={"name": "x"}).status_code == 404
