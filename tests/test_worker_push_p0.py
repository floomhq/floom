from __future__ import annotations

import importlib
import shutil
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
REPO_ROOT = Path(__file__).resolve().parents[1]
REPO_WORKERS_DIR = REPO_ROOT / "workers"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "worker-push-p0-secret"}


def _load_api(monkeypatch, tmp_path, *, stock_workers: tuple[str, ...] = (), require_workspace: bool = False):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    (tmp_path / "artifacts").mkdir()
    (tmp_path / "contexts").mkdir()
    for worker_id in stock_workers:
        shutil.copytree(REPO_WORKERS_DIR / worker_id, workers_dir / worker_id)

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("WORKEROS_PRECLEAR_BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_USER_ID", "user-a")
    if require_workspace:
        monkeypatch.setenv("WORKEROS_REQUIRE_WORKSPACE_HEADER_FOR_WRITES", "1")
    else:
        monkeypatch.delenv("WORKEROS_REQUIRE_WORKSPACE_HEADER_FOR_WRITES", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN_REGEX", raising=False)
    monkeypatch.delenv("WORKEROS_DEV", raising=False)

    reset_prefixes = ("auth.", "db.")
    reset_exact = {
        "main",
        "auth",
        "chat_service",
        "contexts",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    run_service = importlib.import_module("run_service")
    main._rate_buckets.clear()
    main.start_run = lambda *args, **kwargs: None
    run_service.start_run = main.start_run
    return main


def _headers(user_id: str = "user-a", *, workspace_id: str | None = None) -> dict[str, str]:
    headers = {**AUTH, "x-floom-user": user_id}
    if workspace_id is not None:
        headers["x-workeros-workspace"] = workspace_id
    return headers


def _worker_yml(name: str, *, title: str = "Worker Push Probe", is_example: bool | None = None) -> str:
    example_line = "" if is_example is None else f"is_example: {str(is_example).lower()}\n"
    return f"""schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "worker push p0 regression"
version: "0.1.0"
{example_line}targets: [generic]
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs: []
  outputs: []
trigger:
  type: manual
"""


def _worker_payload(name: str, *, title: str = "Worker Push Probe", is_example: bool | None = None) -> dict[str, str]:
    return {
        "worker_yml": _worker_yml(name, title=title, is_example=is_example),
        "run_py": (
            "def run(inputs, context):\n"
            "    return {'status': 'success', 'outputs': {'ok': True}, 'artifacts': []}\n"
        ),
    }


def test_atomic_create_rolls_back_dir_and_db_when_detail_build_fails(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    original_build_detail = main._build_worker_detail

    def fail_detail(*args, **kwargs):
        raise RuntimeError("forced detail failure")

    monkeypatch.setattr(main, "_build_worker_detail", fail_detail)
    response = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload("atomic-rollback-probe"),
    )

    assert response.status_code == 502, response.text
    workers_dir = Path(main.WORKERS_DIR)
    assert not (workers_dir / "atomic-rollback-probe").exists()
    assert not list(workers_dir.parent.glob(".atomic-rollback-probe.*"))
    assert main.get_repositories().workers.get_any(worker_id="atomic-rollback-probe") is None

    monkeypatch.setattr(main, "_build_worker_detail", original_build_detail)
    retry = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload("atomic-rollback-probe"),
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["id"] == "atomic-rollback-probe"


def test_slug_roundtrip_create_get_delete_uses_one_canonical_id(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload("fede_gmail_cleaner"),
    )
    assert created.status_code == 200, created.text
    assert created.json()["id"] == "fede-gmail-cleaner"

    fetched = client.get("/workers/fede_gmail_cleaner", headers=_headers())
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["id"] == "fede-gmail-cleaner"

    deleted = client.delete("/workers/fede_gmail_cleaner", headers=_headers())
    assert deleted.status_code == 204, deleted.text
    assert not (Path(main.WORKERS_DIR) / "fede-gmail-cleaner").exists()
    assert client.get("/workers/fede-gmail-cleaner", headers=_headers()).status_code == 404


def test_delete_reaps_orphan_dir_without_db_row(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    orphan_dir = Path(main.WORKERS_DIR) / "fede-gmail-cleaner"
    orphan_dir.mkdir()
    (orphan_dir / "worker.yml").write_text(_worker_yml("fede-gmail-cleaner"), encoding="utf-8")
    (orphan_dir / "run.py").write_text("def run(inputs, context):\n    return {}\n", encoding="utf-8")

    deleted = client.delete("/workers/fede_gmail_cleaner", headers=_headers())

    assert deleted.status_code == 204, deleted.text
    assert not orphan_dir.exists()


def test_stock_name_post_forks_to_user_owned_copy(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("gmail_inbox_manager",))
    client = TestClient(main.app)
    stock_yml_before = (Path(main.WORKERS_DIR) / "gmail_inbox_manager" / "worker.yml").read_text(encoding="utf-8")

    created = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload("gmail_inbox_manager", title="Customized Gmail Cleaner", is_example=True),
    )

    assert created.status_code == 200, created.text
    body = created.json()
    assert body["id"] == "gmail-inbox-manager-copy"
    assert body["id"] != "gmail_inbox_manager"
    copied_yml = (Path(main.WORKERS_DIR) / body["id"] / "worker.yml").read_text(encoding="utf-8")
    assert "name: gmail-inbox-manager-copy" in copied_yml
    assert "is_example: false" in copied_yml
    assert (Path(main.WORKERS_DIR) / "gmail_inbox_manager" / "worker.yml").read_text(encoding="utf-8") == stock_yml_before


def test_stock_name_put_is_blocked(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("gmail_inbox_manager",))
    client = TestClient(main.app)
    stock_dir = Path(main.WORKERS_DIR) / "gmail_inbox_manager"
    stock_yml_before = (stock_dir / "worker.yml").read_text(encoding="utf-8")
    stock_run_before = (stock_dir / "run.py").read_text(encoding="utf-8")

    updated = client.put(
        "/workers/gmail_inbox_manager",
        headers=_headers(),
        json=_worker_payload("gmail_inbox_manager", title="Customized Gmail Cleaner", is_example=True),
    )

    assert updated.status_code == 403, updated.text
    assert updated.json() == {"detail": "Stock workers cannot be modified through the API"}
    assert (stock_dir / "worker.yml").read_text(encoding="utf-8") == stock_yml_before
    assert (stock_dir / "run.py").read_text(encoding="utf-8") == stock_run_before


def test_stock_name_put_remains_blocked_after_existing_copy(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("gmail_inbox_manager",))
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload("gmail_inbox_manager", title="First Gmail Cleaner"),
    )
    blocked = client.put(
        "/workers/gmail_inbox_manager",
        headers=_headers(),
        json=_worker_payload("gmail_inbox_manager", title="Second Gmail Cleaner"),
    )

    assert created.status_code == 200, created.text
    assert created.json()["id"] == "gmail-inbox-manager-copy"
    assert blocked.status_code == 403, blocked.text
    assert blocked.json() == {"detail": "Stock workers cannot be modified through the API"}


def test_missing_or_invalid_workspace_context_returns_400_for_worker_write(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, require_workspace=True)
    client = TestClient(main.app)

    missing = client.post(
        "/workers",
        headers=_headers(),
        json=_worker_payload("missing-workspace-probe"),
    )
    invalid = client.post(
        "/workers",
        headers=_headers(workspace_id="not-a-workspace"),
        json=_worker_payload("invalid-workspace-probe"),
    )
    valid = client.post(
        "/workers",
        headers=_headers(workspace_id="local-default"),
        json=_worker_payload("valid-workspace-probe"),
    )

    assert missing.status_code == 400, missing.text
    assert "x-workeros-workspace" in missing.json()["detail"]
    assert invalid.status_code == 400, invalid.text
    assert valid.status_code == 200, valid.text
