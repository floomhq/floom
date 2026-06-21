"""#1807: create a git-backed workspace issue from actionable run feedback.

Run feedback stays a lightweight quality signal; this endpoint is the explicit,
opt-in bridge that turns one feedback item into a tracked workspace issue (#1781)
bound to the run. Covered here with no network:
  - POST /runs/{run_id}/feedback/issue creates a run-bound issue (201)
  - the issue is discoverable via GET /workspace/issues?asset_type=run&asset_id=
  - the body carries enough context (feedback text, rating, run id, worker id)
  - a stable feedback_id dedups: a second submit returns the same issue (200)
  - stored run feedback can be promoted to exactly one workspace issue
  - feedback for a run the caller cannot see returns 404
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _purge_api_modules() -> None:
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service", "git_ops") or name.startswith(
            ("routers", "services", "core", "db", "auth", "contexts")
        ):
            sys.modules.pop(name, None)


def _init_git(workspace: Path) -> None:
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=workspace, check=True)


def _install_app(monkeypatch, tmp_path: Path, *, workers_dir: Path, workspace_dir: Path):
    if "fcntl" not in sys.modules:
        _fcntl = types.ModuleType("fcntl")
        for attr in ("LOCK_EX", "LOCK_SH", "LOCK_UN", "LOCK_NB"):
            setattr(_fcntl, attr, 0)
        _fcntl.flock = lambda fd, op: None
        sys.modules["fcntl"] = _fcntl

    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    _purge_api_modules()
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": "dev"}, raise_server_exceptions=False)
    return client, db


def _make_workspace(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    workers_dir = workspace / "workers"
    workers_dir.mkdir(parents=True)
    _init_git(workspace)
    return workspace, workers_dir


def _seed_run(db, *, run_id: str, worker_id: str = "gmail-inbox-manager") -> None:
    repos = db.get_repositories()
    manifest = {
        "id": worker_id,
        "name": "Gmail Inbox Manager",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }
    repos.workers.create(
        user_id="local-user",
        worker_id=worker_id,
        name="Gmail Inbox Manager",
        manifest_json=manifest,
        bundle_path=f"workers/{worker_id}",
    )
    repos.runs.create(
        user_id="local-user",
        run_id=run_id,
        worker_id=worker_id,
        status="completed",
        trigger_source="manual",
        runner="e2b",
    )


def test_create_issue_from_run_feedback(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_abc")

    resp = client.post(
        "/runs/run_abc/feedback/issue",
        json={"feedback_text": "It summarised the wrong thread.", "rating": "down"},
    )
    assert resp.status_code == 201, resp.text
    payload = resp.json()
    assert payload["created"] is True
    assert payload["issue_id"] == "ISSUE-0001"

    issue = payload["issue"]
    assert issue["asset_type"] == "run"
    assert issue["asset_id"] == "run_abc"
    assert issue["source"] == "run_feedback"
    assert "run-feedback" in issue["labels"]

    # Body carries enough context for a human or fixer worker.
    body = issue["body"]
    assert "It summarised the wrong thread." in body
    assert "run_abc" in body
    assert "gmail-inbox-manager" in body
    assert "down" in body

    # The committed issue file exists on disk under the git workspace.
    assert (workspace / ".floom" / "issues" / "ISSUE-0001.md").is_file()


def test_created_issue_is_visible_via_workspace_issues(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_xyz")

    created = client.post(
        "/runs/run_xyz/feedback/issue",
        json={"feedback_text": "Flaky output, needs a fix."},
    ).json()

    listed = client.get(
        "/workspace/issues", params={"asset_type": "run", "asset_id": "run_xyz"}
    )
    assert listed.status_code == 200, listed.text
    ids = [i["id"] for i in listed.json()["issues"]]
    assert created["issue_id"] in ids


def test_run_feedback_can_be_promoted_to_issue(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_feedback")

    feedback = client.post(
        "/runs/run_feedback/feedback",
        json={"content": "Wrong inbox thread was summarised.", "rating": "down"},
    )
    assert feedback.status_code == 201, feedback.text
    feedback_id = feedback.json()["id"]

    listed_feedback = client.get("/runs/run_feedback/feedback")
    assert listed_feedback.status_code == 200, listed_feedback.text
    assert listed_feedback.json()[0]["content"] == "Wrong inbox thread was summarised."
    assert listed_feedback.json()[0]["issue_id"] is None

    promoted = client.post(
        "/runs/run_feedback/feedback/issue",
        json={"feedback_id": feedback_id},
    )
    assert promoted.status_code == 201, promoted.text
    payload = promoted.json()
    assert payload["created"] is True
    assert payload["feedback"]["id"] == feedback_id
    assert payload["feedback"]["issue_id"] == payload["issue_id"]
    assert payload["issue"]["asset_type"] == "run"
    assert payload["issue"]["asset_id"] == "run_feedback"
    assert "Wrong inbox thread was summarised." in payload["issue"]["body"]
    assert "down" in payload["issue"]["body"]

    promoted_again = client.post(
        "/runs/run_feedback/feedback/issue",
        json={"feedback_id": feedback_id},
    )
    assert promoted_again.status_code == 200, promoted_again.text
    assert promoted_again.json()["created"] is False
    assert promoted_again.json()["issue_id"] == payload["issue_id"]


def test_normal_feedback_does_not_create_issue(monkeypatch, tmp_path):
    # The bridge is opt-in: no issue exists until the endpoint is called.
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_quiet")

    feedback = client.post("/runs/run_quiet/feedback", json={"content": "Needs better summary."})
    assert feedback.status_code == 201, feedback.text

    listed = client.get(
        "/workspace/issues", params={"asset_type": "run", "asset_id": "run_quiet"}
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["issues"] == []


def test_stable_feedback_id_dedups(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_dd")

    first = client.post(
        "/runs/run_dd/feedback/issue",
        json={"feedback_text": "bad", "feedback_id": "fb-1"},
    )
    assert first.status_code == 201, first.text
    assert first.json()["created"] is True

    second = client.post(
        "/runs/run_dd/feedback/issue",
        json={"feedback_text": "bad again", "feedback_id": "fb-1"},
    )
    assert second.status_code == 200, second.text
    assert second.json()["created"] is False
    assert second.json()["issue_id"] == first.json()["issue_id"]

    # Only one issue exists for this run.
    listed = client.get(
        "/workspace/issues", params={"asset_type": "run", "asset_id": "run_dd"}
    )
    assert len(listed.json()["issues"]) == 1


def test_custom_title_is_used(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_title")

    resp = client.post(
        "/runs/run_title/feedback/issue",
        json={"feedback_text": "x", "title": "Inbox worker mislabels threads"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["issue"]["title"] == "Inbox worker mislabels threads"


def test_feedback_issue_for_invisible_run_is_404(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, _db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)

    resp = client.post(
        "/runs/does-not-exist/feedback/issue",
        json={"feedback_text": "anything"},
    )
    assert resp.status_code == 404, resp.text


def test_empty_feedback_text_is_rejected(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, db = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)
    _seed_run(db, run_id="run_empty")

    resp = client.post("/runs/run_empty/feedback/issue", json={"feedback_text": ""})
    assert resp.status_code == 422, resp.text
