from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
import types
import uuid
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
REPO_ROOT = Path(__file__).resolve().parents[1]
REPO_WORKERS_DIR = REPO_ROOT / "workers"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

AUTH = {"x-floom-secret": "round8-secret"}


def _load_api(monkeypatch, tmp_path, *, stock_workers: tuple[str, ...] = ()):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    for worker_id in stock_workers:
        shutil.copytree(REPO_WORKERS_DIR / worker_id, workers_dir / worker_id)

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    # Keep /runs/clear pre-wipe snapshots inside the tmp dir, never the prod
    # backups path.
    monkeypatch.setenv("WORKEROS_PRECLEAR_BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH["x-floom-secret"])
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_USER_ID", "user-a")
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


def _headers(user_id: str) -> dict[str, str]:
    return {**AUTH, "x-floom-user": user_id}


def _worker_yml(name: str, *, title: str = "Audit Worker", trigger_type: str = "manual") -> str:
    if trigger_type == "webhook":
        trigger_block = """
trigger:
  type: webhook
  webhook:
    secret: true
""".strip()
    else:
        trigger_block = """
trigger:
  type: manual
""".strip()
    return f"""schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "authz test worker"
version: "0.1.0"
targets: [generic]
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs: []
  outputs: []
{trigger_block}
"""


def _worker_payload(
    name: str,
    *,
    title: str = "Audit Worker",
    trigger_type: str = "manual",
    secrets: tuple[str, ...] = (),
) -> dict[str, str]:
    worker_yml = _worker_yml(name, title=title, trigger_type=trigger_type)
    if secrets:
        secret_lines = "\n".join(f"  - {secret}" for secret in secrets)
        worker_yml = worker_yml.replace("  outputs: []", f"  secrets:\n{secret_lines}\n  outputs: []")
    return {
        "worker_yml": worker_yml,
        "run_py": (
            "def run(inputs, context):\n"
            "    return {'status': 'success', 'outputs': {'ok': True}, 'artifacts': []}\n"
        ),
    }


def _insert_connection(main, *, user_id: str, app_name: str = "gmail") -> str:
    local_id = f"local_{user_id}_{app_name}"
    now = main.now_iso()
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO composio_connections
                (id, app_name, composio_connection_id, status, created_at, updated_at, user_id)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
            """,
            (
                local_id,
                app_name,
                f"ca_{user_id}_{app_name}",
                now,
                now,
                user_id,
            ),
        )
    return local_id


def _tracked_worker_ids() -> set[str]:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-tree", "-r", "--name-only", "HEAD", "workers"],
        check=True,
        capture_output=True,
        text=True,
    )
    tracked_ids = set()
    for raw_path in result.stdout.splitlines():
        path = Path(raw_path.strip())
        if len(path.parts) == 3 and path.parts[0] == "workers" and path.parts[2] == "worker.yml":
            tracked_ids.add(path.parts[1])
    return tracked_ids


def _seed_run_surfaces(main, tmp_path, *, run_id: str) -> str:
    artifact_id = f"artifact_{uuid.uuid4().hex}"
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir(exist_ok=True)
    artifact_path = artifacts_dir / f"{artifact_id}.txt"
    artifact_path.write_text("artifact body")

    bundle_dir = tmp_path / "run-bundles" / run_id
    bundle_dir.mkdir(parents=True, exist_ok=True)
    (bundle_dir / "worker.yml").write_text("name: seeded\n")

    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO logs (run_id, level, message, timestamp, trace_id)
            VALUES (?, 'info', 'scoped log', ?, 'trace_scope')
            """,
            (run_id, main.now_iso()),
        )
        conn.execute(
            """
            INSERT INTO artifacts (id, run_id, name, type, path, size_bytes, created_at)
            VALUES (?, ?, 'result.txt', 'file', ?, ?, ?)
            """,
            (
                artifact_id,
                run_id,
                str(artifact_path),
                artifact_path.stat().st_size,
                main.now_iso(),
            ),
        )
        conn.execute(
            "UPDATE runs SET bundle_snapshot_path = ? WHERE id = ?",
            (f"run-bundles/{run_id}", run_id),
        )
    return artifact_id


def test_list_workers_hides_foreign_custom_workers_but_keeps_stock(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief",))
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("shared-probe", title="Shared Probe"),
    )
    assert created.status_code == 200, created.text

    owner_list = client.get("/workers", headers=_headers("user-a"))
    foreign_list = client.get("/workers", headers=_headers("user-b"))

    assert owner_list.status_code == 200, owner_list.text
    assert foreign_list.status_code == 200, foreign_list.text

    owner_ids = {item["id"] for item in owner_list.json()}
    foreign_ids = {item["id"] for item in foreign_list.json()}

    assert {"research_brief", "shared-probe"} <= owner_ids
    assert "research_brief" in foreign_ids
    assert "shared-probe" not in foreign_ids


def test_foreign_custom_worker_routes_return_404(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("shared-probe", title="Shared Probe"),
    )
    assert created.status_code == 200, created.text

    payload = _worker_payload("shared-probe", title="Overwritten Probe")
    files_payload = {
        "files": [
            {"path": "worker.yml", "content": payload["worker_yml"]},
            {"path": "run.py", "content": payload["run_py"]},
        ]
    }

    checks = {
        "detail": client.get("/workers/shared-probe", headers=_headers("user-b")),
        "timeseries": client.get("/workers/shared-probe/runs/timeseries", headers=_headers("user-b")),
        "patch": client.patch(
            "/workers/shared-probe",
            headers=_headers("user-b"),
            json={"trigger_type": "manual"},
        ),
        "put": client.put(
            "/workers/shared-probe",
            headers=_headers("user-b"),
            json=payload,
        ),
        "put_files": client.put(
            "/workers/shared-probe/files",
            headers=_headers("user-b"),
            json=files_payload,
        ),
        "create_run": client.post(
            "/workers/shared-probe/runs",
            headers=_headers("user-b"),
            json={"inputs": {}, "trigger_source": "manual"},
        ),
    }

    for name, response in checks.items():
        assert response.status_code == 404, f"{name}: {response.status_code} {response.text}"

    owner_detail = client.get("/workers/shared-probe", headers=_headers("user-a"))
    assert owner_detail.status_code == 200, owner_detail.text
    assert owner_detail.json()["name"] == "Shared Probe"


def test_run_list_and_foreign_run_routes_return_404(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created_a = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("runs-owner-probe", title="Runs Owner Probe"),
    )
    created_b = client.post(
        "/workers",
        headers=_headers("user-b"),
        json=_worker_payload("runs-foreign-probe", title="Runs Foreign Probe"),
    )
    assert created_a.status_code == 200, created_a.text
    assert created_b.status_code == 200, created_b.text

    run_a = client.post(
        "/workers/runs-owner-probe/runs",
        headers=_headers("user-a"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    run_b = client.post(
        "/workers/runs-foreign-probe/runs",
        headers=_headers("user-b"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    assert run_a.status_code == 200, run_a.text
    assert run_b.status_code == 200, run_b.text

    run_a_id = run_a.json()["run_id"]
    run_b_id = run_b.json()["run_id"]
    artifact_id = _seed_run_surfaces(main, tmp_path, run_id=run_a_id)

    owner_list = client.get("/runs", headers=_headers("user-a"))
    foreign_list = client.get("/runs", headers=_headers("user-b"))
    assert owner_list.status_code == 200, owner_list.text
    assert foreign_list.status_code == 200, foreign_list.text

    owner_ids = {item["id"] for item in owner_list.json()}
    foreign_ids = {item["id"] for item in foreign_list.json()}
    assert run_a_id in owner_ids
    assert run_b_id not in owner_ids
    assert run_b_id in foreign_ids
    assert run_a_id not in foreign_ids

    checks = {
        "detail": client.get(f"/runs/{run_a_id}", headers=_headers("user-b")),
        "download": client.get(f"/runs/{run_a_id}/download", headers=_headers("user-b")),
        "bundle": client.get(f"/runs/{run_a_id}/bundle/worker.yml", headers=_headers("user-b")),
        "artifact": client.get(
            f"/runs/{run_a_id}/artifacts/{artifact_id}/download",
            headers=_headers("user-b"),
        ),
        "stream": client.get(f"/runs/{run_a_id}/stream", headers=_headers("user-b")),
        "events": client.get(f"/runs/{run_a_id}/events", headers=_headers("user-b")),
        "logs": client.get(f"/runs/{run_a_id}/logs", headers=_headers("user-b")),
        "cancel": client.post(f"/runs/{run_a_id}/cancel", headers=_headers("user-b")),
    }

    for name, response in checks.items():
        assert response.status_code == 404, f"{name}: {response.status_code} {response.text}"


def test_runs_clear_only_deletes_owner_history(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created_a = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("clear-owner-probe", title="Clear Owner Probe"),
    )
    created_b = client.post(
        "/workers",
        headers=_headers("user-b"),
        json=_worker_payload("clear-foreign-probe", title="Clear Foreign Probe"),
    )
    assert created_a.status_code == 200, created_a.text
    assert created_b.status_code == 200, created_b.text

    run_a = client.post(
        "/workers/clear-owner-probe/runs",
        headers=_headers("user-a"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    run_b = client.post(
        "/workers/clear-foreign-probe/runs",
        headers=_headers("user-b"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    assert run_a.status_code == 200, run_a.text
    assert run_b.status_code == 200, run_b.text

    clear_resp = client.post(
        "/runs/clear?confirm=yes-wipe-all-runs",
        headers=_headers("user-a"),
    )
    assert clear_resp.status_code == 200, clear_resp.text
    body = clear_resp.json()
    assert body["deleted_runs"] == 1
    assert body["cleared_count"] == 1
    # Hardening: a pre-wipe backup must have been written before deletion.
    backup_path = Path(body["backup_path"])
    assert backup_path.is_file()
    assert backup_path.stat().st_size > 0

    owner_after = client.get("/runs", headers=_headers("user-a"))
    foreign_after = client.get("/runs", headers=_headers("user-b"))
    assert owner_after.status_code == 200, owner_after.text
    assert foreign_after.status_code == 200, foreign_after.text
    assert owner_after.json() == []
    assert {item["id"] for item in foreign_after.json()} == {run_b.json()["run_id"]}


def test_foreign_webhook_secret_rotate_returns_404(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("shared-webhook", title="Shared Webhook", trigger_type="webhook"),
    )
    assert created.status_code == 200, created.text

    response = client.post(
        "/workers/shared-webhook/webhook-secret/rotate",
        headers=_headers("user-b"),
    )

    assert response.status_code == 404, response.text


def test_foreign_custom_worker_restore_returns_404(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("restore-probe", title="Restore Probe"),
    )
    assert created.status_code == 200, created.text

    worker_yml_path = tmp_path / "workers" / "restore-probe" / "worker.yml"
    worker_yml_path.write_text(worker_yml_path.read_text() + "\narchived: true\narchive_reason: test\n")

    foreign = client.post("/workers/restore-probe/restore", headers=_headers("user-b"))
    owner = client.post("/workers/restore-probe/restore", headers=_headers("user-a"))

    assert foreign.status_code == 404, foreign.text
    assert owner.status_code == 200, owner.text
    assert "archived: true" not in worker_yml_path.read_text()


def test_protected_stock_worker_restore_is_blocked(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief",))
    client = TestClient(main.app)

    response = client.post("/workers/research_brief/restore", headers=_headers("user-a"))

    assert response.status_code == 403, response.text


def test_sample_input_hidden_for_foreign_custom_worker(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("sample-probe", title="Sample Probe"),
    )
    assert created.status_code == 200, created.text

    sample_path = tmp_path / "docs" / "workers" / "inputs"
    sample_path.mkdir(parents=True)
    (sample_path / "sample-probe.json").write_text('{"topic":"launch"}')

    owner = client.get("/workers/sample-probe/sample-input", headers=_headers("user-a"))
    foreign = client.get("/workers/sample-probe/sample-input", headers=_headers("user-b"))

    assert owner.status_code == 200, owner.text
    assert owner.json() == {"topic": "launch"}
    assert foreign.status_code == 404, foreign.text


def test_stock_worker_detail_exposes_source_without_secret_values(monkeypatch, tmp_path):
    """Public stock/example workers ship their source ON PURPOSE.

    Design (R3, main.py `_worker_source_visible_to_api` + PUBLIC_STOCK_WORKER_IDS):
    stock workers like research_brief are example code meant to be read and
    forked, so the Source tab MUST show worker.yml / run.py / SKILL.md. The
    earlier expectation that stock detail hides all source was superseded by
    that fix on the same day.

    The security invariant is narrower and still enforced here: no secret
    VALUES, no host paths, and no internal-only handles ever leak. Stock
    bundles are git-tracked public code with no embedded secrets; secret NAMES
    (not values) are all that auth-gated detail exposes.
    """
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief",))
    client = TestClient(main.app)

    detail = client.get("/workers/research_brief", headers=_headers("user-a"))

    assert detail.status_code == 200, detail.text
    body = detail.json()

    # Internal-only / never-exposed handles stay absent regardless of source.
    assert not body.get("new_webhook_secret")
    assert "bundle_url" not in body
    assert "source" not in body
    assert "env" not in body["config"]
    assert "webhook_secret" not in body["config"]

    # Host path must never leak (relativised to the bundle basename / None).
    runtime = body["config"].get("runtime") or {}
    bundle_path = runtime.get("bundle_path")
    assert bundle_path in (None, "research_brief"), bundle_path

    # Source IS exposed by design so the Source tab can teach + fork.
    assert body["manifest_yaml"], "stock worker.yml must be visible for learning/forking"
    assert body["run_py"], "stock run.py must be visible for learning/forking"
    assert body["run_py_content"] == body["run_py"]
    assert isinstance(body["files"], list) and body["files"], "stock bundle files must be listed"

    # And the exposed source must carry no secret-shaped values.
    blob = "\n".join(
        str(part)
        for part in (body["manifest_yaml"], body["run_py"], body.get("skill_md_content") or "")
    )
    assert "sk-" not in blob
    assert "round8-secret" not in blob


def test_internal_shipped_workers_are_hidden_from_public_api(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief", "slack-listener"))
    client = TestClient(main.app)

    listed = client.get("/workers", headers=_headers("user-a"))
    hidden_detail = client.get("/workers/slack-listener", headers=_headers("user-a"))

    assert listed.status_code == 200, listed.text
    assert hidden_detail.status_code == 404, hidden_detail.text
    worker_ids = {item["id"] for item in listed.json()}
    assert "research_brief" in worker_ids
    assert "slack-listener" not in worker_ids


def test_db_persisted_hidden_workers_excluded_from_list(monkeypatch, tmp_path):
    """Regression: workers in DB that _worker_hidden_from_api() hides must not leak
    into GET /workers even when they were persisted to the DB via startup reload.

    The bug: _list_visible_workers used to load DB workers without applying
    _worker_hidden_from_api, so slack-listener appeared in the list but 404'd
    on detail — a clickable ghost. Fix: apply the same filter to the DB path.
    """
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief", "slack-listener"))
    client = TestClient(main.app)

    # Simulate what the startup lifespan does: persist all discovered workers to DB.
    # This is the path that caused the bug — DB workers bypassed the hidden filter.
    main._reload_workers_for_user("user-a")

    listed = client.get("/workers", headers=_headers("user-a"))
    hidden_detail = client.get("/workers/slack-listener", headers=_headers("user-a"))

    assert listed.status_code == 200, listed.text
    assert hidden_detail.status_code == 404, hidden_detail.text

    worker_ids = {item["id"] for item in listed.json()}
    assert "research_brief" in worker_ids, "public stock worker must remain visible"
    assert "slack-listener" not in worker_ids, "DB-persisted hidden worker must not appear in list"


def test_owner_audit_prefixed_custom_worker_remains_visible(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("audit-visible-probe", title="Audit Visible Probe"),
    )
    listed = client.get("/workers", headers=_headers("user-a"))
    detail = client.get("/workers/audit-visible-probe", headers=_headers("user-a"))
    foreign_detail = client.get("/workers/audit-visible-probe", headers=_headers("user-b"))

    assert created.status_code == 200, created.text
    assert listed.status_code == 200, listed.text
    assert detail.status_code == 200, detail.text
    assert foreign_detail.status_code == 404, foreign_detail.text
    worker_ids = {item["id"] for item in listed.json()}
    assert "audit-visible-probe" in worker_ids


def test_hidden_internal_worker_runs_stay_inaccessible(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief", "slack-listener"))
    client = TestClient(main.app)
    repos = main.get_repositories()
    main._reload_workers_for_user("user-a")

    visible_run_id = main.create_run(
        "research_brief",
        {},
        trigger_source="manual",
        user_id="user-a",
        repos=repos,
    )
    hidden_run_id = main.create_run(
        "slack-listener",
        {},
        trigger_source="manual",
        user_id="user-a",
        repos=repos,
    )
    main.update_run_status(
        hidden_run_id,
        main.RunStatus.FAILED.value,
        error="Missing secrets: OPENAI_API_KEY",
        user_id="user-a",
        repos=repos,
    )
    repos.runs.add_log(
        user_id="user-a",
        run_id=hidden_run_id,
        level="info",
        message="Missing secrets: OPENAI_API_KEY",
        timestamp=main.now_iso(),
    )

    listed = client.get("/runs", headers=_headers("user-a"))

    assert listed.status_code == 200, listed.text
    run_ids = {item["id"] for item in listed.json()}
    assert visible_run_id in run_ids
    assert hidden_run_id not in run_ids

    checks = {
        "detail": client.get(f"/runs/{hidden_run_id}", headers=_headers("user-a")),
        "stream": client.get(f"/runs/{hidden_run_id}/stream", headers=_headers("user-a")),
        "events": client.get(f"/runs/{hidden_run_id}/events", headers=_headers("user-a")),
        "logs": client.get(f"/runs/{hidden_run_id}/logs", headers=_headers("user-a")),
    }
    for name, response in checks.items():
        assert response.status_code == 404, f"{name}: {response.status_code} {response.text}"


def test_runs_list_pages_visible_rows_when_newer_hidden_runs_exist(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief", "slack-listener"))
    client = TestClient(main.app)
    repos = main.get_repositories()
    main._reload_workers_for_user("user-a")

    visible_run_id = main.create_run(
        "research_brief",
        {},
        trigger_source="manual",
        user_id="user-a",
        repos=repos,
    )
    hidden_run_ids = [
        main.create_run(
            "slack-listener",
            {},
            trigger_source="manual",
            user_id="user-a",
            repos=repos,
        )
        for _ in range(55)
    ]

    listed = client.get("/runs?limit=10", headers=_headers("user-a"))

    assert listed.status_code == 200, listed.text
    run_ids = {item["id"] for item in listed.json()}
    assert visible_run_id in run_ids
    assert not run_ids.intersection(hidden_run_ids)
    assert listed.headers["X-Total-Count"] == "1"


def test_public_run_redacts_secret_names_across_read_surfaces(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief",))
    client = TestClient(main.app)
    repos = main.get_repositories()
    main._reload_workers_for_user("user-a")

    run_id = main.create_run(
        "research_brief",
        {},
        trigger_source="manual",
        user_id="user-a",
        repos=repos,
    )
    leaked_error = "Missing secrets: OPENAI_API_KEY, ANTHROPIC_API_KEY"
    repos.runs.add_log(
        user_id="user-a",
        run_id=run_id,
        level="info",
        message=leaked_error,
        timestamp=main.now_iso(),
    )
    main.update_run_status(
        run_id,
        main.RunStatus.FAILED.value,
        error=leaked_error,
        user_id="user-a",
        repos=repos,
    )

    list_response = client.get("/runs", headers=_headers("user-a"))
    detail_response = client.get(f"/runs/{run_id}", headers=_headers("user-a"))
    logs_response = client.get(f"/runs/{run_id}/logs", headers=_headers("user-a"))
    stream_response = client.get(f"/runs/{run_id}/stream", headers=_headers("user-a"))
    events_response = client.get(f"/runs/{run_id}/events", headers=_headers("user-a"))

    assert list_response.status_code == 200, list_response.text
    assert detail_response.status_code == 200, detail_response.text
    assert logs_response.status_code == 200, logs_response.text
    assert stream_response.status_code == 200, stream_response.text
    assert events_response.status_code == 200, events_response.text

    summaries = {item["id"]: item for item in list_response.json()}
    assert summaries[run_id]["error"] == "Missing required secrets"
    assert detail_response.json()["error"] == "Missing required secrets"
    assert detail_response.json()["logs"][0]["message"] == "Missing required secrets"
    assert logs_response.json()[0]["message"] == "Missing required secrets"
    assert "Missing required secrets" in stream_response.text
    assert "Missing required secrets" in events_response.text
    assert "OPENAI_API_KEY" not in stream_response.text
    assert "OPENAI_API_KEY" not in events_response.text
    assert "OPENAI_API_KEY" not in detail_response.text


def test_public_run_redacts_env_style_secret_errors_across_read_surfaces(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("research_brief",))
    client = TestClient(main.app)
    repos = main.get_repositories()
    main._reload_workers_for_user("user-a")

    run_id = main.create_run(
        "research_brief",
        {},
        trigger_source="manual",
        user_id="user-a",
        repos=repos,
    )
    leaked_error = "COMPOSIO_API_KEY not set"
    repos.runs.add_log(
        user_id="user-a",
        run_id=run_id,
        level="error",
        message=leaked_error,
        timestamp=main.now_iso(),
    )
    main.update_run_status(
        run_id,
        main.RunStatus.FAILED.value,
        error=leaked_error,
        user_id="user-a",
        repos=repos,
    )

    list_response = client.get("/runs", headers=_headers("user-a"))
    detail_response = client.get(f"/runs/{run_id}", headers=_headers("user-a"))
    logs_response = client.get(f"/runs/{run_id}/logs", headers=_headers("user-a"))
    stream_response = client.get(f"/runs/{run_id}/stream", headers=_headers("user-a"))
    events_response = client.get(f"/runs/{run_id}/events", headers=_headers("user-a"))

    assert list_response.status_code == 200, list_response.text
    assert detail_response.status_code == 200, detail_response.text
    assert logs_response.status_code == 200, logs_response.text
    assert stream_response.status_code == 200, stream_response.text
    assert events_response.status_code == 200, events_response.text

    expected = "Required platform secret is not configured"
    summaries = {item["id"]: item for item in list_response.json()}
    assert summaries[run_id]["error"] == expected
    assert detail_response.json()["error"] == expected
    assert detail_response.json()["logs"][0]["message"] == expected
    assert logs_response.json()[0]["message"] == expected
    assert expected in stream_response.text
    assert expected in events_response.text
    assert "COMPOSIO_API_KEY" not in stream_response.text
    assert "COMPOSIO_API_KEY" not in events_response.text
    assert "COMPOSIO_API_KEY" not in detail_response.text
    assert "COMPOSIO_API_KEY" not in logs_response.text


def test_worker_write_routes_reject_owner_mass_assignment(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    create_with_owner = client.post(
        "/workers",
        headers=_headers("user-a"),
        json={**_worker_payload("mass-owner-create", title="Mass Owner Create"), "owner_id": "user-b"},
    )

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("mass-owner-update", title="Mass Owner Update"),
    )
    assert created.status_code == 200, created.text

    patch_with_owner = client.patch(
        "/workers/mass-owner-update",
        headers=_headers("user-a"),
        json={"trigger_type": "manual", "owner_id": "user-b"},
    )
    put_with_owner = client.put(
        "/workers/mass-owner-update",
        headers=_headers("user-a"),
        json={**_worker_payload("mass-owner-update", title="Mass Owner Update"), "owner_id": "user-b"},
    )

    with main.get_db() as conn:
        owner_row = conn.execute(
            "SELECT owner_id FROM workers WHERE id = ?",
            ("mass-owner-update",),
        ).fetchone()
        missing_row = conn.execute(
            "SELECT owner_id FROM workers WHERE id = ?",
            ("mass-owner-create",),
        ).fetchone()

    assert create_with_owner.status_code == 422, create_with_owner.text
    assert patch_with_owner.status_code == 422, patch_with_owner.text
    assert put_with_owner.status_code == 422, put_with_owner.text
    assert owner_row is not None
    assert owner_row["owner_id"] == "user-a"
    assert missing_row is None
    assert client.get("/workers/mass-owner-update", headers=_headers("user-b")).status_code == 404


def test_run_replay_cross_worker_same_user_returns_404(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    worker_a = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("replay-a", title="Replay A"),
    )
    worker_b = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("replay-b", title="Replay B"),
    )
    assert worker_a.status_code == 200, worker_a.text
    assert worker_b.status_code == 200, worker_b.text

    source_run = client.post(
        "/workers/replay-a/runs",
        headers=_headers("user-a"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    assert source_run.status_code == 200, source_run.text
    run_id = source_run.json()["run_id"]

    wrong_worker = client.post(
        f"/workers/replay-b/runs/{run_id}/replay",
        headers=_headers("user-a"),
    )
    right_worker = client.post(
        f"/workers/replay-a/runs/{run_id}/replay",
        headers=_headers("user-a"),
    )

    assert wrong_worker.status_code == 404, wrong_worker.text
    assert right_worker.status_code == 200, right_worker.text
    assert right_worker.json()["run_id"] != run_id


def test_context_symlink_traversal_is_blocked(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post("/contexts/audit-ctx", headers=_headers("user-a"), json={"writeable": True})
    assert created.status_code == 200, created.text

    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    with main.use_context_scope(main.context_scope_for_user("user-a")):
        os.symlink(outside, main.context_dir("audit-ctx") / "escape.txt")

    get_response = client.get("/contexts/audit-ctx/files/escape.txt", headers=_headers("user-a"))
    put_response = client.put(
        "/contexts/audit-ctx/files/escape.txt",
        headers=_headers("user-a"),
        content=b"hijack",
    )
    delete_response = client.delete("/contexts/audit-ctx/files/escape.txt", headers=_headers("user-a"))

    assert get_response.status_code == 400, get_response.text
    assert put_response.status_code == 400, put_response.text
    assert delete_response.status_code == 400, delete_response.text
    assert outside.read_text() == "outside"


def test_chat_rejects_oversized_message(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    response = client.post(
        "/chat",
        headers=_headers("user-a"),
        json={"message": "x" * 20001},
    )

    assert response.status_code == 413, response.text
    assert "character limit" in response.text


def test_reload_preserves_existing_owner_on_conflict(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload("shared-probe", title="Shared Probe"),
    )
    assert created.status_code == 200, created.text

    with main.get_db() as conn:
        before = conn.execute(
            "SELECT owner_id FROM workers WHERE id = ?",
            ("shared-probe",),
        ).fetchone()
    assert before is not None
    assert before["owner_id"] == "user-a"

    reload_resp = client.post("/workers/reload", headers=_headers("user-b"))
    assert reload_resp.status_code == 200, reload_resp.text

    with main.get_db() as conn:
        after = conn.execute(
            "SELECT owner_id FROM workers WHERE id = ?",
            ("shared-probe",),
        ).fetchone()
    assert after is not None
    assert after["owner_id"] == "user-a"


def test_list_secrets_hides_foreign_worker_requirements_but_keeps_stock(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("opendraft",))
    client = TestClient(main.app)

    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json=_worker_payload(
            "shared-secret-worker",
            title="Shared Secret Worker",
            secrets=("TEAM_ONLY_SECRET",),
        ),
    )
    assert created.status_code == 200, created.text

    owner_list = client.get("/secrets", headers=_headers("user-a"))
    foreign_list = client.get("/secrets", headers=_headers("user-b"))

    assert owner_list.status_code == 200, owner_list.text
    assert foreign_list.status_code == 200, foreign_list.text

    owner_names = {item["name"] for item in owner_list.json()}
    foreign_names = {item["name"] for item in foreign_list.json()}

    assert "GOOGLE_API_KEY" in owner_names
    assert "GOOGLE_API_KEY" in foreign_names
    assert "TEAM_ONLY_SECRET" in owner_names
    assert "TEAM_ONLY_SECRET" not in foreign_names


def test_upload_download_token_is_user_bound(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    upload = client.post(
        "/uploads",
        headers=_headers("user-a"),
        files={"file": ("audit.txt", b"upload body", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    url = upload.json()["url"]

    owner_download = client.get(url, headers=_headers("user-a"))
    foreign_download = client.get(url, headers=_headers("user-b"))

    assert owner_download.status_code == 200, owner_download.text
    assert owner_download.content == b"upload body"
    assert foreign_download.status_code == 404, foreign_download.text


def test_system_metrics_and_overview_are_user_scoped(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    worker_a = "metrics-a"
    worker_b = "metrics-b"
    created_a = client.post("/workers", headers=_headers("user-a"), json=_worker_payload(worker_a, title="Metrics A"))
    created_b = client.post("/workers", headers=_headers("user-b"), json=_worker_payload(worker_b, title="Metrics B"))
    assert created_a.status_code == 200, created_a.text
    assert created_b.status_code == 200, created_b.text

    secret_a = client.post("/secrets/AUDIT_SECRET_A", headers=_headers("user-a"), json={"value": "value-a"})
    secret_b = client.post("/secrets/AUDIT_SECRET_B", headers=_headers("user-b"), json={"value": "value-b"})
    assert secret_a.status_code == 200, secret_a.text
    assert secret_b.status_code == 200, secret_b.text

    _insert_connection(main, user_id="user-a", app_name="gmail")
    _insert_connection(main, user_id="user-b", app_name="slack")

    run_a = client.post(
        f"/workers/{worker_a}/runs",
        headers=_headers("user-a"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    run_b = client.post(
        f"/workers/{worker_b}/runs",
        headers=_headers("user-b"),
        json={"inputs": {}, "trigger_source": "manual"},
    )
    assert run_a.status_code == 200, run_a.text
    assert run_b.status_code == 200, run_b.text

    metrics_a = client.get("/system/metrics", headers=_headers("user-a"))
    metrics_b = client.get("/system/metrics", headers=_headers("user-b"))
    overview_a = client.get("/system/overview", headers=_headers("user-a"))
    overview_b = client.get("/system/overview", headers=_headers("user-b"))

    assert metrics_a.status_code == 200, metrics_a.text
    assert metrics_b.status_code == 200, metrics_b.text
    assert overview_a.status_code == 200, overview_a.text
    assert overview_b.status_code == 200, overview_b.text

    metrics_a_body = metrics_a.json()
    metrics_b_body = metrics_b.json()
    overview_a_body = overview_a.json()
    overview_b_body = overview_b.json()
    recent_a = {item["worker_id"] for item in overview_a_body["recent_runs"]}
    recent_b = {item["worker_id"] for item in overview_b_body["recent_runs"]}

    assert metrics_a_body["runs_total"] == 1
    assert metrics_b_body["runs_total"] == 1
    assert metrics_a_body["connections_count"] == 1
    assert metrics_b_body["connections_count"] == 1
    assert metrics_a_body["secrets_count"] == 1
    assert metrics_b_body["secrets_count"] == 1
    assert overview_a_body["stats"]["connections_total"] == 1
    assert overview_b_body["stats"]["connections_total"] == 1
    assert recent_a == {worker_a}
    assert recent_b == {worker_b}


def test_shipped_worker_directories_match_protected_set(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    shipped_worker_ids = _tracked_worker_ids()

    assert shipped_worker_ids == set(main.PROTECTED_STOCK_WORKER_IDS)


def test_protected_stock_worker_direct_mutations_block_but_put_and_files_fork(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, stock_workers=("linkedin-post-engagements",))
    client = TestClient(main.app)

    payload = _worker_payload("linkedin-post-engagements", title="Probe Replacement")
    files_payload = {
        "files": [
            {"path": "worker.yml", "content": payload["worker_yml"]},
            {"path": "run.py", "content": payload["run_py"]},
        ]
    }

    blocked_checks = {
        "delete": client.delete("/workers/linkedin-post-engagements", headers=_headers("user-a")),
        "patch": client.patch(
            "/workers/linkedin-post-engagements",
            headers=_headers("user-a"),
            json={"trigger_type": "manual"},
        ),
    }
    put_forked = client.put(
        "/workers/linkedin-post-engagements",
        headers=_headers("user-a"),
        json=payload,
    )
    forked = client.put(
        "/workers/linkedin-post-engagements/files",
        headers=_headers("user-a"),
        json=files_payload,
    )

    for name, response in blocked_checks.items():
        assert response.status_code == 403, f"{name}: {response.status_code} {response.text}"
    assert put_forked.status_code == 200, put_forked.text
    put_body = put_forked.json()
    assert put_body["id"] == "linkedin-post-engagements-copy"
    assert put_body["cloned_from"] == "linkedin-post-engagements"
    assert put_body["is_example"] is False
    assert forked.status_code == 200, forked.text
    body = forked.json()
    assert body["id"] == "linkedin-post-engagements-copy-2"
    assert body["cloned_from"] == "linkedin-post-engagements"
    assert body["is_example"] is False
