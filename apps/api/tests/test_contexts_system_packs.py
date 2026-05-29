"""GAP 1 (#2) — /contexts must not be a dead empty page.

System/engine packs (worker-author-style) are surfaced read-only so operators
can SEE what shapes worker generation; operator-owned packs created by another
user stay hidden. System packs cannot be edited or deleted.
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


@pytest.fixture()
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    # System pack (worker-author-style) with one file.
    sys_pack = contexts_dir / "worker-author-style"
    sys_pack.mkdir()
    (sys_pack / "STYLE.md").write_text("# Style\nfollow this.\n", encoding="utf-8")

    # Operator pack owned by another user — must stay hidden.
    other_pack = contexts_dir / "other-user-pack"
    other_pack.mkdir()
    (other_pack / "notes.txt").write_text("secret\n", encoding="utf-8")
    (contexts_dir / ".workeros-contexts.json").write_text(
        '{"other-user-pack": {"owner_id": "user-a", "writeable": true}}\n',
        encoding="utf-8",
    )

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-ctx")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    # Owner-mismatch hiding only applies when scoping is on OR cloud; force it
    # so the other-user pack is correctly hidden from "federico".
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "0")

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-ctx"}) as client:
        yield client, main
    db.get_repositories.cache_clear()


def test_system_pack_listed_readonly_other_user_hidden(client_and_main):
    client, _main = client_and_main
    resp = client.get("/contexts")
    assert resp.status_code == 200, resp.text
    items = resp.json()
    by_name = {item["name"]: item for item in items}
    # System pack surfaced, read-only, with a description.
    assert "worker-author-style" in by_name
    sys_item = by_name["worker-author-style"]
    assert sys_item["system"] is True
    assert sys_item["read_only"] is True
    assert sys_item["description"]
    assert sys_item["file_count"] == 1
    # Another user's pack is NOT visible (owner-only).
    assert "other-user-pack" not in by_name


def test_system_pack_detail_and_file_readable(client_and_main):
    client, _main = client_and_main
    detail = client.get("/contexts/worker-author-style")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["system"] is True
    assert body["read_only"] is True
    assert any(f["path"] == "STYLE.md" for f in body["files"])
    # File content readable.
    file_resp = client.get("/contexts/worker-author-style/files/STYLE.md")
    assert file_resp.status_code == 200
    assert "follow this" in file_resp.text


def test_system_pack_not_mutable(client_and_main):
    client, _main = client_and_main
    # Write blocked.
    put = client.put(
        "/contexts/worker-author-style/files/STYLE.md",
        json={"content": "hacked"},
    )
    assert put.status_code == 404
    # Delete pack blocked.
    delete = client.delete("/contexts/worker-author-style")
    assert delete.status_code == 404
    # Delete file blocked.
    del_file = client.delete("/contexts/worker-author-style/files/STYLE.md")
    assert del_file.status_code == 404


def test_operator_create_and_upload_roundtrip(client_and_main):
    client, _main = client_and_main
    created = client.post("/contexts/my-company")
    assert created.status_code == 200, created.text
    assert created.json()["system"] is False
    # Operator pack now visible in list (plus the system pack).
    names = [c["name"] for c in client.get("/contexts").json()]
    assert "my-company" in names
    assert "worker-author-style" in names
    # Upload a file and confirm it persists.
    up = client.post(
        "/contexts/my-company/upload",
        files={"files": ("icp.md", b"# ICP\nB2B SaaS founders.\n", "text/markdown")},
    )
    assert up.status_code == 200, up.text
    detail = client.get("/contexts/my-company").json()
    assert any(f["path"] == "icp.md" for f in detail["files"])


_CTX_WORKER_YML = """schema_version: "0.3"
name: "ctx-consumer"
title: "Context Consumer"
description: "mounts my-company"
version: "0.1.0"
targets: [generic]
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs: []
  outputs: []
trigger:
  type: manual
connections: []
contexts:
  - name: "my-company"
    writeable: false
"""

_CTX_WORKER_RUN_PY = (
    "def run(inputs, context):\n"
    "    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
)


def test_list_worker_count_matches_detail(client_and_main):
    """FIX 2: /contexts LIST worker_count must equal /contexts/{name} used_by.

    Previously the LIST path hardcoded worker_count=0 while the DETAIL path
    computed it from referencing workers, so the UI showed "0 workers" for
    packs that were actually in use.
    """
    client, _main = client_and_main
    # Operator pack with zero referencing workers => count 0 in both views.
    assert client.post("/contexts/my-company").status_code == 200
    list_before = {c["name"]: c for c in client.get("/contexts").json()}
    assert list_before["my-company"]["worker_count"] == 0
    detail_before = client.get("/contexts/my-company").json()
    assert len(detail_before["used_by"]) == 0
    assert detail_before["worker_count"] == 0

    # Create a worker that mounts the pack.
    created = client.post(
        "/workers",
        json={"worker_yml": _CTX_WORKER_YML, "run_py": _CTX_WORKER_RUN_PY},
    )
    assert created.status_code == 200, created.text

    # LIST count now == DETAIL used_by length == 1.
    list_after = {c["name"]: c for c in client.get("/contexts").json()}
    detail_after = client.get("/contexts/my-company").json()
    assert detail_after["worker_count"] == len(detail_after["used_by"])
    assert detail_after["worker_count"] == 1
    assert list_after["my-company"]["worker_count"] == 1
    assert (
        list_after["my-company"]["worker_count"] == detail_after["worker_count"]
    )
