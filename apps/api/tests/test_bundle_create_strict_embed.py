"""Route-level regression for the from-bundle strict-embed cleanup (#717 residual).

`create_worker_from_bundle` used to swallow embed failures (logger.warning), so a
bundle worker could reach 'ready' with an empty `manifest_json._files` and then
404 "Worker directory not found" on the e2b executor. The fix embeds with
`strict=True` and, on failure, removes the target dir AND purges the just-persisted
DB row before raising 502 — so a broken bundle never silently ships.

This asserts the route-level cleanup sequence (the actual residual being fixed),
complementing the helper-level strict tests in test_507_worker_backup_files.py.
"""
from __future__ import annotations

import importlib
import io
import sys
import zipfile
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "bundle-strict-embed-secret"


def _load_main(monkeypatch, tmp_path, *, env: dict | None = None):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    monkeypatch.setenv("WORKEROS_DEV", "")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    for name in list(sys.modules):
        if (
            name in ("main", "db", "auth", "run_token", "worker_registry", "run_service", "routers", "services")
            or name.startswith(("db.", "auth.", "routers.", "services."))
        ):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


_WORKER_YML = """schema_version: "0.3"
name: {name}
title: "Bundle strict embed worker"
description: "regression test"
version: "0.1.0"
exec:
  inputs: []
  outputs:
    - name: message
      type: string
trigger:
  type: manual
"""


def test_from_bundle_embed_failure_returns_502_and_leaves_no_orphan(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    main = _load_main(monkeypatch, tmp_path, env={"FLOOM_WORKERS_DIR": str(workers_dir)})

    # Force the post-persist embed to fail the way a real Postgres write failure
    # would, so we exercise the strict path + cleanup.
    import routers.worker_create as wc

    def _boom(worker_id, target_dir, *, repos=None, strict=False):
        raise RuntimeError("simulated embed failure")

    monkeypatch.setattr(wc, "_embed_files_in_skill_version", _boom)

    name = "bundle-strict-embed-probe"
    payload = _zip_bytes(
        {
            f"{name}/worker.yml": _WORKER_YML.format(name=name).encode(),
            f"{name}/run.py": b"def run(inputs):\n    return {'message': 'ok'}\n",
        }
    )

    with _client(main) as client:
        resp = client.post(
            "/workers/from-bundle",
            headers={"x-floom-secret": SECRET},
            files={"bundle": ("b.zip", payload, "application/zip")},
        )
        # Embed failed strict -> the create fails loud, not a silent 'ready'.
        assert resp.status_code == 502, resp.text

        # No orphan directory left behind.
        from worker_registry import WORKERS_DIR

        assert not (Path(WORKERS_DIR) / name).exists()

        # No orphan DB row: the worker must not be gettable/listed.
        got = client.get(f"/workers/{name}", headers={"x-floom-secret": SECRET})
        assert got.status_code == 404, got.text
